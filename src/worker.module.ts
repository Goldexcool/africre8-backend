import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queue/queue.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PaymentsProcessor } from './payments/payments.processor.js';
import { VerificationModule } from './verification/verification.module.js';
import { VerificationProcessor } from './verification/verification.processor.js';

// Background processors only; no HTTP. Processors are added here as features land.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, QueueModule, NotificationsModule, PaymentsModule, VerificationModule],
  providers: [PaymentsProcessor, VerificationProcessor],
})
export class WorkerModule {}
