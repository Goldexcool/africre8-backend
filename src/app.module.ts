import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queue/queue.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { DiscoveryModule } from './discovery/discovery.module.js';
import { MatchingModule } from './matching/matching.module.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { VerificationModule } from './verification/verification.module.js';
import { ReviewModule } from './review/review.module.js';
import { AdminModule } from './admin/admin.module.js';
import { UploadsController } from './uploads/uploads.controller.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, QueueModule, AuthModule, ProfilesModule, NotificationsModule, DiscoveryModule, MatchingModule, CampaignsModule, PaymentsModule, VerificationModule, ReviewModule, AdminModule],
  controllers: [HealthController, UploadsController],
  providers: [RealtimeGateway],
})
export class AppModule {}
