import { Body, Controller, Get, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { CampaignStateMachine } from '../campaigns/state-machine.js';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { CampaignStatus, Prisma, Role, TransactionStatus } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReviewModule, ReviewService } from '../review/review.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { AdminAccess } from './access.js';
import { AdminModerationController, AdminModerationService, ReportsController, ReportsService } from './admin-moderation.js';
import { AdminMoneyController, AdminMoneyService } from './admin-money.js';
import { AdminPlatformController, AdminPlatformService } from './admin-platform.js';
import { AdminSystemController, AdminSystemService } from './admin-system.js';
import { AdminUsersController, AdminUsersService } from './admin-users.js';
import { AdminVerificationController, AdminVerificationService } from './admin-verification.js';

const resolveSchema = z
  .object({
    outcome: z.enum(['release', 'revision', 'resume', 'refund', 'split']),
    resolution: z.string().trim().min(5).max(2000),
    /** Only for `split`: the share of the work amount the creator receives. The brand gets the rest; the platform keeps its fee. */
    creatorPercent: z.number().int().min(1, 'The creator must receive at least 1%.').max(99, 'The brand must keep at least 1%.').optional(),
  })
  .refine((v) => v.outcome !== 'split' || v.creatorPercent !== undefined, { message: 'Choose what percentage the creator receives.', path: ['creatorPercent'] });
type ResolveInput = z.infer<typeof resolveSchema>;

const disputesQuery = z.object({
  status: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
  noResponse: z.enum(['true', 'false']).optional(),
  assigned: z.enum(['me', 'none']).optional(),
  campaignId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
type DisputesQuery = z.infer<typeof disputesQuery>;

const noteSchema = z.object({ note: z.string().trim().min(1).max(2000) });
const assignSchema = z.object({ adminId: z.string().uuid().nullable() });

const OUTCOME = { release: ['approved', 'RESOLVED_RELEASE'], revision: ['revision_required', 'RESOLVED_REVISION'], resume: ['in_progress', 'RESOLVED_REVISION'], refund: ['refund_processing', 'RESOLVED_REFUND'] } as const;
const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG')}`;

type Person = { id: string; role: Role; name: string; email: string };

@Injectable()
class AdminService {
  private readonly log = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sm: CampaignStateMachine,
    private readonly payments: PaymentsService,
    private readonly review: ReviewService,
    private readonly campaigns: CampaignsService,
    private readonly notifications: NotificationsService,
  ) {}

  async overview() {
    const [users, campaigns, tx, openDisputes, failedWebhooks, verifications] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], _count: true }),
      this.prisma.campaign.groupBy({ by: ['status'], _count: true }),
      this.prisma.transaction.groupBy({ by: ['kind', 'status'], _count: true, _sum: { amountKobo: true, feeKobo: true } }),
      this.prisma.dispute.count({ where: { status: 'OPEN' } }),
      this.prisma.webhookEvent.count({ where: { OR: [{ error: { not: null } }, { processedAt: null }] } }),
      this.prisma.verificationRun.groupBy({ by: ['verdict'], _count: true }),
    ]);
    return { users, campaigns, transactions: tx, openDisputes, failedWebhooks, verifications };
  }

  campaigns_(status?: CampaignStatus) {
    return this.prisma.campaign.findMany({ where: status ? { status } : {}, orderBy: { updatedAt: 'desc' }, take: 200 });
  }

  // ---------- Disputes ----------

  /** Names and emails for a set of user ids (brand business name, creator display name). */
  private async people(ids: (string | null | undefined)[]): Promise<Map<string, Person>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, role: true, email: true, creatorProfile: { select: { displayName: true } }, brandProfile: { select: { businessName: true } } },
    });
    return new Map(users.map((u) => [u.id, { id: u.id, role: u.role, email: u.email, name: u.creatorProfile?.displayName ?? u.brandProfile?.businessName ?? u.email }]));
  }

  /** The dispute queue. Open ones are oldest first (they have waited longest); resolved ones newest first. */
  async disputes(adminId: string, q: DisputesQuery) {
    const where: Prisma.DisputeWhereInput = {
      ...(q.status === 'OPEN' ? { status: 'OPEN' } : q.status === 'RESOLVED' ? { status: { not: 'OPEN' } } : {}),
      ...(q.noResponse === 'true' ? { noResponse: true } : {}),
      ...(q.assigned === 'me' ? { assignedToId: adminId } : q.assigned === 'none' ? { assignedToId: null } : {}),
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.dispute.count({ where }),
      this.prisma.dispute.findMany({
        where,
        orderBy: { createdAt: q.status === 'OPEN' ? 'asc' : 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { campaign: { select: { id: true, title: true, status: true, amountKobo: true, feeKobo: true, brandId: true, creatorId: true } } },
      }),
    ]);
    const people = await this.people(rows.flatMap((d) => [d.campaign.brandId, d.campaign.creatorId, d.assignedToId]));
    const items = rows.map((d) => {
      const otherId = d.raisedById === d.campaign.brandId ? d.campaign.creatorId : d.campaign.brandId;
      return {
        id: d.id,
        status: d.status,
        reason: d.reason,
        createdAt: d.createdAt,
        respondBy: d.respondBy,
        noResponse: d.noResponse,
        responded: !!d.respondedAt,
        assignedTo: d.assignedToId ? (people.get(d.assignedToId) ?? null) : null,
        campaign: { id: d.campaign.id, title: d.campaign.title, status: d.campaign.status, amountKobo: d.campaign.amountKobo, feeKobo: d.campaign.feeKobo },
        raisedBy: people.get(d.raisedById) ?? null,
        otherParty: people.get(otherId) ?? null,
      };
    });
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Everything needed to decide a dispute on one screen. Verification frames and transcripts are left out (they are large). */
  async dispute(admin: AuthUser, id: string) {
    const d = await this.prisma.dispute.findUnique({ where: { id }, include: { notes: { orderBy: { createdAt: 'asc' } } } });
    if (!d) throw new NotFoundException('Dispute not found');
    const campaign = await this.campaigns.detail(admin, d.campaignId);
    const people = await this.people([campaign.brandId, campaign.creatorId, d.raisedById, d.respondedById, d.assignedToId, ...d.notes.map((n) => n.adminId)]);
    const slim = { ...campaign, submissions: campaign.submissions.map((s) => ({ ...s, verifications: s.verifications.map(({ evidence: _evidence, ...v }) => v) })) };
    return {
      dispute: {
        id: d.id,
        status: d.status,
        reason: d.reason,
        evidence: d.evidence,
        raisedById: d.raisedById,
        createdAt: d.createdAt,
        respondBy: d.respondBy,
        noResponse: d.noResponse,
        response: d.respondedAt ? { reason: d.responseReason, evidence: d.responseEvidence, respondedAt: d.respondedAt, byId: d.respondedById } : null,
        resolution: d.resolution,
        resolvedAt: d.resolvedAt,
        splitCreatorKobo: d.splitCreatorKobo,
        splitBrandKobo: d.splitBrandKobo,
      },
      assignedTo: d.assignedToId ? (people.get(d.assignedToId) ?? null) : null,
      notes: d.notes.map((n) => ({ id: n.id, admin: people.get(n.adminId) ?? null, note: n.note, createdAt: n.createdAt })),
      campaign: slim,
      brand: people.get(campaign.brandId) ?? null,
      creator: people.get(campaign.creatorId) ?? null,
    };
  }

  async addNote(adminId: string, id: string, note: string) {
    const d = await this.prisma.dispute.findUnique({ where: { id }, select: { id: true } });
    if (!d) throw new NotFoundException('Dispute not found');
    const row = await this.prisma.disputeNote.create({ data: { disputeId: id, adminId, note } });
    await this.prisma.auditLog.create({ data: { actorId: adminId, action: 'dispute.note_added', entity: 'Dispute', entityId: id } });
    const people = await this.people([adminId]);
    return { id: row.id, admin: people.get(adminId) ?? null, note: row.note, createdAt: row.createdAt };
  }

  /** Takes a dispute (or hands it to another admin, or clears it with null). */
  async assign(adminId: string, id: string, assignee: string | null) {
    const d = await this.prisma.dispute.findUnique({ where: { id }, include: { campaign: { select: { title: true } } } });
    if (!d) throw new NotFoundException('Dispute not found');
    if (assignee) {
      const target = await this.prisma.user.findFirst({ where: { id: assignee, role: 'ADMIN' }, select: { id: true } });
      if (!target) throw new NotFoundException('That admin was not found');
    }
    await this.prisma.dispute.update({ where: { id }, data: { assignedToId: assignee } });
    await this.prisma.auditLog.create({ data: { actorId: adminId, action: 'dispute.assigned', entity: 'Dispute', entityId: id, meta: { assignee } } });
    if (assignee && assignee !== adminId) await this.notifications.notify(assignee, { kind: 'dispute', title: 'A dispute was assigned to you', body: d.campaign.title, linkTo: '/admin/disputes' });
    const people = await this.people([assignee]);
    return { assignedTo: assignee ? (people.get(assignee) ?? null) : null };
  }

  async resolve(adminId: string, id: string, input: ResolveInput) {
    const d = await this.prisma.dispute.findUnique({ where: { id }, include: { campaign: true } });
    if (!d || d.status !== 'OPEN') throw new NotFoundException('Open dispute not found');
    const { outcome, resolution } = input;
    if (outcome === 'split') return this.resolveSplit(adminId, d, input.creatorPercent as number, resolution);

    const [to, status] = OUTCOME[outcome];
    if (outcome === 'refund') {
      await this.payments.refund(d.campaignId, adminId, resolution); // moves the campaign itself
      await this.prisma.dispute.update({ where: { id }, data: { status, resolution, resolvedAt: new Date() } });
    } else {
      await this.prisma.$transaction(async (tx) => {
        await this.sm.transition(d.campaignId, to, { actorId: adminId, tx, meta: { disputeId: id, resolution } });
        await tx.dispute.update({ where: { id }, data: { status, resolution, resolvedAt: new Date() } });
      });
      this.sm.announce({ ...d.campaign, status: to, from: 'disputed' });
    }
    for (const userId of [d.campaign.brandId, d.campaign.creatorId]) {
      await this.notifications.notify(userId, { kind: 'dispute', title: 'Dispute resolved', body: resolution.slice(0, 140), linkTo: `/campaigns/${d.campaignId}` });
    }
    if (outcome === 'release') await this.review.releaseIfPossible(d.campaignId, adminId);
    return this.prisma.dispute.findUnique({ where: { id } });
  }

  /**
   * Splits the WORK amount: the creator gets `creatorPercent` as a payout, the brand gets the rest back as a refund, and the
   * platform keeps its fee. The campaign follows the creator's payout (approved, then paid out); the brand's refund is its
   * own transaction. If either leg cannot start now (no bank account yet) it waits and is retried, never lost.
   */
  private async resolveSplit(adminId: string, d: Prisma.DisputeGetPayload<{ include: { campaign: true } }>, creatorPercent: number, resolution: string) {
    const work = d.campaign.amountKobo;
    const creatorKobo = Math.round((work * creatorPercent) / 100);
    const brandKobo = work - creatorKobo;
    await this.prisma.$transaction(async (tx) => {
      await this.sm.transition(d.campaignId, 'approved', { actorId: adminId, tx, meta: { disputeId: d.id, resolution, split: { creatorKobo, brandKobo } } });
      await tx.campaign.update({ where: { id: d.campaignId }, data: { payoutKobo: creatorKobo } });
      const claimed = await tx.dispute.updateMany({
        where: { id: d.id, status: 'OPEN' },
        data: { status: 'RESOLVED_SPLIT', resolution, resolvedAt: new Date(), splitCreatorKobo: creatorKobo, splitBrandKobo: brandKobo },
      });
      if (claimed.count !== 1) throw new NotFoundException('Open dispute not found');
    });
    this.sm.announce({ ...d.campaign, status: 'approved', from: 'disputed' });
    const title = d.campaign.title;
    await this.notifications.notify(d.campaign.creatorId, { kind: 'dispute', title: 'Dispute resolved', body: `${naira(creatorKobo)} of “${title}” is paid to you. ${resolution.slice(0, 100)}`, linkTo: `/campaigns/${d.campaignId}` });
    await this.notifications.notify(d.campaign.brandId, { kind: 'dispute', title: 'Dispute resolved', body: `${naira(brandKobo)} of “${title}” returns to you (the work amount only; the platform fee is kept). ${resolution.slice(0, 80)}`, linkTo: `/campaigns/${d.campaignId}` });
    await this.review.releaseIfPossible(d.campaignId, adminId); // pays creatorKobo, or asks the creator for bank details
    await this.payments.splitRefund(d.campaignId, adminId, brandKobo, 'Dispute split').catch((e) => this.log.warn(`split refund ${d.campaignId}: ${(e as Error).message} (the worker will create it)`));
    return this.prisma.dispute.findUnique({ where: { id: d.id } });
  }

}

@Roles('ADMIN')
@Controller('admin')
class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview') overview() { return this.admin.overview(); }
  @Get('campaigns') campaigns(@Query('status') status?: CampaignStatus) { return this.admin.campaigns_(status); }

  @Get('disputes') disputes(@CurrentUser() a: AuthUser, @Query(new ZodPipe(disputesQuery)) q: DisputesQuery) { return this.admin.disputes(a.id, q); }
  @Get('disputes/:id') dispute(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.admin.dispute(a, id); }
  @Post('disputes/:id/notes')
  note(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) b: z.infer<typeof noteSchema>) {
    return this.admin.addNote(a.id, id, b.note);
  }
  @Post('disputes/:id/assign')
  assign(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(assignSchema)) b: z.infer<typeof assignSchema>) {
    return this.admin.assign(a.id, id, b.adminId);
  }
  @Post('disputes/:id/resolve')
  resolve(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(resolveSchema)) b: ResolveInput) {
    return this.admin.resolve(a.id, id, b);
  }
}

@Module({
  imports: [CampaignsModule, PaymentsModule, ReviewModule, VerificationModule],
  controllers: [AdminController, AdminVerificationController, AdminUsersController, AdminMoneyController, AdminModerationController, ReportsController, AdminPlatformController, AdminSystemController],
  providers: [AdminService, AdminAccess, AdminVerificationService, AdminUsersService, AdminMoneyService, AdminModerationService, ReportsService, AdminPlatformService, AdminSystemService],
  exports: [AdminAccess],
})
export class AdminModule {}
