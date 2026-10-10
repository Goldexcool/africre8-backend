import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { Redis } from 'ioredis';

export const QUEUES = {
  verification: 'verification',
  payments: 'payments',
  disputes: 'disputes',
} as const;

// BullMQ under native ESM needs a constructed client rather than connection options.
export function createRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  return new Redis(url, { family: 0, maxRetriesPerRequest: null }); // family 0: Railway private network is IPv6
}

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: createRedis(),
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000 },
    }),
    ...Object.values(QUEUES).map((name) => BullModule.registerQueue({ name })),
  ],
  exports: [BullModule],
})
export class QueueModule {}
