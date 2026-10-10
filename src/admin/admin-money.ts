import { Body, ConflictException, Controller, Get, Header, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReviewService } from '../review/review.module.js';
import { AdminAccess } from './access.js';
import { audit, pageQuery, people, toCsv } from './common.js';

const filters = {
  kind: z.enum(['FUNDING', 'PAYOUT', 'REFUND']).optional(),
  status: z.enum(['pending', 'processing', 'successful', 'failed']).optional(),
  campaignId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  reconciled: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};
const listQuery = z.object({ ...filters, ...pageQuery });
const exportQuery = z.object(filters);
type Filters = z.infer<typeof exportQuery>;
const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) });
const noteSchema = z.object({ note: z.string().trim().min(3).max(500) });
const rangeQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const webhookQuery = z.object({ view: z.enum(['problems', 'all']).default('problems'), ...pageQuery });

const EXPORT_LIMIT = 5000;

@Injectable()
export class AdminMoneyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly review: ReviewService,
    private readonly access: AdminAccess,
  ) {}

  private where(f: Filters): Prisma.TransactionWhereInput {
    return {
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.campaignId ? { campaignId: f.campaignId } : {}),
      ...(f.reconciled === 'true' ? { reconciledAt: { not: null } } : f.reconciled === 'false' ? { reconciledAt: null } : {}),
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      ...(f.q ? { OR: [{ payazaReference: { contains: f.q, mode: 'insensitive' } }, { campaign: { title: { contains: f.q, mode: 'insensitive' } } }] } : {}),
    };
  }

  async list(q: z.infer<typeof listQuery>) {
    const where = this.where(q);
    const [total, rows] = await Promise.all([
      this.prisma.transaction.count({ where }),
      this.prisma.transaction.findMany({ where, omit: { providerResponse: true }, include: { campaign: { select: { title: true, status: true } } }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  }

  async csv(f: Filters) {
    const rows = await this.prisma.transaction.findMany({ where: this.where(f), include: { campaign: { select: { title: true, brandId: true, creatorId: true } } }, orderBy: { createdAt: 'desc' }, take: EXPORT_LIMIT });
    return toCsv(
      ['id', 'createdAt', 'kind', 'purpose', 'status', 'amountNgn', 'feeNgn', 'reference', 'campaignId', 'campaign', 'failureReason', 'reconciledAt'],
      rows.map((t) => [t.id, t.createdAt, t.kind, t.purpose, t.status, t.amountKobo / 100, t.feeKobo / 100, t.payazaReference, t.campaignId, t.campaign.title, t.failureReason, t.reconciledAt]),
    );
  }

  async one(id: string) {
    const t = await this.prisma.transaction.findUnique({ where: { id }, include: { campaign: { select: { id: true, title: true, status: true, brandId: true, creatorId: true, amountKobo: true, feeKobo: true, payoutKobo: true } } } });
    if (!t) throw new NotFoundException('Transaction not found');
    const [who, history] = await Promise.all([
      people(this.prisma, [t.campaign.brandId, t.campaign.creatorId, t.reconciledById]),
      this.prisma.auditLog.findMany({ where: { OR: [{ entity: 'Transaction', entityId: id }, { reference: t.payazaReference }] }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { transaction: t, brand: who.get(t.campaign.brandId) ?? null, creator: who.get(t.campaign.creatorId) ?? null, reconciledBy: t.reconciledById ? (who.get(t.reconciledById) ?? null) : null, history };
  }

  /** Asks the payment provider for the truth (the only source) and applies it. Safe to repeat. */
  async check(adminId: string, id: string) {
    await this.access.need(adminId, 'money');
    const t = await this.prisma.transaction.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundException('Transaction not found');
    await this.payments.reconcile(id);
    await audit(this.prisma, adminId, 'money.checked', 'Transaction', id);
    return this.one(id);
  }

  /** Marks a settled transaction as matched to the bank statement. Only the bookkeeping flag changes. */
  async markReconciled(adminId: string, id: string, note: string) {
    await this.access.need(adminId, 'money');
    const t = await this.prisma.transaction.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Transaction not found');
    if (t.status !== 'successful' && t.status !== 'failed') throw new ConflictException('Only a finished transaction can be marked as reconciled.');
    const claimed = await this.prisma.transaction.updateMany({ where: { id, reconciledAt: null }, data: { reconciledAt: new Date(), reconciledById: adminId } });
    if (claimed.count === 1) await audit(this.prisma, adminId, 'money.reconciled', 'Transaction', id, { note });
    return this.one(id);
  }

  /**
   * Tries a failed payout or refund again. It goes through the same code as the first attempt, so it can never create a
   * second live payout or refund (the database allows only one) and never moves money for a campaign in the wrong state.
   */
  async retry(adminId: string, id: string) {
    await this.access.need(adminId, 'money');
    const t = await this.prisma.transaction.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Transaction not found');
    if (t.status !== 'failed') throw new ConflictException('Only a failed payment can be retried.');
    if (t.kind === 'FUNDING') throw new ConflictException('A failed funding attempt is retried by the brand, not by an admin.');
    await audit(this.prisma, adminId, 'money.retry', 'Transaction', id, { kind: t.kind, purpose: t.purpose });
    if (t.kind === 'PAYOUT') await this.payments.payout(t.campaignId, adminId);
    else if (t.purpose === 'DISPUTE_SPLIT') {
      const live = await this.prisma.transaction.findFirst({ where: { campaignId: t.campaignId, kind: 'REFUND', status: { not: 'failed' } } });
      if (live) throw new ConflictException('A refund for this campaign is already in progress or done.');
      await this.payments.splitRefund(t.campaignId, adminId, t.amountKobo, 'Retried by an admin');
    } else await this.payments.refund(t.campaignId, adminId, 'Retried by an admin');
    return this.one(id);
  }

  /** Admin cancels a campaign: unfunded just closes; funded and undelivered returns the work amount to the brand. */
  async cancelCampaign(adminId: string, campaignId: string, reason: string) {
    await this.access.need(adminId, 'money');
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!c) throw new NotFoundException('Campaign not found');
    await audit(this.prisma, adminId, 'money.campaign_cancelled', 'Campaign', campaignId, { reason });
    await this.review.cancel(adminId, campaignId, reason);
    return this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true } });
  }

  /** Everything that is stuck or late, in one place. */
  async attention() {
    const now = new Date();
    const stale = new Date(now.getTime() - 24 * 3600_000);
    const [payoutFailed, refundFailed, approvedNoBank, overdue, stuck] = await Promise.all([
      this.prisma.campaign.findMany({ where: { status: 'payout_failed' }, orderBy: { updatedAt: 'asc' }, take: 50, select: { id: true, title: true, amountKobo: true, payoutKobo: true, updatedAt: true, creatorId: true } }),
      this.prisma.campaign.findMany({ where: { status: 'refund_failed' }, orderBy: { updatedAt: 'asc' }, take: 50, select: { id: true, title: true, amountKobo: true, updatedAt: true, brandId: true } }),
      this.prisma.campaign.findMany({ where: { status: 'approved' }, orderBy: { updatedAt: 'asc' }, take: 50, select: { id: true, title: true, amountKobo: true, payoutKobo: true, updatedAt: true, creatorId: true } }),
      this.prisma.campaign.findMany({ where: { status: { in: ['funded', 'in_progress'] }, deadline: { lt: now } }, orderBy: { deadline: 'asc' }, take: 50, select: { id: true, title: true, amountKobo: true, deadline: true, status: true } }),
      this.prisma.transaction.findMany({ where: { status: { in: ['pending', 'processing'] }, createdAt: { lt: stale }, kind: { not: 'FUNDING' } }, orderBy: { createdAt: 'asc' }, take: 50, omit: { providerResponse: true }, include: { campaign: { select: { title: true } } } }),
    ]);
    return { payoutFailed, refundFailed, approvedNoBank, overdue, stuck };
  }

  /** Platform revenue: the fee is kept on every funded campaign, whatever happens to the work amount. */
  async revenue(r: z.infer<typeof rangeQuery>) {
    const dateFilter = r.from || r.to ? { createdAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } } : {};
    const funded = await this.prisma.transaction.findMany({ where: { kind: 'FUNDING', status: 'successful', ...dateFilter }, select: { amountKobo: true, feeKobo: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 50_000 });
    const [paidOut, refunded] = await Promise.all([
      this.prisma.transaction.aggregate({ where: { kind: 'PAYOUT', status: 'successful', ...dateFilter }, _sum: { amountKobo: true }, _count: true }),
      this.prisma.transaction.aggregate({ where: { kind: 'REFUND', status: 'successful', ...dateFilter }, _sum: { amountKobo: true }, _count: true }),
    ]);
    const byMonth = new Map<string, { feesKobo: number; fundedKobo: number; count: number }>();
    for (const t of funded) {
      const key = t.createdAt.toISOString().slice(0, 7);
      const m = byMonth.get(key) ?? { feesKobo: 0, fundedKobo: 0, count: 0 };
      m.feesKobo += t.feeKobo;
      m.fundedKobo += t.amountKobo;
      m.count += 1;
      byMonth.set(key, m);
    }
    return {
      feesKobo: funded.reduce((s, t) => s + t.feeKobo, 0),
      fundedKobo: funded.reduce((s, t) => s + t.amountKobo, 0),
      fundedCount: funded.length,
      paidOutKobo: paidOut._sum.amountKobo ?? 0,
      paidOutCount: paidOut._count,
      refundedKobo: refunded._sum.amountKobo ?? 0,
      refundedCount: refunded._count,
      byMonth: [...byMonth.entries()].map(([month, v]) => ({ month, ...v })),
    };
  }

  async webhooks(q: z.infer<typeof webhookQuery>) {
    const where: Prisma.WebhookEventWhereInput = q.view === 'problems' ? { OR: [{ error: { not: null } }, { processedAt: null }, { signatureOk: false }] } : {};
    const [total, items] = await Promise.all([this.prisma.webhookEvent.count({ where }), this.prisma.webhookEvent.findMany({ where, orderBy: { receivedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async replay(adminId: string, id: string) {
    await this.access.need(adminId, 'money');
    const e = await this.prisma.webhookEvent.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Event not found');
    await audit(this.prisma, adminId, 'money.webhook_replayed', 'WebhookEvent', id);
    return this.payments.handleWebhook(Buffer.from(JSON.stringify(e.payload)), undefined, e.payload, true);
  }
}

@Roles('ADMIN')
@Controller('admin')
export class AdminMoneyController {
  constructor(private readonly svc: AdminMoneyService) {}

  @Get('transactions') list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) { return this.svc.list(q); }
  @Get('transactions.csv') @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="transactions.csv"') csv(@Query(new ZodPipe(exportQuery)) q: Filters) { return this.svc.csv(q); }
  @Get('transactions/:id') one(@Param('id', ParseUUIDPipe) id: string) { return this.svc.one(id); }
  @Post('transactions/:id/check') check(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.check(a.id, id); }
  @Post('transactions/:id/retry') retry(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.retry(a.id, id); }
  @Post('transactions/:id/reconciled') reconciled(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) b: z.infer<typeof noteSchema>) { return this.svc.markReconciled(a.id, id, b.note); }
  @Post('campaigns/:id/cancel') cancel(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) { return this.svc.cancelCampaign(a.id, id, b.reason); }
  @Get('money/attention') attention() { return this.svc.attention(); }
  @Get('money/revenue') revenue(@Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>) { return this.svc.revenue(q); }
  @Get('webhooks') webhooks(@Query(new ZodPipe(webhookQuery)) q: z.infer<typeof webhookQuery>) { return this.svc.webhooks(q); }
  @Post('webhooks/:id/replay') replay(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.replay(a.id, id); }
}
