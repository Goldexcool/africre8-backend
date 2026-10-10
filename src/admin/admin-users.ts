import { Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminAccess } from './access.js';
import { audit, pageQuery, people } from './common.js';

const listQuery = z.object({
  role: z.enum(['BRAND', 'CREATOR', 'ADMIN']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  verification: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED']).optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});
type ListQuery = z.infer<typeof listQuery>;

const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) });
const noteSchema = z.object({ note: z.string().trim().min(1).max(2000) });
const kycListQuery = z.object({ status: z.enum(['VERIFIED', 'FAILED', 'ALL']).default('ALL'), ...pageQuery });

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly access: AdminAccess,
  ) {}

  async list(q: ListQuery) {
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.verification ? { verificationStatus: q.verification } : {}),
      ...(q.q
        ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { creatorProfile: { displayName: { contains: q.q, mode: 'insensitive' } } }, { brandProfile: { businessName: { contains: q.q, mode: 'insensitive' } } }] }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        omit: { passwordHash: true, totpSecret: true },
        include: { creatorProfile: { select: { displayName: true, avatarUrl: true } }, brandProfile: { select: { businessName: true, logoUrl: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  }

  async detail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      omit: { passwordHash: true, totpSecret: true },
      include: { creatorProfile: { include: { socials: true } }, brandProfile: true, payoutDestination: { select: { bankName: true, accountName: true, updatedAt: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    const own = user.role === 'BRAND' ? { brandId: id } : user.role === 'CREATOR' ? { creatorId: id } : { id: '00000000-0000-0000-0000-000000000000' };
    const [campaigns, transactions, sessions, notes, ids, reports] = await Promise.all([
      this.prisma.campaign.findMany({ where: own, orderBy: { updatedAt: 'desc' }, take: 20, select: { id: true, title: true, status: true, amountKobo: true, feeKobo: true, updatedAt: true } }),
      this.prisma.transaction.findMany({ where: { campaign: own }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, kind: true, status: true, amountKobo: true, campaignId: true, createdAt: true, failureReason: true } }),
      this.prisma.refreshToken.findMany({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, family: true, createdAt: true, expiresAt: true } }),
      this.prisma.userNote.findMany({ where: { userId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.kycVerification.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, provider: true, idType: true, idLast4: true, status: true, confidence: true, failureReason: true, createdAt: true } }),
      this.prisma.report.count({ where: { targetType: 'USER', targetId: id } }),
    ]);
    const who = await people(this.prisma, notes.map((n) => n.adminId));
    return { user, campaigns, transactions, sessions, notes: notes.map((n) => ({ id: n.id, admin: who.get(n.adminId) ?? null, note: n.note, createdAt: n.createdAt })), kycChecks: ids, reportsAgainst: reports };
  }

  /** Suspending signs the person out everywhere and keeps the reason (they see it when they try to sign in). */
  async suspend(adminId: string, id: string, reason: string) {
    await this.access.need(adminId, 'users');
    const u = await this.target(id);
    if (u.role === 'ADMIN') throw new ConflictException("An admin account can't be suspended here. Use Admins.");
    if (u.status === 'SUSPENDED') throw new ConflictException('This account is already suspended.');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { status: 'SUSPENDED', suspendedReason: reason } }),
      this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit(this.prisma, adminId, 'admin.user_suspended', 'User', id, { reason });
    return this.detail(id);
  }

  async unsuspend(adminId: string, id: string, reason: string) {
    await this.access.need(adminId, 'users');
    const u = await this.target(id);
    if (u.status !== 'SUSPENDED') throw new ConflictException('This account is not suspended.');
    await this.prisma.user.update({ where: { id }, data: { status: 'ACTIVE', suspendedReason: null } });
    await audit(this.prisma, adminId, 'admin.user_unsuspended', 'User', id, { reason });
    return this.detail(id);
  }

  /** Marks a user verified or rejected without an ID submission (for example a known brand). Prefer the ID queue. */
  async setVerification(adminId: string, id: string, status: 'VERIFIED' | 'REJECTED', reason: string) {
    await this.access.need(adminId, 'users');
    await this.target(id);
    await this.prisma.user.update({ where: { id }, data: { verificationStatus: status } });
    await audit(this.prisma, adminId, status === 'VERIFIED' ? 'admin.user_verified' : 'admin.user_verification_rejected', 'User', id, { reason });
    await this.notifications.notify(id, {
      kind: 'account',
      title: status === 'VERIFIED' ? 'You are verified' : 'Verification not approved',
      body: status === 'VERIFIED' ? 'Your account now shows the verified badge.' : `We could not verify your account. ${reason}`,
      linkTo: '/verification',
    });
    return this.detail(id);
  }

  async signOutEverywhere(adminId: string, id: string) {
    await this.access.need(adminId, 'users');
    await this.target(id);
    const r = await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(this.prisma, adminId, 'admin.user_signed_out', 'User', id, { sessions: r.count });
    return { revoked: r.count };
  }

  async addNote(adminId: string, id: string, note: string) {
    await this.target(id);
    const row = await this.prisma.userNote.create({ data: { userId: id, adminId, note } });
    await audit(this.prisma, adminId, 'admin.user_note_added', 'User', id);
    const who = await people(this.prisma, [adminId]);
    return { id: row.id, admin: who.get(adminId) ?? null, note: row.note, createdAt: row.createdAt };
  }

  private async target(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true, status: true } });
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  // ---------- KYC checks (run by the provider; admins only look) ----------

  async kycList(q: z.infer<typeof kycListQuery>) {
    const where: Prisma.KycVerificationWhereInput = q.status === 'ALL' ? {} : { status: q.status };
    const [total, rows] = await Promise.all([
      this.prisma.kycVerification.count({ where }),
      this.prisma.kycVerification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const who = await people(this.prisma, rows.map((r) => r.userId));
    return { items: rows.map(({ idHash: _hash, ...r }) => ({ ...r, user: who.get(r.userId) ?? null })), total, page: q.page, pageSize: q.pageSize };
  }
}

@Roles('ADMIN')
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly svc: AdminUsersService) {}

  @Get('users') list(@Query(new ZodPipe(listQuery)) q: ListQuery) { return this.svc.list(q); }
  @Get('users/:id') detail(@Param('id', ParseUUIDPipe) id: string) { return this.svc.detail(id); }
  @Post('users/:id/suspend') suspend(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) { return this.svc.suspend(a.id, id, b.reason); }
  @Post('users/:id/unsuspend') unsuspend(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) { return this.svc.unsuspend(a.id, id, b.reason); }
  @Post('users/:id/verify') verify(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) { return this.svc.setVerification(a.id, id, 'VERIFIED', b.reason); }
  @Post('users/:id/reject-verification') reject(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) { return this.svc.setVerification(a.id, id, 'REJECTED', b.reason); }
  @Post('users/:id/sign-out') signOut(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.signOutEverywhere(a.id, id); }
  @Post('users/:id/notes') note(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteSchema)) b: z.infer<typeof noteSchema>) { return this.svc.addNote(a.id, id, b.note); }
  @Get('kyc') kyc(@Query(new ZodPipe(kycListQuery)) q: z.infer<typeof kycListQuery>) { return this.svc.kycList(q); }
}
