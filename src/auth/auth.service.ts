import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { User } from '../generated/prisma/client.js';
import { ErrorCode } from '../common/errors.js';
import { verifyTotp } from '../common/totp.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OtpService } from './otp.service.js';

const SESSION_EXPIRED = { message: 'Your session has expired. Please sign in again.', code: ErrorCode.SessionExpired };
const SUSPENDED = { message: 'This account has been suspended. Please contact support.', code: ErrorCode.AccountSuspended };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly otp: OtpService,
  ) {}

  async register(input: { email: string; password: string; role: 'BRAND' | 'CREATOR'; phone?: string }) {
    const email = input.email.toLowerCase();
    const exists = await this.prisma.user.findFirst({
      where: { OR: [{ email }, ...(input.phone ? [{ phone: input.phone }] : [])] },
    });
    if (exists) throw new ConflictException({ message: 'An account with this email or phone already exists.', code: ErrorCode.Conflict });
    const user = await this.prisma.user.create({
      data: { email, phone: input.phone, role: input.role, passwordHash: await bcrypt.hash(input.password, 10) },
    });
    await this.otp.issue(user, 'VERIFY_EMAIL');
    return this.issue(user);
  }

  async login(email: string, password: string, totp?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException({ message: 'Incorrect email or password.', code: ErrorCode.InvalidCredentials });
    }
    if (user.status === 'SUSPENDED') throw new ForbiddenException(user.suspendedReason ? { ...SUSPENDED, message: `This account has been suspended: ${user.suspendedReason}` } : SUSPENDED);
    // Admins who turned on two-factor sign-in need the 6-digit code from their authenticator app as well.
    if (user.role === 'ADMIN' && user.totpEnabledAt && user.totpSecret) {
      if (!totp) throw new UnauthorizedException({ message: 'Enter the 6-digit code from your authenticator app.', code: ErrorCode.TotpRequired });
      if (!verifyTotp(user.totpSecret, totp)) throw new UnauthorizedException({ message: 'That code is not right. Check the app and try again.', code: ErrorCode.TotpRequired });
    }
    return this.issue(user);
  }

  /** Rotate: old token is revoked and replaced. Re-using a revoked token kills its whole family. */
  async refresh(token: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash(token) }, include: { user: true } });
    if (!row) throw new UnauthorizedException(SESSION_EXPIRED);
    if (row.revokedAt) {
      await this.revokeFamily(row.family);
      throw new UnauthorizedException(SESSION_EXPIRED);
    }
    if (row.expiresAt < new Date()) throw new UnauthorizedException(SESSION_EXPIRED);
    if (row.user.status === 'SUSPENDED') throw new ForbiddenException(SUSPENDED);

    // Claim the token atomically so two concurrent refreshes cannot both rotate it.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) {
      await this.revokeFamily(row.family);
      throw new UnauthorizedException(SESSION_EXPIRED);
    }
    const tokens = await this.issue(row.user, row.family);
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { replacedById: tokens.refreshTokenId } });
    return tokens;
  }

  async logout(token: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash(token) } });
    if (row) await this.revokeFamily(row.family);
  }

  async sendVerification(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.emailVerifiedAt) await this.otp.issue(user, 'VERIFY_EMAIL');
  }

  async verifyEmail(userId: string, code: string) {
    await this.otp.check(userId, 'VERIFY_EMAIL', code, true);
    await this.prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  }

  /** Always succeeds from the caller's view, so it can't be used to discover which emails exist. */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user && user.status === 'ACTIVE') await this.otp.issue(user, 'RESET_PASSWORD');
  }

  async checkResetCode(email: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) throw new BadRequestException('That code is invalid or expired');
    await this.otp.check(user.id, 'RESET_PASSWORD', code, false);
    return user;
  }

  /** New password + every existing session revoked. */
  async resetPassword(email: string, code: string, password: string) {
    const user = await this.checkResetCode(email, code);
    await this.otp.check(user.id, 'RESET_PASSWORD', code, true);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10), emailVerifiedAt: user.emailVerifiedAt ?? new Date() } }),
      this.prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }

  me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      omit: { passwordHash: true, totpSecret: true },
      include: { creatorProfile: { include: { socials: true } }, brandProfile: true, payoutDestination: true },
    });
  }

  private revokeFamily(family: string) {
    return this.prisma.refreshToken.updateMany({ where: { family, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async issue(user: User, family: string = randomUUID()) {
    const refreshToken = randomBytes(48).toString('base64url');
    const days = Number(process.env.REFRESH_TTL_DAYS ?? 30);
    const row = await this.prisma.refreshToken.create({
      data: { userId: user.id, family, tokenHash: hash(refreshToken), expiresAt: new Date(Date.now() + days * 864e5) },
    });
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });
    const { passwordHash: _, totpSecret: __, ...safeUser } = user;
    return { accessToken, refreshToken, refreshTokenId: row.id, user: safeUser };
  }
}
