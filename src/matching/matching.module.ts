import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { OnboardedGuard } from '../common/onboarded.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toCreatorCard } from '../profiles/creator.mapper.js';

const respondSchema = z.object({ accept: z.boolean() });
const messageSchema = z.object({ text: z.string().trim().min(1).max(4000) });

@Injectable()
export class MatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Creator: incoming pending interests. Brand: interests it sent. Expired ones are hidden lazily. */
  async interests(u: AuthUser) {
    const rows = await this.prisma.interest.findMany({
      where: u.role === 'CREATOR' ? { creatorId: u.id, status: 'PENDING', expiresAt: { gt: new Date() } } : { brandId: u.id },
      orderBy: { createdAt: 'desc' },
    });
    const brands = await this.prisma.brandProfile.findMany({ where: { userId: { in: rows.map((r) => r.brandId) } } });
    const creators = await this.prisma.creatorProfile.findMany({
      where: { userId: { in: rows.map((r) => r.creatorId) } },
      include: { socials: true },
    });
    return rows.map((r) => ({
      ...r,
      status: r.status === 'PENDING' && r.expiresAt < new Date() ? 'EXPIRED' : r.status,
      brand: brands.find((b) => b.userId === r.brandId),
      creator: creators.find((c) => c.userId === r.creatorId) && toCreatorCard(creators.find((c) => c.userId === r.creatorId)!),
    }));
  }

  async respond(creatorId: string, interestId: string, accept: boolean) {
    const interest = await this.prisma.interest.findUnique({ where: { id: interestId } });
    if (!interest || interest.creatorId !== creatorId) throw new NotFoundException('Interest not found');
    if (interest.status !== 'PENDING') throw new ConflictException(`Interest already ${interest.status.toLowerCase()}`);
    if (interest.expiresAt < new Date()) {
      await this.prisma.interest.update({ where: { id: interestId }, data: { status: 'EXPIRED' } });
      throw new ConflictException('Interest expired');
    }

    if (!accept) {
      await this.prisma.interest.update({ where: { id: interestId }, data: { status: 'DECLINED' } });
      return { match: null };
    }

    // Match is unique per brand+creator, so a double tap cannot create two.
    const match = await this.prisma.$transaction(async (tx) => {
      await tx.interest.update({ where: { id: interestId }, data: { status: 'ACCEPTED' } });
      const m = await tx.match.upsert({
        where: { brandId_creatorId: { brandId: interest.brandId, creatorId } },
        create: {
          brandId: interest.brandId,
          creatorId,
          conversation: { create: { messages: { create: { kind: 'system', text: "It's a match! Say hello and talk about the campaign." } } } },
        },
        update: {},
        include: { conversation: true },
      });
      return m;
    });
    const creator = await this.prisma.creatorProfile.findUnique({ where: { userId: creatorId } });
    await this.notifications.notify(interest.brandId, {
      kind: 'match',
      title: "It's a match",
      body: `${creator?.displayName ?? 'A creator'} accepted your interest.`,
      linkTo: `/chat/${match.conversation!.id}`,
    });
    this.notifications.emit(creatorId, 'match', match);
    this.notifications.emit(interest.brandId, 'match', match);
    return { match };
  }

  async matches(u: AuthUser) {
    const rows = await this.prisma.match.findMany({
      where: u.role === 'BRAND' ? { brandId: u.id } : { creatorId: u.id },
      include: {
        conversation: { include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        campaigns: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const brands = await this.prisma.brandProfile.findMany({ where: { userId: { in: rows.map((r) => r.brandId) } } });
    const creators = await this.prisma.creatorProfile.findMany({
      where: { userId: { in: rows.map((r) => r.creatorId) } },
      include: { socials: true },
    });
    return rows.map(({ conversation, campaigns, ...m }) => {
      const c = creators.find((x) => x.userId === m.creatorId);
      return {
        ...m,
        conversationId: conversation?.id,
        lastMessage: conversation?.messages[0] ?? null,
        campaign: campaigns[0] ?? null,
        brand: brands.find((b) => b.userId === m.brandId),
        creator: c && toCreatorCard(c),
      };
    });
  }

  /** Only the two matched parties may read or write a conversation (PRD Module 4). */
  async assertMember(userId: string, conversationId: string) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: { match: true } });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (conv.match.brandId !== userId && conv.match.creatorId !== userId) throw new ForbiddenException('Not a member of this match');
    return conv;
  }

  async messages(userId: string, conversationId: string, before?: string) {
    await this.assertMember(userId, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId, ...(before && { createdAt: { lt: new Date(before) } }) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async send(userId: string, conversationId: string, text: string) {
    const conv = await this.assertMember(userId, conversationId);
    const message = await this.prisma.message.create({ data: { conversationId, senderId: userId, text } });
    const other = conv.match.brandId === userId ? conv.match.creatorId : conv.match.brandId;
    this.notifications.emit(userId, 'message', message);
    this.notifications.emit(other, 'message', message);
    return message;
  }
}

@Controller()
@UseGuards(OnboardedGuard)
class MatchingController {
  constructor(private readonly matching: MatchingService) {}

  @Get('interests')
  interests(@CurrentUser() u: AuthUser) {
    return this.matching.interests(u);
  }

  @Roles('CREATOR')
  @Post('interests/:id/respond')
  respond(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(respondSchema)) b: z.infer<typeof respondSchema>,
  ) {
    return this.matching.respond(u.id, id, b.accept);
  }

  @Get('matches')
  matches(@CurrentUser() u: AuthUser) {
    return this.matching.matches(u);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('before') before?: string) {
    return this.matching.messages(u.id, id, before);
  }

  @Post('conversations/:id/messages')
  send(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(messageSchema)) b: z.infer<typeof messageSchema>,
  ) {
    return this.matching.send(u.id, id, b.text);
  }
}

@Module({ controllers: [MatchingController], providers: [MatchingService], exports: [MatchingService] })
export class MatchingModule {}
