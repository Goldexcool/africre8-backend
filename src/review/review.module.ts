import { wrongStage } from '../common/errors.js';
import { Body, ConflictException, Controller, Injectable, Logger, Module, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CampaignsModule } from '../campaigns/campaigns.module.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { CampaignStateMachine } from '../campaigns/state-machine.js';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { CampaignStatus } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const revisionSchema = z.object({ note: z.string().trim().min(5).max(2000) });
const cancelSchema = z.object({ reason: z.string().trim().min(3).max(500).default('Cancelled by brand') });
const disputeSchema = z.object({ reason: z.string().trim().min(5).max(2000), evidence: z.array(z.string().url()).max(10).default([]) });
const DISPUTABLE: CampaignStatus[] = ['funded', 'in_progress', 'submitted', 'under_review', 'revision_required', 'approved'];

@Injectable()
export class ReviewService {
  private readonly log = new Logger(ReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sm: CampaignStateMachine,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Approval is the release decision; Payaza then executes the payout. */
  async approve(brandId: string, campaignId: string) {
    const c = await this.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (c.status !== 'under_review') throw wrongStage(c.status, 'Only work that is under review can be approved.');
    await this.sm.transition(campaignId, 'approved', { actorId: brandId });
    await this.notifications.notify(c.creatorId, { kind: 'review', title: 'Campaign approved', body: `“${c.title}” was approved. Releasing your payment.`, linkTo: `/campaigns/${campaignId}` });
    await this.releaseIfPossible(campaignId, brandId);
  }

  /** Pays out an approved campaign if the creator has bank details; otherwise asks them to add them. */
  async releaseIfPossible(campaignId: string, actorId?: string) {
    const c = await this.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (c.status !== 'approved' && c.status !== 'payout_failed') return;
    const dest = await this.prisma.payoutDestination.findUnique({ where: { userId: c.creatorId } });
    if (!dest) {
      await this.notifications.notify(c.creatorId, { kind: 'payout', title: 'Add your bank details', body: `Add a payout account to receive ₦${(c.amountKobo / 100).toLocaleString('en-NG')} for “${c.title}”.`, linkTo: '/profile/payment' });
      return;
    }
    await this.payments.payout(campaignId, actorId).catch((e) => this.log.warn(`payout ${campaignId}: ${(e as Error).message}`));
  }

  async requestRevision(brandId: string, campaignId: string, note: string) {
    const c = await this.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (c.status !== 'under_review') throw wrongStage(c.status, 'Revisions can only be requested on work that is under review.');
    const used = await this.prisma.auditLog.count({ where: { entity: 'Campaign', entityId: campaignId, action: 'campaign.status', toState: 'revision_required' } });
    if (used >= c.revisionLimit) throw new ConflictException(`All ${c.revisionLimit} agreed revisions used. Approve or raise a dispute.`);
    await this.sm.transition(campaignId, 'revision_required', { actorId: brandId, meta: { note } });
    await this.prisma.submission.updateMany({ where: { campaignId, superseded: false }, data: { revisionNote: note } });
    await this.notifications.notify(c.creatorId, { kind: 'review', title: 'Revision requested', body: note.slice(0, 140), linkTo: `/campaigns/${campaignId}` });
  }

  /** Brand walks away. Before funding nothing moves; once funded and before any delivery, the escrow is refunded. */
  async cancel(brandId: string, campaignId: string, reason: string): Promise<void> {
    const c = await this.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (['funded', 'in_progress'].includes(c.status)) {
      await this.payments.refund(campaignId, brandId, reason);
      await this.notifications.notify(c.creatorId, { kind: 'campaign', title: 'Campaign cancelled', body: `The brand cancelled “${c.title}” before delivery. The payment is being returned.`, linkTo: `/campaigns/${campaignId}` });
      return;
    }
    if (!['pending_agreement', 'awaiting_funding'].includes(c.status)) throw wrongStage(c.status, "This campaign can't be cancelled now. Raise a dispute instead.");
    const live = await this.prisma.transaction.findFirst({ where: { campaignId, kind: 'FUNDING', status: { in: ['pending', 'processing'] } } });
    if (live) {
      await this.payments.reconcile(live.id); // money may already have arrived
      const now = await this.prisma.transaction.findUniqueOrThrow({ where: { id: live.id } });
      if (now.status === 'successful') return this.cancel(brandId, campaignId, reason); // funded after all: refund path
      if (now.status !== 'failed') throw new ConflictException('A payment is still in progress. Try again in a minute.');
    }
    await this.sm.transition(campaignId, 'cancelled', { actorId: brandId, meta: { reason } });
    await this.notifications.notify(c.creatorId, { kind: 'campaign', title: 'Campaign cancelled', body: `The brand cancelled “${c.title}”.`, linkTo: `/campaigns/${campaignId}` });
  }

  async dispute(u: AuthUser, campaignId: string, reason: string, evidence: string[]) {
    const c = await this.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (!DISPUTABLE.includes(c.status)) throw wrongStage(c.status, "This campaign can't be disputed right now.");
    await this.prisma.$transaction(async (tx) => {
      await this.sm.transition(campaignId, 'disputed', { actorId: u.id, tx, meta: { reason } });
      await tx.dispute.create({ data: { campaignId, raisedById: u.id, reason, evidence } });
    });
    this.sm.announce({ ...c, status: 'disputed', from: c.status });
    const other = u.id === c.brandId ? c.creatorId : c.brandId;
    await this.notifications.notify(other, { kind: 'dispute', title: 'Dispute raised', body: `A dispute was raised on “${c.title}”. Payment is paused while AfiCre8 reviews it.`, linkTo: `/campaigns/${campaignId}` });
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    for (const a of admins) await this.notifications.notify(a.id, { kind: 'dispute', title: 'New dispute', body: `${c.title}: ${reason.slice(0, 100)}`, linkTo: `/admin/disputes` });
  }
}

@Controller('campaigns/:id')
@UseGuards(OnboardedGuard)
class ReviewController {
  constructor(
    private readonly review: ReviewService,
    private readonly campaigns: CampaignsService,
  ) {}

  private async brandOwned(u: AuthUser, id: string) {
    const c = await this.campaigns.owned(u, id);
    if (c.brandId !== u.id) throw new ConflictException('Only the brand can review');
  }

  @Roles('BRAND')
  @Post('approve')
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.brandOwned(u, id);
    await this.review.approve(u.id, id);
    return this.campaigns.detail(u, id);
  }

  @Roles('BRAND')
  @Post('cancel')
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cancelSchema)) b: z.infer<typeof cancelSchema>) {
    await this.brandOwned(u, id);
    await this.review.cancel(u.id, id, b.reason);
    return this.campaigns.detail(u, id);
  }

  @Roles('BRAND')
  @Post('revision')
  async revision(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(revisionSchema)) b: z.infer<typeof revisionSchema>) {
    await this.brandOwned(u, id);
    await this.review.requestRevision(u.id, id, b.note);
    return this.campaigns.detail(u, id);
  }

  @Roles('BRAND', 'CREATOR')
  @Post('dispute')
  async dispute(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(disputeSchema)) b: z.infer<typeof disputeSchema>) {
    await this.campaigns.owned(u, id);
    await this.review.dispute(u, id, b.reason, b.evidence);
    return this.campaigns.detail(u, id);
  }
}

@Module({
  imports: [CampaignsModule, PaymentsModule],
  controllers: [ReviewController],
  providers: [ReviewService],
  exports: [ReviewService],
})
export class ReviewModule {}
