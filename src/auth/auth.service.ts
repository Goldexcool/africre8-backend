import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(input: { email: string; password: string; role: 'BRAND' | 'CREATOR'; phone?: string }) {
    const email = input.email.toLowerCase();
    const exists = await this.prisma.user.findFirst({
      where: { OR: [{ email }, ...(input.phone ? [{ phone: input.phone }] : [])] },
    });
    if (exists) throw new ConflictException('Email or phone already registered');
    const user = await this.prisma.user.create({
      data: { email, phone: input.phone, role: input.role, passwordHash: await bcrypt.hash(input.password, 10) },
    });
    return this.issue(user);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.status === 'SUSPENDED') throw new ForbiddenException('Account suspended');
    return this.issue(user);
  }

  /** Rotate: old token is revoked and replaced. Re-using a revoked token kills its whole family. */
  async refresh(token: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash(token) }, include: { user: true } });
    if (!row) throw new UnauthorizedException('Invalid refresh token');
    if (row.revokedAt) {
      await this.revokeFamily(row.family);
      throw new UnauthorizedException('Refresh token reused; session revoked');
    }
    if (row.expiresAt < new Date()) throw new UnauthorizedException('Refresh token expired');
    if (row.user.status === 'SUSPENDED') throw new ForbiddenException('Account suspended');

    // Claim the token atomically so two concurrent refreshes cannot both rotate it.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) {
      await this.revokeFamily(row.family);
      throw new UnauthorizedException('Refresh token reused; session revoked');
    }
    const tokens = await this.issue(row.user, row.family);
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { replacedById: tokens.refreshTokenId } });
    return tokens;
  }

  async logout(token: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash(token) } });
    if (row) await this.revokeFamily(row.family);
  }

  me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      omit: { passwordHash: true },
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
    const { passwordHash: _, ...safeUser } = user;
    return { accessToken, refreshToken, refreshTokenId: row.id, user: safeUser };
  }
}
