import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const EMAILED = new Set(['agreement', 'funding', 'payout', 'dispute', 'review']);

type Emitter = (userId: string, event: string, payload: unknown) => void;
export type Push = { title: string; body: string; linkTo?: string };
type Ticket = { status: 'ok' | 'error'; details?: { error?: string } };

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  private emitter: Emitter = () => {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** The socket gateway registers itself here so services can push without a circular import. */
  setEmitter(fn: Emitter) {
    this.emitter = fn;
  }

  emit(userId: string, event: string, payload: unknown) {
    this.emitter(userId, event, payload);
  }

  async notify(userId: string, n: { kind: string; title: string; body: string; linkTo?: string }) {
    const row = await this.prisma.notification.create({ data: { userId, ...n } });
    this.emitter(userId, 'notification', row);
    void this.push(userId, n);
    if (EMAILED.has(n.kind)) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (user) void this.mail.send({ to: user.email, subject: n.title, heading: n.title, body: n.body });
    }
    return row;
  }

  /**
   * Push to every device the user is signed in on, through Expo's push service. Best effort: the in-app inbox is the
   * source of truth. Tokens Expo reports as no longer registered (app uninstalled) are dropped.
   * ponytail: reads send tickets only, not delivery receipts; add a receipt check if silent drops ever matter.
   */
  async push(userId: string, p: Push) {
    try {
      const tokens = await this.prisma.pushToken.findMany({ where: { userId }, select: { token: true } });
      if (!tokens.length) return;
      const res = await fetch(EXPO_PUSH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(process.env.EXPO_ACCESS_TOKEN && { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }),
        },
        body: JSON.stringify(tokens.map(({ token }) => ({ to: token, title: p.title, body: p.body, sound: 'default', channelId: 'default', data: { linkTo: p.linkTo ?? null } }))),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return this.log.warn(`Expo push ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const { data } = (await res.json()) as { data: Ticket[] };
      const gone = staleTokens(tokens.map((t) => t.token), data);
      if (gone.length) await this.prisma.pushToken.deleteMany({ where: { token: { in: gone } } });
    } catch (e) {
      this.log.warn(`push to ${userId} failed: ${(e as Error).message}`);
    }
  }

  /** A device signs in: its token now belongs to this user (whoever used it before stops getting its pushes). */
  savePushToken(userId: string, token: string, platform: string) {
    return this.prisma.pushToken.upsert({ where: { token }, create: { token, userId, platform }, update: { userId, platform } });
  }

  removePushToken(userId: string, token: string) {
    return this.prisma.pushToken.deleteMany({ where: { token, userId } });
  }

  list(userId: string) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  markRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  }
}

/** Tokens whose send ticket says the app is gone from that device. Tickets come back in the order the messages were sent. */
export const staleTokens = (tokens: string[], tickets: Ticket[]) =>
  tokens.filter((_, i) => tickets[i]?.status === 'error' && tickets[i]?.details?.error === 'DeviceNotRegistered');
