import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { MatchingService } from '../matching/matching.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';

const sendSchema = z.object({ conversationId: z.string().uuid(), text: z.string().trim().min(1).max(4000) });
const typingSchema = z.object({ conversationId: z.string().uuid() });

export const userRoom = (id: string) => `user:${id}`;

/**
 * One room per user. Every server event (message, match, notification, campaign update) is pushed to
 * the recipients' user rooms, so membership checks happen once, in the services, not in socket rooms.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly log = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly notifications: NotificationsService,
    private readonly matching: MatchingService,
  ) {}

  afterInit(server: Server) {
    this.notifications.setEmitter((userId, event, payload) => server.to(userRoom(userId)).emit(event, payload));
  }

  async handleConnection(socket: Socket) {
    const token = socket.handshake.auth?.token ?? /^Bearer (.+)$/.exec(socket.handshake.headers.authorization ?? '')?.[1];
    try {
      const { sub } = await this.jwt.verifyAsync<{ sub: string }>(token);
      socket.data.userId = sub;
      await socket.join(userRoom(sub));
    } catch {
      socket.emit('error', { message: 'Unauthorized' });
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('chat:send')
  async send(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const r = sendSchema.safeParse(body);
    if (!r.success) throw new WsException('Invalid message');
    try {
      return await this.matching.send(socket.data.userId, r.data.conversationId, r.data.text);
    } catch (e) {
      this.log.warn(`chat:send rejected: ${(e as Error).message}`);
      throw new WsException((e as Error).message);
    }
  }

  @SubscribeMessage('chat:typing')
  async typing(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const r = typingSchema.safeParse(body);
    if (!r.success) return;
    const conv = await this.matching.assertMember(socket.data.userId, r.data.conversationId).catch(() => null);
    if (!conv) return;
    const other = conv.match.brandId === socket.data.userId ? conv.match.creatorId : conv.match.brandId;
    socket.to(userRoom(other)).emit('chat:typing', { conversationId: r.data.conversationId, userId: socket.data.userId });
  }
}
