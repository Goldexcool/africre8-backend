import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { toCreatorCard } from './creator.mapper.js';
import type { BrandInput, CreatorInput, PayoutInput } from './profiles.schemas.js';

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertCreator(userId: string, { socials, ...input }: CreatorInput) {
    const data = {
      ...input,
      priceFromKobo: input.priceFromNgn !== undefined ? Math.round(input.priceFromNgn * 100) : undefined,
      priceToKobo: input.priceToNgn !== undefined ? Math.round(input.priceToNgn * 100) : undefined,
      priceFromNgn: undefined,
      priceToNgn: undefined,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.creatorProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      if (socials) {
        await tx.socialAccount.deleteMany({ where: { creatorId: userId } });
        await tx.socialAccount.createMany({ data: socials.map((s) => ({ ...s, creatorId: userId })) });
      }
      // Creator is onboarded once the profile basics and at least one social exist.
      const p = await tx.creatorProfile.findUniqueOrThrow({ where: { userId }, include: { socials: true } });
      if (p.displayName && p.category && p.location && p.socials.length) {
        await tx.user.updateMany({ where: { id: userId, onboardedAt: null }, data: { onboardedAt: new Date() } });
      }
    });
    return this.creatorCard(userId);
  }

  async upsertBrand(userId: string, input: BrandInput) {
    const p = await this.prisma.brandProfile.upsert({ where: { userId }, create: { userId, ...input }, update: input });
    if (p.businessName && p.industry) {
      await this.prisma.user.updateMany({ where: { id: userId, onboardedAt: null }, data: { onboardedAt: new Date() } });
    }
    return p;
  }

  setPayoutDestination(userId: string, input: PayoutInput) {
    return this.prisma.payoutDestination.upsert({ where: { userId }, create: { userId, ...input }, update: input });
  }

  async creatorCard(userId: string) {
    const p = await this.prisma.creatorProfile.findUnique({ where: { userId }, include: { socials: true } });
    if (!p) throw new NotFoundException('Creator not found');
    return toCreatorCard(p);
  }

  async brand(userId: string) {
    const p = await this.prisma.brandProfile.findUnique({ where: { userId } });
    if (!p) throw new NotFoundException('Brand not found');
    return p;
  }
}
