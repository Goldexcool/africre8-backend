import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

type Emitter = (userId: string, event: string, payload: unknown) => void;

@Injectable()
export class NotificationsService {
  private emitter: Emitter = () => {};

  constructor(private readonly prisma: PrismaService) {}

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
    return row;
  }

  list(userId: string) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  markRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  }
}
