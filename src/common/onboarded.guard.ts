import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ErrorCode } from './errors.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** PRD 1.1: no campaign functionality until onboarding is complete. Use with @UseGuards(OnboardedGuard). */
@Injectable()
export class OnboardedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext) {
    const { user } = ctx.switchToHttp().getRequest();
    const row = await this.prisma.user.findUnique({ where: { id: user.id }, select: { onboardedAt: true, status: true } });
    if (row?.status === 'SUSPENDED') throw new ForbiddenException({ message: 'This account has been suspended. Please contact support.', code: ErrorCode.AccountSuspended });
    if (!row?.onboardedAt) throw new ForbiddenException({ message: 'Finish setting up your profile first.', code: ErrorCode.OnboardingRequired });
    return true;
  }
}
