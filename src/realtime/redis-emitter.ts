import { Emitter } from '@socket.io/redis-emitter';
import { createRedis } from '../queue/queue.module.js';

/** For the worker process: push socket events through Redis to whichever API instance holds the socket. */
export function redisSocketEmitter() {
  const emitter = new Emitter(createRedis());
  return (userId: string, event: string, payload: unknown) => emitter.to(`user:${userId}`).emit(event, payload);
}
