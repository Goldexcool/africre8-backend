import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
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

  /**
   * Incoming (to answer) and outgoing (waiting) invitations/applications for the caller, each with
   * the brief it belongs to. Expired ones are flagged lazily.
   */
  async interests(u: AuthUser) {
    const mine = u.role === 'CREATOR' ? { creatorId: u.id } : { brandId: u.id };
    const rows = await this.prisma.interest.findMany({
      where: mine,
      include: { opportunity: { select: { id: true, title: true, budgetKobo: true, visibility: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const brands = await this.prisma.brandProfile.findMany({ where: { userId: { in: rows.map((r) => r.brandId) } } });
    const creators = await this.prisma.creatorProfile.findMany({
      where: { userId: { in: rows.map((r) => r.creatorId) } },
      include: { socials: true },
    });
    return rows.map((r) => {
      const c = creators.find((x) => x.userId === r.creatorId);
      return {
        ...r,
        direction: r.senderId === u.id ? 'outgoing' : 'incoming',
        kind: r.senderId === r.brandId ? 'invitation' : 'application',
        status: r.status === 'PENDING' && r.expiresAt < new Date() ? 'EXPIRED' : r.status,
        brand: brands.find((b) => b.userId === r.brandId),
        creator: c && toCreatorCard(c),
      };
    });
  }

  /** The receiver answers: creators answer invitations, brands answer applications. */
  async respond(userId: string, interestId: string, accept: boolean) {
    const interest = await this.prisma.interest.findUnique({ where: { id: interestId }, include: { opportunity: true } });
    const isParty = interest && (interest.brandId === userId || interest.creatorId === userId);
    if (!interest || !isParty) throw new NotFoundException('Invitation not found');
    if (interest.senderId === userId) throw new ConflictException('Waiting for the other side to respond');
    if (interest.status !== 'PENDING') throw new ConflictException(`Already ${interest.status.toLowerCase()}`);
    if (interest.expiresAt < new Date()) {
      await this.prisma.interest.update({ where: { id: interestId }, data: { status: 'EXPIRED' } });
      throw new ConflictException('This invitation expired');
    }

    if (!accept) {
      await this.prisma.interest.update({ where: { id: interestId }, data: { status: 'DECLINED' } });
      await this.notifications.notify(interest.senderId, {
        kind: 'interest',
        title: 'Not this time',
        body: interest.opportunity ? `Your ${interest.senderId === interest.brandId ? 'invitation' : 'application'} for “${interest.opportunity.title}” was declined.` : 'Your invitation was declined.',
      });
      return { match: null };
    }

    const { brandId, creatorId } = interest;
    const title = interest.opportunity?.title;
    // One connection (and conversation) per brand–creator pair, however many briefs they meet over.
    const match = await this.prisma.$transaction(async (tx) => {
      await tx.interest.update({ where: { id: interestId }, data: { status: 'ACCEPTED' } });
      const m = await tx.match.upsert({
        where: { brandId_creatorId: { brandId, creatorId } },
        create: { brandId, creatorId, opportunityId: interest.opportunityId, conversation: { create: {} } },
        update: {},
        include: { conversation: true },
      });
      const conversationId = m.conversation!.id;
      await tx.message.create({
        data: { conversationId, kind: 'system', text: title ? `Connected for “${title}”. Agree the terms here.` : 'You are connected. Agree the campaign terms here.' },
      });
      // The invitation/application note becomes the first message in the thread.
      if (interest.message) await tx.message.create({ data: { conversationId, senderId: interest.senderId, text: interest.message } });
      return m;
    });
    const responder = userId === creatorId
      ? (await this.prisma.creatorProfile.findUnique({ where: { userId: creatorId } }))?.displayName
      : (await this.prisma.brandProfile.findUnique({ where: { userId: brandId } }))?.businessName;
    await this.notifications.notify(interest.senderId, {
      kind: 'match',
      title: 'Invitation accepted',
      body: `${responder ?? 'They'} accepted${title ? ` for “${title}”` : ''}. Start the conversation.`,
      linkTo: `/chat/${match.conversation!.id}`,
    });
    this.notifications.emit(creatorId, 'match', match);
    this.notifications.emit(brandId, 'match', match);
    return { match };
  }

  /** Connections for the inbox: counterpart, brief it came from, latest campaign stage, last message, unread. */
  async matches(u: AuthUser) {
    const brandSide = u.role === 'BRAND';
    const rows = await this.prisma.match.findMany({
      where: brandSide ? { brandId: u.id } : { creatorId: u.id },
      include: {
        conversation: { include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        campaigns: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, title: true, amountKobo: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const brands = await this.prisma.brandProfile.findMany({ where: { userId: { in: rows.map((r) => r.brandId) } } });
    const creators = await this.prisma.creatorProfile.findMany({ where: { userId: { in: rows.map((r) => r.creatorId) } }, include: { socials: true } });
    const opps = await this.prisma.opportunity.findMany({
      where: { id: { in: rows.map((r) => r.opportunityId).filter((x): x is string => !!x) } },
      select: { id: true, title: true, status: true },
    });
    const unread = await Promise.all(
      rows.map((r) => {
        const conv = r.conversation;
        if (!conv) return Promise.resolve(0);
        const readAt = brandSide ? conv.brandReadAt : conv.creatorReadAt;
        return this.prisma.message.count({
          where: { conversationId: conv.id, kind: 'text', senderId: { not: u.id }, ...(readAt && { createdAt: { gt: readAt } }) },
        });
      }),
    );
    return rows.map(({ conversation, campaigns, ...m }, i) => {
      const c = creators.find((x) => x.userId === m.creatorId);
      return {
        ...m,
        conversationId: conversation?.id,
        lastMessage: conversation?.messages[0] ?? null,
        unread: unread[i],
        opportunity: opps.find((o) => o.id === m.opportunityId) ?? null,
        campaign: campaigns[0] ?? null,
        brand: brands.find((b) => b.userId === m.brandId),
        creator: c && toCreatorCard(c),
      };
    });
  }

  async markRead(userId: string, conversationId: string) {
    const conv = await this.assertMember(userId, conversationId);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: conv.match.brandId === userId ? { brandReadAt: new Date() } : { creatorReadAt: new Date() },
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

  @Roles('CREATOR', 'BRAND')
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

  @HttpCode(204)
  @Post('conversations/:id/read')
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.matching.markRead(u.id, id);
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
