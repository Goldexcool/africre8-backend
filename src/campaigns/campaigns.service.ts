import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode, wrongStage } from '../common/errors.js';
import type { AuthUser } from '../common/auth.decorators.js';
import type { CampaignStatus } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.module.js';
import type { CreateInput, TermsInput } from './campaigns.schemas.js';
import { CampaignStateMachine } from './state-machine.js';

const EDITABLE: CampaignStatus[] = ['pending_agreement', 'awaiting_funding'];
const normTag = (t: string, p: string) => (t.startsWith(p) ? t : p + t).toLowerCase();

/** The platform fee (basis points, an admin setting; 800 = 8%) is paid by the brand on top of the work amount. */
const termsData = (t: TermsInput, feeBps: number) => ({
  title: t.title,
  brief: t.brief,
  amountKobo: t.amountNgn * 100,
  feeKobo: Math.round((t.amountNgn * 100 * feeBps) / 10_000),
  deadline: t.deadline,
  revisionLimit: t.revisionLimit,
  usageRights: t.usageRights,
});
const requirementsData = (t: TermsInput) =>
  t.requirements.map((r, position) => ({
    position,
    title: r.title,
    platform: r.platform,
    contentBrief: r.contentBrief,
    hashtags: r.hashtags.map((h) => normTag(h, '#')),
    mentions: r.mentions.map((m) => normTag(m, '@')),
  }));

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sm: CampaignStateMachine,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  async create(brandId: string, input: CreateInput) {
    const match = await this.prisma.match.findUnique({ where: { id: input.matchId }, include: { conversation: true } });
    if (!match || match.brandId !== brandId) throw new NotFoundException('Match not found');
    const open = await this.prisma.campaign.findFirst({ where: { matchId: match.id, status: { not: 'completed' } } });
    if (open) throw new ConflictException('This match already has an open campaign');

    const feeBps = await this.settings.number('platformFeeBps');
    const campaign = await this.prisma.$transaction(async (tx) => {
      const c = await tx.campaign.create({
        data: {
          matchId: match.id,
          brandId,
          creatorId: match.creatorId,
          ...termsData(input, feeBps),
          brandAcceptedAt: new Date(), // proposer accepts their own terms
          requirements: { create: requirementsData(input) },
        },
      });
      await tx.auditLog.create({ data: { actorId: brandId, action: 'campaign.created', entity: 'Campaign', entityId: c.id, toState: c.status } });
      if (match.conversation) {
        await tx.message.create({
          data: { conversationId: match.conversation.id, kind: 'system', text: `Campaign proposed: ${c.title} · ₦${(c.amountKobo / 100).toLocaleString('en-NG')}` },
        });
      }
      return c;
    });
    await this.notifications.notify(match.creatorId, {
      kind: 'agreement',
      title: 'Campaign agreement ready',
      body: `Review the terms for “${campaign.title}”.`,
      linkTo: `/campaign-agreement/${match.id}`,
    });
    return this.detail({ id: brandId, role: 'BRAND' }, campaign.id);
  }

  /** Editing terms bumps the version and clears the other party's acceptance (re-agreement required). */
  async editTerms(u: AuthUser, id: string, input: TermsInput) {
    const c = await this.owned(u, id);
    if (!EDITABLE.includes(c.status)) throw new ConflictException('Terms are locked once funding starts');
    const pendingFunding = await this.prisma.transaction.findFirst({ where: { campaignId: id, kind: 'FUNDING', status: { not: 'failed' } } });
    if (pendingFunding) throw new ConflictException('Funding already started for these terms');

    const feeBps = await this.settings.number('platformFeeBps');
    await this.prisma.$transaction(async (tx) => {
      if (c.status === 'awaiting_funding') await this.sm.transition(id, 'pending_agreement', { actorId: u.id, tx });
      await tx.deliverableRequirement.deleteMany({ where: { campaignId: id } });
      await tx.campaign.update({
        where: { id },
        data: {
          ...termsData(input, feeBps),
          termsVersion: { increment: 1 },
          brandAcceptedAt: u.role === 'BRAND' ? new Date() : null,
          creatorAcceptedAt: u.role === 'CREATOR' ? new Date() : null,
          requirements: { create: requirementsData(input) },
        },
      });
      await tx.auditLog.create({ data: { actorId: u.id, action: 'campaign.terms_edited', entity: 'Campaign', entityId: id } });
    });
    const other = u.role === 'BRAND' ? c.creatorId : c.brandId;
    await this.notifications.notify(other, { kind: 'agreement', title: 'Terms updated', body: `“${input.title}” terms changed. Please review.`, linkTo: `/campaign-agreement/${c.matchId}` });
    return this.detail(u, id);
  }

  /** Both parties must accept the *same* terms version; then the campaign awaits funding. */
  async accept(u: AuthUser, id: string, termsVersion: number) {
    const c = await this.owned(u, id);
    if (c.status !== 'pending_agreement') throw wrongStage(c.status);
    if (c.termsVersion !== termsVersion) throw new ConflictException('Terms changed; review the latest version');

    const updated = await this.prisma.campaign.update({
      where: { id },
      data: u.role === 'BRAND' ? { brandAcceptedAt: new Date() } : { creatorAcceptedAt: new Date() },
    });
    await this.prisma.auditLog.create({ data: { actorId: u.id, action: 'campaign.accepted', entity: 'Campaign', entityId: id, meta: { termsVersion } } });
    if (updated.brandAcceptedAt && updated.creatorAcceptedAt) {
      await this.sm.transition(id, 'awaiting_funding', { actorId: u.id });
      await this.notifications.notify(c.brandId, { kind: 'funding', title: 'Agreement signed', body: `Fund “${c.title}” so the creator can start.`, linkTo: `/campaigns/${id}` });
    }
    return this.detail(u, id);
  }

  async start(u: AuthUser, id: string) {
    const c = await this.owned(u, id);
    if (u.id !== c.creatorId) throw new ForbiddenException({ message: 'Only the creator can do that.', code: ErrorCode.Forbidden });
    await this.sm.transition(id, 'in_progress', { actorId: u.id });
    return this.detail(u, id);
  }

  list(u: AuthUser, status?: CampaignStatus) {
    return this.prisma.campaign.findMany({
      where: { ...(u.role === 'BRAND' ? { brandId: u.id } : u.role === 'CREATOR' ? { creatorId: u.id } : {}), ...(status && { status }) },
      include: { requirements: { orderBy: { position: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async detail(u: AuthUser, id: string) {
    await this.owned(u, id);
    const c = await this.prisma.campaign.findUniqueOrThrow({
      where: { id },
      include: {
        requirements: { orderBy: { position: 'asc' } },
        submissions: { orderBy: { createdAt: 'desc' }, include: { verifications: { orderBy: { startedAt: 'desc' } } } },
        transactions: { orderBy: { createdAt: 'asc' }, omit: { providerResponse: true } },
        disputes: true,
      },
    });
    const history = await this.prisma.auditLog.findMany({ where: { entity: 'Campaign', entityId: id }, orderBy: { createdAt: 'asc' } });
    return { ...c, totalPayableKobo: c.amountKobo + c.feeKobo, history };
  }

  /** Loads the campaign and enforces that the caller is a party to it (admins may read all). */
  async owned(u: AuthUser, id: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Campaign not found');
    if (u.role !== 'ADMIN' && c.brandId !== u.id && c.creatorId !== u.id) throw new NotFoundException('Campaign not found');
    return c;
  }
}
