import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CampaignStateMachine } from '../campaigns/state-machine.js';
import type { Transaction } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PAYMENT_PROVIDER, type BankTransferInstructions, type PaymentProvider } from './provider.js';

const naira = (kobo: number) => kobo / 100;
const fmt = (kobo: number) => `₦${naira(kobo).toLocaleString('en-NG')}`;
const ref = (prefix: string) => `AFC${prefix}${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`;

@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sm: CampaignStateMachine,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_PROVIDER) readonly provider: PaymentProvider,
  ) {}

  // ---------- Funding ----------

  /** Starts (or returns the live) funding attempt. Only one non-failed funding per campaign (DB index). */
  async fund(brandId: string, campaignId: string, method: 'bank_transfer' | 'card') {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c || c.brandId !== brandId) throw new NotFoundException('Campaign not found');
    if (c.status !== 'awaiting_funding') throw new ConflictException(`Campaign is ${c.status}`);

    const live = await this.prisma.transaction.findFirst({ where: { campaignId, kind: 'FUNDING', status: { in: ['pending', 'processing'] } } });
    if (live) {
      const expired = live.method === 'bank_transfer' && new Date((live.instructions as BankTransferInstructions).expiresAt) < new Date();
      if (live.method === method && !expired) return this.view(live);
      // Switching method or an expired account: make sure nothing arrived, then retire the old attempt.
      await this.reconcile(live.id);
      const fresh = await this.prisma.transaction.findUniqueOrThrow({ where: { id: live.id } });
      if (fresh.status !== 'failed') {
        if (fresh.status === 'successful') return this.view(fresh);
        await this.fail(fresh, expired ? 'Virtual account expired' : 'Replaced by a new payment method');
      }
    }

    const brand = await this.prisma.user.findUniqueOrThrow({ where: { id: brandId }, include: { brandProfile: true } });
    const reference = ref('F');
    const attempts = await this.prisma.transaction.count({ where: { campaignId, kind: 'FUNDING' } });
    const amountKobo = c.amountKobo + c.feeKobo;
    const [firstName, ...rest] = (brand.brandProfile?.contactName ?? brand.brandProfile?.businessName ?? 'AfiCre8 Brand').split(' ');
    const instructions = await this.provider.createFunding({
      reference,
      amountNgn: naira(amountKobo),
      method,
      customer: { email: brand.email, firstName, lastName: rest.join(' ') || 'Brand', phone: brand.phone ?? undefined },
      description: `AfiCre8: ${c.title}`,
    });
    try {
      const tx = await this.prisma.transaction.create({
        data: {
          campaignId,
          kind: 'FUNDING',
          amountKobo: c.amountKobo,
          feeKobo: c.feeKobo,
          payazaReference: reference,
          idempotencyKey: `funding:${campaignId}:${attempts + 1}`,
          method,
          instructions,
        },
      });
      await this.audit(brandId, tx, 'payment.funding_started', null, 'pending');
      return this.view(tx);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A funding attempt is already in progress');
      }
      throw e;
    }
  }

  /** Sandbox helper: pretend the brand made the bank transfer. Confirmation still goes through reconcile(). */
  async simulateTransfer(brandId: string, campaignId: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { campaignId, kind: 'FUNDING', status: 'pending', method: 'bank_transfer', campaign: { brandId } },
    });
    if (!tx) throw new NotFoundException('No pending bank transfer for this campaign');
    if (!this.provider.simulateBankTransfer) throw new BadRequestException('Simulation not supported');
    const r = await this.provider.simulateBankTransfer(tx.payazaReference, tx.instructions as BankTransferInstructions);
    if (r.ok) await this.reconcile(tx.id);
    return { ...r, transaction: this.view(await this.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })) };
  }

  // ---------- Payout ----------

  /** Releases the agreed amount to the creator. Only from `approved` (or retry from `payout_failed`). */
  async payout(campaignId: string, actorId?: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new NotFoundException('Campaign not found');
    if (!['approved', 'payout_failed'].includes(c.status)) throw new ConflictException(`Campaign is ${c.status}`);
    const dest = await this.prisma.payoutDestination.findUnique({ where: { userId: c.creatorId } });
    if (!dest) throw new ConflictException('Creator has no payout destination yet');

    const reference = ref('P');
    const attempts = await this.prisma.transaction.count({ where: { campaignId, kind: 'PAYOUT' } });
    let tx: Transaction;
    try {
      tx = await this.prisma.$transaction(async (db) => {
        const t = await db.transaction.create({
          data: {
            campaignId,
            kind: 'PAYOUT',
            amountKobo: c.amountKobo,
            payazaReference: reference,
            idempotencyKey: `payout:${campaignId}:${attempts + 1}`,
            method: 'bank_transfer',
            instructions: { bankCode: dest.bankCode, bankName: dest.bankName, accountNumber: dest.accountNumber, accountName: dest.accountName },
          },
        });
        await this.sm.transition(campaignId, 'payout_processing', { actorId, reference, tx: db });
        return t;
      });
    } catch (e) {
      // Partial unique index: a live payout already exists, so this is a duplicate release request.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Payout already in progress');
      throw e;
    }
    this.sm.announce({ ...c, status: 'payout_processing', from: c.status });
    await this.audit(actorId, tx, 'payment.payout_started', null, 'pending');

    try {
      const r = await this.provider.payout({
        reference,
        amountNgn: naira(c.amountKobo),
        bankCode: dest.bankCode,
        accountNumber: dest.accountNumber,
        accountName: dest.accountName,
        narration: `AfiCre8 ${c.title}`,
      });
      if (r.status === 'failed') {
        await this.settle(tx.id, 'failed', r.providerStatus, r.raw);
      } else {
        await this.prisma.transaction.update({
          where: { id: tx.id },
          data: { status: 'processing', providerStatus: r.providerStatus, providerResponse: r.raw as Prisma.InputJsonValue },
        });
        await this.notifications.notify(c.creatorId, { kind: 'payout', title: 'Payout initiated', body: `${fmt(c.amountKobo)} is on its way to ${dest.bankName}.`, linkTo: `/transaction/${tx.id}` });
      }
    } catch (e) {
      // Provider rejected the request outright: nothing left Payaza, so the payout is failed (retryable).
      this.log.error(`Payout ${reference} failed to start: ${(e as Error).message}`);
      await this.settle(tx.id, 'failed', 'REQUEST_FAILED', { error: (e as Error).message });
    }
    return this.view(await this.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } }));
  }

  // ---------- Confirmation (webhook, reconcile job, manual check all end here) ----------

  /** Re-queries Payaza — the only source of truth — and applies the result. Safe to call any number of times. */
  async reconcile(transactionId: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx || tx.status === 'successful' || tx.status === 'failed') return tx;
    const r = tx.kind === 'FUNDING' ? await this.provider.queryFunding(tx.payazaReference, tx.method ?? 'bank_transfer') : await this.provider.queryPayout(tx.payazaReference);
    if (r.status === 'pending') {
      if (r.providerStatus && r.providerStatus !== tx.providerStatus) {
        await this.prisma.transaction.update({ where: { id: tx.id }, data: { providerStatus: r.providerStatus } });
      }
      return tx;
    }
    await this.settle(tx.id, r.status, r.providerStatus, r.raw);
    return this.prisma.transaction.findUnique({ where: { id: tx.id } });
  }

  async reconcileByReference(reference: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { payazaReference: reference } });
    return tx ? this.reconcile(tx.id) : null;
  }

  /** Every pending money movement older than `olderThanMs`. Run by the worker on a schedule. */
  async reconcileAll(olderThanMs = 20_000) {
    const pending = await this.prisma.transaction.findMany({
      where: { status: { in: ['pending', 'processing'] }, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
      take: 50,
    });
    for (const t of pending) await this.reconcile(t.id).catch((e) => this.log.warn(`reconcile ${t.payazaReference}: ${e.message}`));
    return pending.length;
  }

  /** Applies a final provider status exactly once (compare-and-set on the transaction status). */
  private async settle(transactionId: string, status: 'successful' | 'failed', providerStatus?: string, raw?: unknown) {
    const result = await this.prisma.$transaction(async (db) => {
      const tx = await db.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      const claimed = await db.transaction.updateMany({
        where: { id: tx.id, status: { in: ['pending', 'processing'] } },
        data: { status, providerStatus, providerResponse: (raw ?? undefined) as Prisma.InputJsonValue, resolvedAt: new Date() },
      });
      if (claimed.count !== 1) return null; // already settled by a concurrent webhook/reconcile
      await db.auditLog.create({
        data: { action: `payment.${tx.kind.toLowerCase()}_${status}`, entity: 'Transaction', entityId: tx.id, fromState: tx.status, toState: status, reference: tx.payazaReference, meta: { campaignId: tx.campaignId, providerStatus } },
      });
      if (tx.kind === 'FUNDING' && status === 'successful') {
        return { tx, moved: await this.sm.transition(tx.campaignId, 'funded', { reference: tx.payazaReference, tx: db }) };
      }
      if (tx.kind === 'PAYOUT') {
        const moved = await this.sm.transition(tx.campaignId, status === 'successful' ? 'completed' : 'payout_failed', { reference: tx.payazaReference, tx: db });
        if (status === 'successful') await db.creatorProfile.update({ where: { userId: moved.creatorId }, data: { completedCampaigns: { increment: 1 } } });
        return { tx, moved };
      }
      return { tx, moved: null };
    });
    if (!result) return;
    const { tx, moved } = result;
    const c = await this.prisma.campaign.findUniqueOrThrow({ where: { id: tx.campaignId } });
    if (moved) this.sm.announce(moved);

    if (tx.kind === 'FUNDING' && status === 'successful') {
      await this.notifications.notify(c.creatorId, { kind: 'funding', title: 'Campaign funded', body: `${fmt(c.amountKobo)} secured for “${c.title}”. You can start work.`, linkTo: `/campaigns/${c.id}` });
      await this.notifications.notify(c.brandId, { kind: 'funding', title: 'Payment confirmed', body: `Your payment for “${c.title}” was received.`, linkTo: `/campaigns/${c.id}` });
    } else if (tx.kind === 'FUNDING') {
      await this.notifications.notify(c.brandId, { kind: 'funding', title: 'Payment failed', body: `Payment for “${c.title}” did not go through. The campaign is still awaiting funding.`, linkTo: `/campaigns/${c.id}` });
    } else if (status === 'successful') {
      await this.notifications.notify(c.creatorId, { kind: 'payout', title: 'Payment successful', body: `${fmt(c.amountKobo)} paid for “${c.title}”. Ref ${tx.payazaReference}.`, linkTo: `/transaction/${tx.id}` });
      await this.notifications.notify(c.brandId, { kind: 'payout', title: 'Payout completed', body: `“${c.title}” is complete.`, linkTo: `/campaigns/${c.id}` });
    } else {
      await this.notifications.notify(c.creatorId, { kind: 'payout', title: 'Payout failed', body: `We couldn't pay out “${c.title}”. Check your bank details; we'll retry.`, linkTo: `/profile/payment` });
    }
  }

  private async fail(tx: Transaction, reason: string) {
    await this.prisma.transaction.updateMany({ where: { id: tx.id, status: { in: ['pending', 'processing'] } }, data: { status: 'failed', failureReason: reason, resolvedAt: new Date() } });
    await this.audit(undefined, tx, 'payment.funding_retired', tx.status, 'failed', { reason });
  }

  // ---------- Webhooks ----------

  /**
   * Stores every event (deduped by reference+status) and treats it only as a hint to re-query Payaza.
   * A forged or replayed webhook therefore cannot fund or pay anything.
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined, payload: any, replay = false) {
    const reference = String(payload?.transaction_reference ?? payload?.data?.transaction_reference ?? '');
    const status = String(payload?.transaction_status ?? payload?.status ?? '');
    const eventId = `payaza:${reference}:${status}`;
    const signatureOk = this.provider.verifyWebhook(rawBody, signature);

    if (!replay) {
      try {
        await this.prisma.webhookEvent.create({ data: { provider: this.provider.name, eventId, type: status, reference, payload, signatureOk } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { duplicate: true };
        throw e;
      }
    }
    try {
      const tx = reference ? await this.reconcileByReference(reference) : null;
      await this.prisma.webhookEvent.update({ where: { eventId }, data: { processedAt: new Date(), error: tx ? null : 'Unknown reference' } });
      return { duplicate: false, transactionStatus: tx?.status ?? null };
    } catch (e) {
      await this.prisma.webhookEvent.update({ where: { eventId }, data: { error: (e as Error).message } });
      throw e;
    }
  }

  // ---------- Queries ----------

  async forUser(userId: string, role: string) {
    const rows = await this.prisma.transaction.findMany({
      where: role === 'ADMIN' ? {} : { campaign: role === 'BRAND' ? { brandId: userId } : { creatorId: userId } },
      include: { campaign: { select: { id: true, title: true, brandId: true, creatorId: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // Creators only see their payouts plus the fact their campaign was funded, never brand fees.
    return rows.map((t) => ({ ...this.view(t), campaign: t.campaign }));
  }

  async one(userId: string, role: string, id: string) {
    const t = await this.prisma.transaction.findUnique({ where: { id }, include: { campaign: true } });
    if (!t || (role !== 'ADMIN' && t.campaign.brandId !== userId && t.campaign.creatorId !== userId)) throw new NotFoundException('Transaction not found');
    return { ...this.view(t), campaign: { id: t.campaign.id, title: t.campaign.title, status: t.campaign.status } };
  }

  /** Data for the hosted card checkout page (public, keyed by the unguessable payment reference). */
  async checkoutData(reference: string) {
    const t = await this.prisma.transaction.findUnique({ where: { payazaReference: reference }, include: { campaign: true } });
    if (!t || t.kind !== 'FUNDING' || t.method !== 'card') throw new NotFoundException('Payment not found');
    const brand = await this.prisma.user.findUniqueOrThrow({ where: { id: t.campaign.brandId }, include: { brandProfile: true } });
    return { t, brand };
  }

  assertOwnsCampaign(userId: string, campaign: { brandId: string }) {
    if (campaign.brandId !== userId) throw new ForbiddenException();
  }

  view(t: Transaction) {
    const { providerResponse: _raw, idempotencyKey: _key, ...rest } = t;
    return { ...rest, amountNgn: naira(t.amountKobo), feeNgn: naira(t.feeKobo), totalNgn: naira(t.amountKobo + t.feeKobo) };
  }

  private audit(actorId: string | undefined, tx: Transaction, action: string, from: string | null, to: string, meta?: Prisma.InputJsonValue) {
    return this.prisma.auditLog.create({
      data: { actorId, action, entity: 'Transaction', entityId: tx.id, fromState: from, toState: to, reference: tx.payazaReference, meta: meta ?? { campaignId: tx.campaignId } },
    });
  }
}
