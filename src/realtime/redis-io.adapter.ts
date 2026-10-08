import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { createRedis } from '../queue/queue.module.js';

/** Lets every API instance (and the worker, via redis-emitter) reach any connected socket. */
export class RedisIoAdapter extends IoAdapter {
  constructor(app: INestApplicationContext) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, { ...options, cors: { origin: '*' } } as ServerOptions);
    server.adapter(createAdapter(createRedis(), createRedis()));
    return server;
  }
}
