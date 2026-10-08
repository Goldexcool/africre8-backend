import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { OtpService } from './otp.service.js';

@Global()
@Module({
  imports: [
    // Per-IP limit on the auth endpoints (AuthController uses ThrottlerGuard). Off under NODE_ENV=test.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: cfg.get<number>('RATE_LIMIT_PER_MINUTE') ?? 20 }],
        skipIf: () => process.env.NODE_ENV === 'test',
      }),
    }),
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET,
        signOptions: { expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as `${number}m` },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, OtpService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
