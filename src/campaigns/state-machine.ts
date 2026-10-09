import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode, wrongStage } from '../common/errors.js';
import type { CampaignStatus, Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/** Allowed moves. Ported from the mobile reducer and extended with revision, dispute and payout-retry paths. */
export const TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  pending_agreement: ['awaiting_funding', 'cancelled'],
  awaiting_funding: ['funded', 'pending_agreement', 'cancelled'],
  funded: ['in_progress', 'submitted', 'disputed', 'refund_processing'],
  in_progress: ['submitted', 'disputed', 'refund_processing'],
  submitted: ['under_review', 'disputed'],
  under_review: ['approved', 'revision_required', 'disputed'],
  revision_required: ['submitted', 'disputed'],
  approved: ['payout_processing', 'disputed'],
  payout_processing: ['completed', 'payout_failed'],
  payout_failed: ['payout_processing'],
  completed: [],
  disputed: ['approved', 'revision_required', 'in_progress', 'refund_processing'],
  cancelled: [],
  refund_processing: ['refunded', 'refund_failed'],
  refund_failed: ['refund_processing'],
  refunded: [],
};

@Injectable()
export class CampaignStateMachine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The only way a campaign status changes. Compare-and-set on the current status makes concurrent
   * transitions (e.g. webhook + reconcile job) safe: exactly one wins, the other gets a 409.
   */
  async transition(
    campaignId: string,
    to: CampaignStatus,
    opts: { actorId?: string; reference?: string; meta?: Prisma.InputJsonValue; data?: Prisma.CampaignUpdateInput; tx?: Tx } = {},
  ) {
    const run = async (tx: Tx) => {
      const c = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!c) throw new NotFoundException('Campaign not found');
      if (!TRANSITIONS[c.status].includes(to)) throw wrongStage(c.status);

      if (to === 'funded' && !(await tx.transaction.findFirst({ where: { campaignId, kind: 'FUNDING', status: 'successful' } }))) {
        throw new ConflictException({ message: "We're still waiting for the payment provider to confirm this payment.", code: ErrorCode.PaymentPending });
      }
      if (to === 'completed' && !(await tx.transaction.findFirst({ where: { campaignId, kind: 'PAYOUT', status: 'successful' } }))) {
        throw new ConflictException({ message: "We're still waiting for the payment provider to confirm the payout.", code: ErrorCode.PaymentPending });
      }

      if (to === 'refunded' && !(await tx.transaction.findFirst({ where: { campaignId, kind: 'REFUND', status: 'successful' } }))) {
        throw new ConflictException({ message: "We're still waiting for the payment provider to confirm the refund.", code: ErrorCode.PaymentPending });
      }

      const now = new Date();
      const updated = await tx.campaign.updateMany({
        where: { id: campaignId, status: c.status },
        data: {
          ...(opts.data as Prisma.CampaignUpdateManyMutationInput),
          status: to,
          ...(to === 'funded' && { fundedAt: now }),
          ...(to === 'completed' && { completedAt: now }),
        },
      });
      if (updated.count !== 1) throw new ConflictException({ message: 'This campaign was just updated. Please try again.', code: ErrorCode.CampaignChanged });

      await tx.auditLog.create({
        data: {
          actorId: opts.actorId,
          action: 'campaign.status',
          entity: 'Campaign',
          entityId: campaignId,
          fromState: c.status,
          toState: to,
          reference: opts.reference,
          meta: opts.meta,
        },
      });
      return { ...c, status: to, from: c.status };
    };

    const result = opts.tx ? await run(opts.tx) : await this.prisma.$transaction(run);
    // Fire-and-forget push; callers inside an outer tx should call announce() after commit instead.
    if (!opts.tx) this.announce(result);
    return result;
  }

  announce(c: { id: string; brandId: string; creatorId: string; status: CampaignStatus; from?: CampaignStatus }) {
    const payload = { campaignId: c.id, status: c.status, from: c.from };
    this.notifications.emit(c.brandId, 'campaign', payload);
    this.notifications.emit(c.creatorId, 'campaign', payload);
  }
}
