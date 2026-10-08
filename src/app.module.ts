import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queue/queue.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { UploadsController } from './uploads/uploads.controller.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, QueueModule, AuthModule, ProfilesModule],
  controllers: [HealthController, UploadsController],
})
export class AppModule {}
