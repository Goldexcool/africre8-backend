import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC, ROLES, type AuthUser } from '../common/auth.decorators.js';

// Global guard: every route needs a valid access token unless @Public(); @Roles() narrows further.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new UnauthorizedException('Missing access token');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; role: AuthUser['role'] }>(token);
      req.user = { id: payload.sub, role: payload.role } satisfies AuthUser;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    const roles = this.reflector.getAllAndOverride<AuthUser['role'][]>(ROLES, targets);
    if (roles?.length && !roles.includes(req.user.role)) throw new ForbiddenException('Not allowed for your role');
    return true;
  }
}
