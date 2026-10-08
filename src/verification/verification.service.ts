import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CampaignStateMachine } from '../campaigns/state-machine.js';
import type { Prisma, Verdict } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QUEUES } from '../queue/queue.module.js';
import { analyzeContent, transcribe } from './analyze.js';
import { detectPlatform, extractMedia, fetchMetadata } from './content.js';

type Check = { label: string; passed: boolean | null; kind: 'objective' | 'ai'; confidence?: number; evidence?: string };
const norm = (s?: string | null) => (s ?? '').replace(/^@/, '').trim().toLowerCase();
const SUBMITTABLE = ['funded', 'in_progress', 'revision_required'] as const;
const CONFIDENT = 0.6;

@Injectable()
export class VerificationService {
  private readonly log = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sm: CampaignStateMachine,
    private readonly notifications: NotificationsService,
    @InjectQueue(QUEUES.verification) private readonly queue: Queue,
  ) {}

  // ---------- Submission (API) ----------

  async submit(creatorId: string, campaignId: string, input: { requirementId: string; contentUrl: string; notes?: string; evidenceUrls?: string[] }) {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId }, include: { requirements: true } });
    if (!c || c.creatorId !== creatorId) throw new NotFoundException('Campaign not found');
    if (!(SUBMITTABLE as readonly string[]).includes(c.status)) throw new ConflictException(`Campaign is ${c.status}; work can't be submitted now`);
    const req = c.requirements.find((r) => r.id === input.requirementId);
    if (!req) throw new BadRequestException('Unknown deliverable');
    const platform = detectPlatform(input.contentUrl);
    if (req.platform && ['tiktok', 'youtube'].includes(req.platform) && platform !== req.platform) {
      throw new BadRequestException(`This deliverable needs a ${req.platform} link`);
    }

    const submission = await this.prisma.$transaction(async (tx) => {
      // Older submissions stay in history, marked superseded.
      await tx.submission.updateMany({ where: { requirementId: req.id, superseded: false }, data: { superseded: true } });
      return tx.submission.create({
        data: {
          campaignId,
          requirementId: req.id,
          contentUrl: input.contentUrl,
          notes: input.notes,
          evidenceUrls: input.evidenceUrls ?? [],
          late: new Date() > c.deadline,
        },
      });
    });
    await this.prisma.auditLog.create({
      data: { actorId: creatorId, action: 'submission.created', entity: 'Campaign', entityId: campaignId, meta: { submissionId: submission.id, requirement: req.title, late: submission.late } },
    });
    await this.queue.add('verify', { submissionId: submission.id }, { jobId: `verify-${submission.id}` });

    // Once every deliverable has a live submission, the campaign is submitted for review.
    const live = await this.prisma.submission.findMany({ where: { campaignId, superseded: false }, select: { requirementId: true } });
    if (c.requirements.every((r) => live.some((s) => s.requirementId === r.id))) {
      await this.sm.transition(campaignId, 'submitted', { actorId: creatorId });
      await this.notifications.notify(c.brandId, {
        kind: 'submission',
        title: c.status === 'revision_required' ? 'Revision submitted' : 'Creator submitted work',
        body: `“${c.title}” is being verified now.`,
        linkTo: `/campaigns/${campaignId}`,
      });
    }
    return submission;
  }

  async reverify(campaignId: string, submissionId: string) {
    const s = await this.prisma.submission.findFirst({ where: { id: submissionId, campaignId } });
    if (!s) throw new NotFoundException('Submission not found');
    await this.queue.add('verify', { submissionId }, { jobId: `verify-${submissionId}-${Date.now()}` });
    return { queued: true };
  }

  // ---------- Verification (worker) ----------

  async verify(submissionId: string) {
    const s = await this.prisma.submission.findUniqueOrThrow({
      where: { id: submissionId },
      include: { requirement: true, campaign: true },
    });
    const run = await this.prisma.verificationRun.create({ data: { submissionId } });
    this.notifications.emit(s.campaign.brandId, 'verification', { campaignId: s.campaignId, submissionId, status: 'running' });
    this.notifications.emit(s.campaign.creatorId, 'verification', { campaignId: s.campaignId, submissionId, status: 'running' });

    const checks: Check[] = [];
    let summary = '';
    let model: string | undefined;
    let evidence: Prisma.InputJsonValue = {};

    const platform = detectPlatform(s.contentUrl);
    if (!platform) {
      checks.push({ label: 'Link is a TikTok or YouTube post', passed: false, kind: 'objective' });
      summary = 'Automatic verification supports TikTok and YouTube links. A person needs to review this one.';
      return this.finish(run.id, s, 'NEEDS_REVIEW', checks, summary, evidence);
    }

    let meta;
    try {
      meta = await fetchMetadata(s.contentUrl);
    } catch (e) {
      checks.push({ label: 'Post is published and public', passed: false, kind: 'objective', evidence: (e as Error).message });
      return this.finish(run.id, s, 'FAIL', checks, 'The post could not be found. It may be private, deleted, or the link is wrong.', evidence);
    }
    checks.push({ label: 'Post is published and public', passed: true, kind: 'objective', evidence: `Found via ${meta.source}` });

    const social = await this.prisma.socialAccount.findUnique({ where: { creatorId_platform: { creatorId: s.campaign.creatorId, platform } } });
    if (social && meta.handle) {
      const ok = norm(meta.handle) === norm(social.handle) || norm(meta.author) === norm(social.handle);
      checks.push({ label: `Posted from @${norm(social.handle)}`, passed: ok, kind: 'objective', evidence: `Post account: @${norm(meta.handle)}` });
    } else {
      checks.push({ label: "Posted from the creator's account", passed: null, kind: 'objective', evidence: 'Account could not be confirmed automatically' });
    }

    if (meta.publishedAt) {
      // Small grace window: content may be posted the same day the terms were signed.
      const ok = new Date(meta.publishedAt).getTime() >= s.campaign.createdAt.getTime() - 864e5;
      checks.push({ label: 'Published after the agreement', passed: ok, kind: 'objective', evidence: `Published ${meta.publishedAt.slice(0, 10)}` });
    }

    const text = `${meta.caption}\n${meta.tags.map((t) => `#${t}`).join(' ')}`.toLowerCase();
    for (const tag of s.requirement.hashtags) checks.push({ label: `Uses ${tag}`, passed: text.includes(tag.toLowerCase()), kind: 'objective' });
    for (const m of s.requirement.mentions) checks.push({ label: `Mentions ${m}`, passed: text.includes(m.toLowerCase()), kind: 'objective' });

    const qualitative = [s.requirement.title, s.requirement.contentBrief].filter((x): x is string => Boolean(x));
    const { frames, audio, fromVideo } = await extractMedia(meta);
    const transcript = await transcribe(audio);
    const ai = await analyzeContent({ brief: s.campaign.brief, requirements: qualitative, meta, frames, transcript });
    if ('analysis' in ai) {
      model = ai.model;
      for (const c of ai.analysis.checks) {
        checks.push({ label: c.requirement, passed: c.passed, kind: 'ai', confidence: c.confidence, evidence: c.evidence });
      }
      summary = ai.analysis.summary;
    } else {
      checks.push({ label: 'Content matches the brief', passed: null, kind: 'ai', evidence: ai.error });
      summary = `${ai.error}. A person needs to check the content against the brief.`;
    }

    evidence = {
      transcript: transcript.slice(0, 8000),
      metadata: { ...meta, caption: meta.caption.slice(0, 2000) },
      stats: { views: meta.views, likes: meta.likes, comments: meta.comments, shares: meta.shares },
      frames: frames.slice(0, 6).map((f) => `data:image/jpeg;base64,${f}`),
      framesFromVideo: fromVideo,
      checkedAt: new Date().toISOString(),
    };
    return this.finish(run.id, s, verdictFor(checks), checks, summary, evidence, model);
  }

  private async finish(
    runId: string,
    s: { id: string; campaignId: string; campaign: { brandId: string; creatorId: string; title: string } },
    verdict: Verdict,
    checks: Check[],
    summary: string,
    evidence: Prisma.InputJsonValue,
    model?: string,
  ) {
    await this.prisma.verificationRun.update({
      where: { id: runId },
      data: { verdict, checks: checks as unknown as Prisma.InputJsonValue, summary, evidence, model, finishedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: { action: 'verification.finished', entity: 'Campaign', entityId: s.campaignId, toState: verdict, meta: { submissionId: s.id, runId, model } },
    });
    const payload = { campaignId: s.campaignId, submissionId: s.id, status: 'done', verdict };
    this.notifications.emit(s.campaign.brandId, 'verification', payload);
    this.notifications.emit(s.campaign.creatorId, 'verification', payload);
    await this.maybeReadyForReview(s.campaignId);
    return { verdict, checks, summary };
  }

  /** submitted → under_review once every live submission has a finished verification run. */
  async maybeReadyForReview(campaignId: string) {
    const c = await this.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (c.status !== 'submitted') return;
    const live = await this.prisma.submission.findMany({
      where: { campaignId, superseded: false },
      include: { verifications: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    if (!live.every((x) => x.verifications[0]?.finishedAt)) return;
    try {
      await this.sm.transition(campaignId, 'under_review');
    } catch (e) {
      this.log.debug(`under_review skipped: ${(e as Error).message}`); // concurrent job already moved it
      return;
    }
    await this.notifications.notify(c.brandId, { kind: 'review', title: 'Ready for approval', body: `Verification finished for “${c.title}”. Review and approve to release payment.`, linkTo: `/campaigns/${campaignId}` });
  }
}

/** PRD verdicts. Objective account/publish failures are FAIL; anything uncertain goes to a human. */
export function verdictFor(checks: Check[]): Verdict {
  const blocking = checks.filter((c) => c.kind === 'objective' && /published and public|Posted from @/.test(c.label));
  if (blocking.some((c) => c.passed === false)) return 'FAIL';
  if (checks.some((c) => c.passed === null || (c.kind === 'ai' && (c.confidence ?? 0) < CONFIDENT))) return 'NEEDS_REVIEW';
  const failed = checks.filter((c) => c.passed === false).length;
  if (!failed) return 'PASS';
  return failed >= checks.length / 2 ? 'FAIL' : 'PARTIAL';
}
