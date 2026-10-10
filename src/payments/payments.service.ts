import { ErrorCode, wrongStage } from '../common/errors.js';
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
const PAYOUT_RETRY_EVERY_MS = 30 * 60_000;
const PAYOUT_RETRY_WINDOW_MS = 24 * 60 * 60_000;
const CARD_CHECKOUT_TTL_MS = 24 * 60 * 60_000; // an unpaid Payaza card checkout never completes after this

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
    if (c.status !== 'awaiting_funding') throw wrongStage(c.status);

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
    if (!this.provider.simulateBankTransfer) throw new BadRequestException("Test transfers aren't available right now.");
    const r = await this.provider.simulateBankTransfer(tx.payazaReference, tx.instructions as BankTransferInstructions);
    if (r.ok) await this.reconcile(tx.id);
    return { ...r, transaction: this.view(await this.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })) };
  }

  // ---------- Payout ----------

  /**
   * Releases the agreed amount to the creator. Only from `approved` (or retry from `payout_failed`). `quiet`: an
   * automatic retry; a refusal is not announced again (the first failure already told both sides).
   */
  async payout(campaignId: string, actorId?: string, opts: { quiet?: boolean } = {}) {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new NotFoundException('Campaign not found');
    if (!['approved', 'payout_failed'].includes(c.status)) throw wrongStage(c.status);
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
        await this.settle(tx.id, 'failed', r.providerStatus, r.raw, opts.quiet);
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
      await this.settle(tx.id, 'failed', 'REQUEST_FAILED', { error: (e as Error).message }, opts.quiet);
      // the creator, the brand and the admin console all read this ("Payaza's transfer limit was reached ...")
      await this.prisma.transaction.update({ where: { id: tx.id }, data: { failureReason: payoutFailure((e as Error).message).reason } });
    }
    return this.view(await this.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } }));
  }

  // ---------- Refund (escrow goes back to the brand) ----------

  /**
   * Returns everything the brand paid (work amount + fee) to the brand's saved account. The campaign leaves its
   * current state in the same transaction that records the refund, so a payout and a refund can never both be live.
   * With no account saved the refund is recorded as failed and retried when the brand saves one.
   */
  async refund(campaignId: string, actorId: string | undefined, reason: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new NotFoundException('Campaign not found');
    if (!['funded', 'in_progress', 'disputed', 'refund_failed'].includes(c.status)) throw wrongStage(c.status);
    const dest = await this.prisma.payoutDestination.findUnique({ where: { userId: c.brandId } });

    const reference = ref('R');
    const attempts = await this.prisma.transaction.count({ where: { campaignId, kind: 'REFUND' } });
    let tx: Transaction;
    try {
      tx = await this.prisma.$transaction(async (db) => {
        const t = await db.transaction.create({
          data: {
            campaignId,
            kind: 'REFUND',
            amountKobo: c.amountKobo + c.feeKobo,
            payazaReference: reference,
            idempotencyKey: `refund:${campaignId}:${attempts + 1}`,
            method: 'bank_transfer',
            instructions: dest ? { bankCode: dest.bankCode, bankName: dest.bankName, accountNumber: dest.accountNumber, accountName: dest.accountName } : {},
          },
        });
        await this.sm.transition(campaignId, 'refund_processing', { actorId, reference, tx: db, meta: { reason } });
        return t;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A refund is already in progress');
      throw e;
    }
    this.sm.announce({ ...c, status: 'refund_processing', from: c.status });
    await this.audit(actorId, tx, 'payment.refund_started', null, 'pending', { reason });

    if (!dest) {
      await this.settle(tx.id, 'failed', 'NO_REFUND_ACCOUNT', {});
      return this.view(await this.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } }));
    }
    try {
      const r = await this.provider.payout({ reference, amountNgn: naira(tx.amountKobo), bankCode: dest.bankCode, accountNumber: dest.accountNumber, accountName: dest.accountName, narration: `AfiCre8 refund ${c.title}` });
      if (r.status === 'failed') await this.settle(tx.id, 'failed', r.providerStatus, r.raw);
      else await this.prisma.transaction.update({ where: { id: tx.id }, data: { status: 'processing', providerStatus: r.providerStatus, providerResponse: r.raw as Prisma.InputJsonValue } });
    } catch (e) {
      this.log.error(`Refund ${reference} failed to start: ${(e as Error).message}`);
      await this.settle(tx.id, 'failed', 'REQUEST_FAILED', { error: (e as Error).message });
    }
    return this.view(await this.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } }));
  }

  /**
   * Retries payouts the provider refused for a reason AfiCre8 can't fix by hand right away (a transfer limit, an outage):
   * every 30 minutes, for 24 hours after the first refusal. Rejected bank details are left for the creator (saving
   * them retries). Goes through `payout`, so it can never make a second live payout. Run by the worker.
   * ponytail: fixed 30-minute spacing; move to backoff if Payaza ever rate-limits these.
   */
  async retryFailedPayouts(now = Date.now()) {
    const stuck = await this.prisma.campaign.findMany({ where: { status: 'payout_failed' }, select: { id: true }, take: 20 });
    let retried = 0;
    for (const { id } of stuck) {
      const tries = await this.prisma.transaction.findMany({ where: { campaignId: id, kind: 'PAYOUT' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true, failureReason: true } });
      if (!shouldRetryPayout(tries, now)) continue;
      await this.payout(id, undefined, { quiet: true }).then(() => retried++, (e) => this.log.warn(`payout retry ${id}: ${(e as Error).message}`));
    }
    return retried;
  }

  /** Funded work nobody delivered by the deadline plus a grace period goes back to the brand. Run by the worker. */
  async refundOverdue(graceMs = 3 * 24 * 3600_000) {
    const overdue = await this.prisma.campaign.findMany({ where: { status: { in: ['funded', 'in_progress'] }, deadline: { lt: new Date(Date.now() - graceMs) } }, take: 20 });
    for (const c of overdue) {
      await this.refund(c.id, undefined, 'Deadline passed without delivery').catch((e) => this.log.warn(`expire ${c.id}: ${e.message}`));
      await this.notifications.notify(c.creatorId, { kind: 'campaign', title: 'Campaign expired', body: `“${c.title}” passed its deadline without delivery, so the payment is returned to the brand.`, linkTo: `/campaigns/${c.id}` });
    }
    return overdue.length;
  }

  /** Campaigns owing the brand a refund that could not be sent (no account yet, or the bank returned it). */
  async refundsOwed(brandId: string) {
    return (await this.prisma.campaign.findMany({ where: { brandId, status: 'refund_failed' }, select: { id: true } })).map((c) => c.id);
  }

  // ---------- Confirmation (webhook, reconcile job, manual check all end here) ----------

  /** Re-queries Payaza — the only source of truth — and applies the result. Safe to call any number of times. */
  async reconcile(transactionId: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx || tx.status === 'successful' || tx.status === 'failed') return tx;
    // A card checkout is known to Payaza by its own id (learned from the signed webhook), not by our reference.
    const r = tx.kind === 'FUNDING' ? await this.provider.queryFunding(tx.providerReference ?? tx.payazaReference, tx.method ?? 'bank_transfer') : await this.provider.queryPayout(tx.payazaReference);
    const paid = 'amountNgn' in r && typeof r.amountNgn === 'number' ? r.amountNgn : undefined;
    if (r.status === 'successful' && tx.kind === 'FUNDING' && paid !== undefined && Math.round(paid * 100) < tx.amountKobo + tx.feeKobo) {
      this.log.warn(`funding ${tx.payazaReference}: Payaza reports ${paid}, expected ${(tx.amountKobo + tx.feeKobo) / 100}; not settling`);
      return tx;
    }
    if (r.status === 'pending') {
      if (tx.kind === 'FUNDING' && tx.method === 'card' && tx.createdAt.getTime() < Date.now() - CARD_CHECKOUT_TTL_MS) {
        await this.fail(tx, 'Card checkout abandoned');
        return this.prisma.transaction.findUnique({ where: { id: tx.id } });
      }
      if (r.providerStatus && r.providerStatus !== tx.providerStatus) {
        await this.prisma.transaction.update({ where: { id: tx.id }, data: { providerStatus: r.providerStatus } });
      }
      return tx;
    }
    await this.settle(tx.id, r.status, r.providerStatus, r.raw);
    return this.prisma.transaction.findUnique({ where: { id: tx.id } });
  }

  /** `checkoutReference`: Payaza's own id for a card checkout, from a signed webhook; it is what Payaza's status lookup knows. */
  async reconcileByReference(reference: string, checkoutReference?: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { payazaReference: reference } });
    if (!tx) return null;
    if (checkoutReference && !tx.providerReference && tx.method === 'card' && (tx.status === 'pending' || tx.status === 'processing')) {
      // unique: a checkout id already linked to another payment is ignored (the update fails, the link stays empty)
      await this.prisma.transaction.updateMany({ where: { id: tx.id, providerReference: null }, data: { providerReference: checkoutReference } }).catch(() => undefined);
    }
    return this.reconcile(tx.id);
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
  private async settle(transactionId: string, status: 'successful' | 'failed', providerStatus?: string, raw?: unknown, quiet = false) {
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
      if (tx.kind === 'REFUND') {
        return { tx, moved: await this.sm.transition(tx.campaignId, status === 'successful' ? 'refunded' : 'refund_failed', { reference: tx.payazaReference, tx: db }) };
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
    } else if (tx.kind === 'REFUND') {
      const total = fmt(tx.amountKobo);
      await (status === 'successful'
        ? this.notifications.notify(c.brandId, { kind: 'payout', title: 'Refund sent', body: `${total} for “${c.title}” is on its way back to your account.`, linkTo: `/campaigns/${c.id}` })
        : this.notifications.notify(c.brandId, { kind: 'payout', title: 'Add your refund account', body: `We couldn't send your ${total} refund for “${c.title}”. Save a bank account and we'll retry.`, linkTo: '/profile/payment' }));
    } else if (status === 'successful') {
      await this.notifications.notify(c.creatorId, { kind: 'payout', title: 'Payment successful', body: `${fmt(c.amountKobo)} paid for “${c.title}”. Ref ${tx.payazaReference}.`, linkTo: `/transaction/${tx.id}` });
      await this.notifications.notify(c.brandId, { kind: 'payout', title: 'Payout completed', body: `“${c.title}” is complete.`, linkTo: `/campaigns/${c.id}` });
    } else if (!quiet) {
      // Say what actually went wrong: a bank detail the creator can fix, or a provider limit only AfiCre8 can fix.
      const why = payoutFailure(String((raw as { error?: unknown; response_message?: unknown } | undefined)?.error ?? (raw as { response_message?: unknown } | undefined)?.response_message ?? ''));
      const amount = fmt(tx.amountKobo);
      await this.notifications.notify(c.creatorId, { kind: 'payout', title: why.bank ? 'Check your bank details' : 'Payout delayed', body: why.creator(amount, c.title), linkTo: why.bank ? '/profile/payment' : `/campaigns/${c.id}` });
      await this.notifications.notify(c.brandId, { kind: 'payout', title: 'Payout delayed', body: why.brand(amount, c.title), linkTo: `/campaigns/${c.id}` });
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
    // Card checkouts carry Payaza's own id in `transaction_reference` and ours in `merchant_reference`.
    const payazaRef = String(payload?.transaction_reference ?? payload?.data?.transaction_reference ?? '');
    const reference = String(payload?.merchant_reference ?? payload?.data?.merchant_reference ?? '') || payazaRef;
    const status = String(payload?.transaction_status ?? payload?.status ?? '');
    const eventId = `payaza:${payazaRef || reference}:${status}`;
    // A replay has no signature to check; it inherits the one verified when the event first arrived.
    const signatureOk = replay
      ? Boolean((await this.prisma.webhookEvent.findUnique({ where: { eventId }, select: { signatureOk: true } }))?.signatureOk)
      : this.provider.verifyWebhook(rawBody, signature);

    if (!replay) {
      try {
        await this.prisma.webhookEvent.create({ data: { provider: this.provider.name, eventId, type: status, reference, payload, signatureOk } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { duplicate: true };
        throw e;
      }
    }
    try {
      // Only a signed event may link Payaza's checkout id to our payment; the status still comes from Payaza itself.
      const tx = reference ? await this.reconcileByReference(reference, signatureOk && payazaRef !== reference ? payazaRef : undefined) : null;
      await this.prisma.webhookEvent.update({ where: { eventId }, data: { processedAt: new Date(), error: tx ? null : 'Unknown reference' } });
      return { duplicate: false, transactionStatus: tx?.status ?? null };
    } catch (e) {
      await this.prisma.webhookEvent.update({ where: { eventId }, data: { error: (e as Error).message } });
      throw e;
    }
  }

  // ---------- Queries ----------

  async approvedAwaitingPayout(creatorId: string) {
    const rows = await this.prisma.campaign.findMany({ where: { creatorId, status: { in: ['approved', 'payout_failed'] } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

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
    if (campaign.brandId !== userId) throw new ForbiddenException({ message: 'Only the brand that owns this campaign can do that.', code: ErrorCode.Forbidden });
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

/**
 * Why a payout did not go through, in words for each reader. A provider limit is AfiCre8's to fix (the creator does
 * nothing); a bank-detail problem is the creator's. The money stays held either way, so every message says so.
 */
export function payoutFailure(providerMessage: string) {
  const m = providerMessage.toLowerCase();
  if (/limit/.test(m))
    return {
      bank: false,
      reason: "Payaza's transfer limit was reached; AfiCre8 is raising it and will retry.",
      creator: (amount: string, title: string) => `Your ${amount} for “${title}” is safe. Our payment provider's transfer limit was reached, so the payout is delayed. We're fixing it and will pay you automatically; you don't need to do anything.`,
      brand: (amount: string, title: string) => `The ${amount} payout for “${title}” is delayed by our payment provider's transfer limit. Nothing more is charged to you; we'll retry automatically.`,
    };
  if (/account|beneficiary|bank|nuban|name/.test(m))
    return {
      bank: true,
      reason: 'The bank did not accept these account details. Check the account number and bank, then save them to retry.',
      creator: (amount: string, title: string) => `We couldn't send your ${amount} for “${title}” because the bank did not accept your account details. Check them in Payment details; saving them retries the payout. Your money is safe.`,
      brand: (amount: string, title: string) => `The ${amount} payout for “${title}” is waiting for the creator to correct their bank details. Nothing more is charged to you.`,
    };
  return {
    bank: false,
    reason: "The bank transfer didn't go through; AfiCre8 will retry.",
    creator: (amount: string, title: string) => `The transfer of your ${amount} for “${title}” didn't go through. Your money is safe and we'll retry; you don't need to do anything.`,
    brand: (amount: string, title: string) => `The ${amount} payout for “${title}” didn't go through on the first try. Nothing more is charged to you; we'll retry.`,
  };
}

/**
 * Retry a refused payout now? Not when the bank rejected the creator's details (theirs to fix; saving them retries),
 * at most every 30 minutes, and only within 24 hours of the first refusal. `tries`: the campaign's payouts, oldest first.
 */
export function shouldRetryPayout(tries: { createdAt: Date; failureReason: string | null }[], now: number) {
  const first = tries[0];
  const last = tries.at(-1);
  if (!first || !last) return false;
  if (/bank did not accept/i.test(last.failureReason ?? '')) return false;
  return now - first.createdAt.getTime() <= PAYOUT_RETRY_WINDOW_MS && now - last.createdAt.getTime() >= PAYOUT_RETRY_EVERY_MS;
}
