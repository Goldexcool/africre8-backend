import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { CampaignStateMachine } from '../campaigns/state-machine.js';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { CampaignStatus, Role, TransactionStatus } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReviewModule, ReviewService } from '../review/review.module.js';

const resolveSchema = z.object({ outcome: z.enum(['release', 'revision', 'resume', 'refund']), resolution: z.string().trim().min(5).max(2000) });
const OUTCOME = { release: ['approved', 'RESOLVED_RELEASE'], revision: ['revision_required', 'RESOLVED_REVISION'], resume: ['in_progress', 'RESOLVED_REVISION'], refund: ['refund_processing', 'RESOLVED_REFUND'] } as const;

@Injectable()
class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sm: CampaignStateMachine,
    private readonly payments: PaymentsService,
    private readonly review: ReviewService,
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

  users(role?: Role) {
    return this.prisma.user.findMany({
      where: role ? { role } : {},
      omit: { passwordHash: true },
      include: { creatorProfile: { select: { displayName: true, avatarUrl: true } }, brandProfile: { select: { businessName: true, logoUrl: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async setUser(adminId: string, id: string, data: { status?: 'ACTIVE' | 'SUSPENDED'; verificationStatus?: 'VERIFIED' | 'REJECTED' }) {
    const u = await this.prisma.user.update({ where: { id }, data, omit: { passwordHash: true } });
    if (data.status === 'SUSPENDED') await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.auditLog.create({ data: { actorId: adminId, action: 'admin.user_updated', entity: 'User', entityId: id, meta: data } });
    return u;
  }

  campaigns(status?: CampaignStatus) {
    return this.prisma.campaign.findMany({ where: status ? { status } : {}, orderBy: { updatedAt: 'desc' }, take: 200 });
  }

  transactions(status?: TransactionStatus) {
    return this.prisma.transaction.findMany({ where: status ? { status } : {}, include: { campaign: { select: { title: true, status: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  webhooks() {
    return this.prisma.webhookEvent.findMany({ orderBy: { receivedAt: 'desc' }, take: 200 });
  }

  /** Demo of idempotency: replaying an event re-runs reconciliation but can never double-fund or double-pay. */
  async replay(id: string) {
    const e = await this.prisma.webhookEvent.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Event not found');
    const raw = Buffer.from(JSON.stringify(e.payload));
    return this.payments.handleWebhook(raw, undefined, e.payload, true);
  }

  verifications() {
    return this.prisma.verificationRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 100,
      omit: { evidence: true },
      include: { submission: { select: { contentUrl: true, campaignId: true } } },
    });
  }

  disputes() {
    return this.prisma.dispute.findMany({ include: { campaign: true }, orderBy: { createdAt: 'desc' } });
  }

  async resolve(adminId: string, id: string, outcome: keyof typeof OUTCOME, resolution: string) {
    const d = await this.prisma.dispute.findUnique({ where: { id }, include: { campaign: true } });
    if (!d || d.status !== 'OPEN') throw new NotFoundException('Open dispute not found');
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

  audit(entityId?: string) {
    return this.prisma.auditLog.findMany({ where: entityId ? { entityId } : {}, orderBy: { createdAt: 'desc' }, take: 300 });
  }
}

@Roles('ADMIN')
@Controller('admin')
class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview') overview() { return this.admin.overview(); }
  @Get('users') users(@Query('role') role?: Role) { return this.admin.users(role); }
  @Post('users/:id/suspend') suspend(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.admin.setUser(a.id, id, { status: 'SUSPENDED' }); }
  @Post('users/:id/unsuspend') unsuspend(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.admin.setUser(a.id, id, { status: 'ACTIVE' }); }
  @Post('users/:id/verify') verify(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.admin.setUser(a.id, id, { verificationStatus: 'VERIFIED' }); }
  @Get('campaigns') campaigns(@Query('status') status?: CampaignStatus) { return this.admin.campaigns(status); }
  @Get('transactions') transactions(@Query('status') status?: TransactionStatus) { return this.admin.transactions(status); }
  @Get('webhooks') webhooks() { return this.admin.webhooks(); }
  @Post('webhooks/:id/replay') replay(@Param('id', ParseUUIDPipe) id: string) { return this.admin.replay(id); }
  @Get('verifications') verifications() { return this.admin.verifications(); }
  @Get('disputes') disputes() { return this.admin.disputes(); }
  @Post('disputes/:id/resolve')
  resolve(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(resolveSchema)) b: z.infer<typeof resolveSchema>) {
    return this.admin.resolve(a.id, id, b.outcome, b.resolution);
  }
  @Get('audit') audit(@Query('entityId') entityId?: string) { return this.admin.audit(entityId); }
}

@Module({ imports: [CampaignsModule, PaymentsModule, ReviewModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
