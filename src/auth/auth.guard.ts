import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ErrorCode } from '../common/errors.js';
import { IS_PUBLIC, ROLES, type AuthUser } from '../common/auth.decorators.js';

// Global guard: every route needs a valid access token unless @Public(); @Roles() narrows further.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== 'http') return true; // sockets authenticate on connect (RealtimeGateway)
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new UnauthorizedException({ message: 'Please sign in to continue.', code: ErrorCode.Unauthenticated });
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; role: AuthUser['role'] }>(token);
      req.user = { id: payload.sub, role: payload.role } satisfies AuthUser;
    } catch {
      throw new UnauthorizedException({ message: 'Your session has expired. Please sign in again.', code: ErrorCode.SessionExpired });
    }

    const roles = this.reflector.getAllAndOverride<AuthUser['role'][]>(ROLES, targets);
    if (roles?.length && !roles.includes(req.user.role)) throw new ForbiddenException({ message: "You don't have access to this.", code: ErrorCode.WrongRole });
    return true;
  }
}
