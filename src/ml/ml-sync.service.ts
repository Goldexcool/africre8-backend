import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Platform } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  OPERATIONAL_ML_NAMESPACE,
  mapOperationalCreator,
  mapOperationalOpportunity,
  platformFromDeliverable,
} from './operational-profile.js';

/**
 * Keeps the ML features of the app's own creators and briefs in step with what they save, so recommendations work
 * for new briefs and new creators without a batch run. Profiles from another namespace (imported/synthetic data)
 * are never touched. Best effort: a sync failure is logged and never fails the save that triggered it.
 */
@Injectable()
export class MlSyncService {
  private readonly log = new Logger(MlSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async syncCreator(userId: string) {
    try {
      const creator = await this.prisma.creatorProfile.findUnique({ where: { userId }, include: { socials: true, mlProfile: true } });
      if (!creator || this.foreign(creator.mlProfile)) return;
      const mapped = mapOperationalCreator(creator);
      if (creator.mlProfile?.sourceRecordHash === mapped.sourceHash) return;
      const data = { ...mapped.scalar, commercialExperience: Prisma.DbNull }; // Prisma refuses a bare null for Json columns
      await this.prisma.$transaction(async (tx) => {
        const ml = await tx.creatorMlProfile.upsert({ where: { creatorId: userId }, create: { creatorId: userId, ...data }, update: data });
        // replace, not upsert: a platform the creator removed must stop counting
        await tx.creatorDeliverableCapability.deleteMany({ where: { creatorMlProfileId: ml.id } });
        await tx.creatorCommercialRate.deleteMany({ where: { creatorMlProfileId: ml.id } });
        if (mapped.capabilities.length)
          await tx.creatorDeliverableCapability.createMany({ data: mapped.capabilities.map((c) => ({ creatorMlProfileId: ml.id, format: c.format, platform: c.platform as Platform })) });
        if (mapped.rates.length)
          await tx.creatorCommercialRate.createMany({ data: mapped.rates.map((r) => ({ creatorMlProfileId: ml.id, ...r, platform: r.platform as Platform })) });
      });
    } catch (e) {
      this.log.warn(`creator ${userId}: ${(e as Error).message}`);
    }
  }

  /**
   * A brief gets ML features when at least one deliverable names its platform ("1 TikTok video"). Other lines
   * ("Tag @brand", "Use #launch") are notes, not deliverables. Returns why a brief has none, or null.
   */
  async syncOpportunity(opportunityId: string): Promise<string | null> {
    try {
      const o = await this.prisma.opportunity.findUnique({ where: { id: opportunityId }, include: { mlProfile: true } });
      if (!o || this.foreign(o.mlProfile)) return null;
      const deliverables = o.deliverables.filter((d) => platformFromDeliverable(d));
      if (!deliverables.length) {
        if (o.mlProfile) await this.prisma.opportunityMlProfile.delete({ where: { opportunityId } });
        return NO_PLATFORM;
      }
      const brand = await this.prisma.brandProfile.findUnique({ where: { userId: o.brandId }, select: { industry: true } });
      const mapped = mapOperationalOpportunity({ ...o, deliverables, brandIndustry: brand?.industry });
      if ('conflict' in mapped) return NO_PLATFORM;
      if (o.mlProfile?.sourceRecordHash === mapped.sourceHash) return null;
      const data = { ...mapped.scalar, requiredPlatforms: mapped.scalar.requiredPlatforms as Platform[], preferredPlatforms: [] as Platform[], brandSnapshot: mapped.scalar.brandSnapshot ?? Prisma.DbNull };
      await this.prisma.opportunityMlProfile.upsert({ where: { opportunityId }, create: { opportunityId, ...data }, update: data });
      return null;
    } catch (e) {
      this.log.warn(`opportunity ${opportunityId}: ${(e as Error).message}`);
      return null;
    }
  }

  private foreign(ml: { namespace: string; synthetic: boolean } | null) {
    return !!ml && (ml.namespace !== OPERATIONAL_ML_NAMESPACE || ml.synthetic);
  }
}

export const NO_PLATFORM =
  'Name the platform in at least one deliverable (TikTok, Instagram, YouTube, X or Facebook), like "1 TikTok video", to get recommendations.';
