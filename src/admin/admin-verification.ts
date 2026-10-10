import { Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VerificationService } from '../verification/verification.service.js';
import { AdminAccess } from './access.js';
import { audit, pageQuery, people } from './common.js';

const listQuery = z.object({
  /** `review` = needs a person (NEEDS_REVIEW or FAIL) and not decided yet. */
  view: z.enum(['review', 'decided', 'all']).default('review'),
  verdict: z.enum(['PASS', 'PARTIAL', 'FAIL', 'NEEDS_REVIEW']).optional(),
  campaignId: z.string().uuid().optional(),
  ...pageQuery,
});
type ListQuery = z.infer<typeof listQuery>;

const decisionSchema = z.object({ decision: z.enum(['accept', 'reject', 'revision']), note: z.string().trim().min(5, 'Write a short note (at least 5 characters).').max(1000) });
type DecisionInput = z.infer<typeof decisionSchema>;

const DECISION_TEXT = { accept: 'looks fine', reject: 'does not meet the brief', revision: 'needs changes' } as const;

@Injectable()
export class AdminVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: VerificationService,
    private readonly notifications: NotificationsService,
    private readonly access: AdminAccess,
  ) {}

  /** Runs a person should look at: NEEDS_REVIEW and FAIL, oldest first. The large frames and transcripts are left out of the list. */
  async list(q: ListQuery) {
    const where: Prisma.VerificationRunWhereInput = {
      finishedAt: { not: null },
      ...(q.verdict ? { verdict: q.verdict } : q.view === 'review' ? { verdict: { in: ['NEEDS_REVIEW', 'FAIL'] } } : {}),
      ...(q.view === 'review' ? { reviewDecision: null } : q.view === 'decided' ? { reviewDecision: { not: null } } : {}),
      ...(q.campaignId ? { submission: { campaignId: q.campaignId } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.verificationRun.count({ where }),
      this.prisma.verificationRun.findMany({
        where,
        orderBy: { startedAt: q.view === 'review' ? 'asc' : 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        omit: { evidence: true },
        include: { submission: { select: { id: true, contentUrl: true, campaignId: true, requirement: { select: { title: true, platform: true } }, campaign: { select: { title: true, status: true, brandId: true, creatorId: true } } } } },
      }),
    ]);
    const who = await people(this.prisma, rows.flatMap((r) => [r.submission.campaign.brandId, r.submission.campaign.creatorId, r.reviewedById]));
    const items = rows.map((r) => ({
      id: r.id,
      verdict: r.verdict,
      summary: r.summary,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
      reviewDecision: r.reviewDecision,
      reviewedAt: r.reviewedAt,
      reviewedBy: r.reviewedById ? (who.get(r.reviewedById) ?? null) : null,
      submission: { id: r.submission.id, contentUrl: r.submission.contentUrl, requirement: r.submission.requirement },
      campaign: { id: r.submission.campaignId, title: r.submission.campaign.title, status: r.submission.campaign.status },
      brand: who.get(r.submission.campaign.brandId) ?? null,
      creator: who.get(r.submission.campaign.creatorId) ?? null,
    }));
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** One run with everything a reviewer needs: the post, the checks, the frames and transcript, and the campaign's brief. */
  async detail(id: string) {
    const run = await this.prisma.verificationRun.findUnique({
      where: { id },
      include: { submission: { include: { requirement: true, campaign: { select: { id: true, title: true, brief: true, status: true, brandId: true, creatorId: true } } } } },
    });
    if (!run) throw new NotFoundException('Verification run not found');
    const who = await people(this.prisma, [run.submission.campaign.brandId, run.submission.campaign.creatorId, run.reviewedById]);
    const others = await this.prisma.verificationRun.findMany({ where: { submissionId: run.submissionId, id: { not: id } }, orderBy: { startedAt: 'desc' }, omit: { evidence: true } });
    return {
      run: {
        id: run.id,
        verdict: run.verdict,
        summary: run.summary,
        checks: run.checks,
        evidence: run.evidence,
        model: run.model,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        reviewDecision: run.reviewDecision,
        reviewNote: run.reviewNote,
        reviewedAt: run.reviewedAt,
        reviewedBy: run.reviewedById ? (who.get(run.reviewedById) ?? null) : null,
      },
      submission: { id: run.submission.id, contentUrl: run.submission.contentUrl, notes: run.submission.notes, evidenceUrls: run.submission.evidenceUrls, late: run.submission.late, superseded: run.submission.superseded, createdAt: run.submission.createdAt, requirement: run.submission.requirement },
      campaign: { id: run.submission.campaign.id, title: run.submission.campaign.title, brief: run.submission.campaign.brief, status: run.submission.campaign.status },
      brand: who.get(run.submission.campaign.brandId) ?? null,
      creator: who.get(run.submission.campaign.creatorId) ?? null,
      otherRuns: others,
    };
  }

  /**
   * Records a person's decision on a run. Record only: the campaign does not move; the brand still approves or asks for a
   * revision, and sees this note. Both parties are told. One decision per run.
   */
  async decide(adminId: string, id: string, input: DecisionInput) {
    await this.access.need(adminId, 'verification');
    const run = await this.prisma.verificationRun.findUnique({ where: { id }, include: { submission: { include: { campaign: { select: { id: true, title: true, brandId: true, creatorId: true } } } } } });
    if (!run) throw new NotFoundException('Verification run not found');
    if (!run.finishedAt) throw new ConflictException('This check is still running.');
    const claimed = await this.prisma.verificationRun.updateMany({ where: { id, reviewDecision: null }, data: { reviewDecision: input.decision, reviewNote: input.note, reviewedById: adminId, reviewedAt: new Date() } });
    if (claimed.count !== 1) throw new ConflictException('A decision was already recorded for this check.');
    await audit(this.prisma, adminId, 'verification.reviewed', 'Campaign', run.submission.campaignId, { runId: id, decision: input.decision });
    const c = run.submission.campaign;
    const text = `AfiCre8 reviewed the post for “${c.title}”: it ${DECISION_TEXT[input.decision]}. ${input.note.slice(0, 120)}`;
    for (const userId of [c.brandId, c.creatorId]) await this.notifications.notify(userId, { kind: 'review', title: 'Post reviewed by AfiCre8', body: text, linkTo: `/campaigns/${c.id}` });
    return this.detail(id);
  }

  async rerun(adminId: string, id: string) {
    await this.access.need(adminId, 'verification');
    const run = await this.prisma.verificationRun.findUnique({ where: { id }, include: { submission: { select: { id: true, campaignId: true, superseded: true } } } });
    if (!run) throw new NotFoundException('Verification run not found');
    if (run.submission.superseded) throw new ConflictException('A newer submission replaced this one.');
    await audit(this.prisma, adminId, 'verification.rerun', 'Campaign', run.submission.campaignId, { runId: id });
    return this.verification.reverify(run.submission.campaignId, run.submission.id);
  }
}

@Roles('ADMIN')
@Controller('admin/verifications')
export class AdminVerificationController {
  constructor(private readonly svc: AdminVerificationService) {}

  @Get() list(@Query(new ZodPipe(listQuery)) q: ListQuery) { return this.svc.list(q); }
  @Get(':id') detail(@Param('id', ParseUUIDPipe) id: string) { return this.svc.detail(id); }
  @Post(':id/decision') decide(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decisionSchema)) b: DecisionInput) { return this.svc.decide(a.id, id, b); }
  @Post(':id/rerun') rerun(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.rerun(a.id, id); }
}
