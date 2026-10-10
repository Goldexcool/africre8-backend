import { BadRequestException, Body, ConflictException, Controller, Get, Header, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ErrorCode } from '../common/errors.js';
import { newSecret, otpauthUri, verifyTotp } from '../common/totp.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminAccess } from './access.js';
import { audit, pageQuery, people, toCsv } from './common.js';

const auditFilters = {
  actorId: z.string().uuid().optional(),
  action: z.string().trim().max(80).optional(),
  entity: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};
const auditQuery = z.object({ ...auditFilters, ...pageQuery });
const auditExport = z.object(auditFilters);
const seriesQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const createAdminSchema = z.object({ email: z.string().email(), password: z.string().min(10, 'Use at least 10 characters.'), role: z.enum(['SUPER', 'SUPPORT', 'FINANCE']) });
const roleSchema = z.object({ role: z.enum(['SUPER', 'SUPPORT', 'FINANCE']) });
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') });

@Injectable()
export class AdminSystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AdminAccess,
  ) {}

  // ---------- Reporting ----------

  /** Daily counts for the last N days: sign-ups by role, campaigns created, money funded, disputes opened. */
  async timeseries(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [signups, campaigns, funded, disputes] = await Promise.all([
      this.prisma.$queryRaw<{ day: Date; role: string; n: bigint }[]>(Prisma.sql`select date_trunc('day', "createdAt") as day, role::text as role, count(*) as n from "User" where "createdAt" >= ${since} and role <> 'ADMIN' group by 1, 2`),
      this.prisma.$queryRaw<{ day: Date; n: bigint }[]>(Prisma.sql`select date_trunc('day', "createdAt") as day, count(*) as n from "Campaign" where "createdAt" >= ${since} group by 1`),
      this.prisma.$queryRaw<{ day: Date; amount: bigint | null; fee: bigint | null }[]>(Prisma.sql`select date_trunc('day', "createdAt") as day, sum("amountKobo") as amount, sum("feeKobo") as fee from "Transaction" where kind = 'FUNDING' and status = 'successful' and "createdAt" >= ${since} group by 1`),
      this.prisma.$queryRaw<{ day: Date; n: bigint }[]>(Prisma.sql`select date_trunc('day', "createdAt") as day, count(*) as n from "Dispute" where "createdAt" >= ${since} group by 1`),
    ]);
    const key = (d: Date) => d.toISOString().slice(0, 10);
    const out = new Map<string, { day: string; brands: number; creators: number; campaigns: number; fundedKobo: number; feesKobo: number; disputes: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const day = key(new Date(Date.now() - i * 86_400_000));
      out.set(day, { day, brands: 0, creators: 0, campaigns: 0, fundedKobo: 0, feesKobo: 0, disputes: 0 });
    }
    for (const r of signups) { const d = out.get(key(r.day)); if (d) d[r.role === 'BRAND' ? 'brands' : 'creators'] += Number(r.n); }
    for (const r of campaigns) { const d = out.get(key(r.day)); if (d) d.campaigns += Number(r.n); }
    for (const r of funded) { const d = out.get(key(r.day)); if (d) { d.fundedKobo += Number(r.amount ?? 0); d.feesKobo += Number(r.fee ?? 0); } }
    for (const r of disputes) { const d = out.get(key(r.day)); if (d) d.disputes += Number(r.n); }
    return { days, series: [...out.values()] };
  }

  private auditWhere(q: z.infer<typeof auditExport>): Prisma.AuditLogWhereInput {
    return {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: { contains: q.action, mode: 'insensitive' } } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
  }

  async audit(q: z.infer<typeof auditQuery>) {
    const where = this.auditWhere(q);
    const [total, rows] = await Promise.all([this.prisma.auditLog.count({ where }), this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const who = await people(this.prisma, rows.map((r) => r.actorId));
    return { items: rows.map((r) => ({ ...r, actor: r.actorId ? (who.get(r.actorId) ?? null) : null })), total, page: q.page, pageSize: q.pageSize };
  }

  async auditCsv(q: z.infer<typeof auditExport>) {
    const rows = await this.prisma.auditLog.findMany({ where: this.auditWhere(q), orderBy: { createdAt: 'desc' }, take: 5000 });
    return toCsv(['createdAt', 'actorId', 'action', 'entity', 'entityId', 'fromState', 'toState', 'reference', 'meta'], rows.map((r) => [r.createdAt, r.actorId, r.action, r.entity, r.entityId, r.fromState, r.toState, r.reference, r.meta ? JSON.stringify(r.meta) : '']));
  }

  // ---------- Who am I ----------

  async me(adminId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { id: true, email: true, adminRole: true, totpEnabledAt: true } });
    const sessions = await this.prisma.refreshToken.count({ where: { userId: adminId, revokedAt: null, expiresAt: { gt: new Date() } } });
    return { id: u.id, email: u.email, role: u.adminRole ?? 'SUPER', twoFactorEnabled: !!u.totpEnabledAt, sessions };
  }

  async signOutEverywhere(adminId: string) {
    const r = await this.prisma.refreshToken.updateMany({ where: { userId: adminId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(this.prisma, adminId, 'admin.signed_out_everywhere', 'User', adminId, { sessions: r.count });
    return { revoked: r.count };
  }

  // ---------- Two-factor ----------

  /** Step 1: make a secret. It does nothing until a valid code from the app confirms it (enable). */
  async twoFactorSetup(adminId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    if (u.totpEnabledAt) throw new ConflictException('Two-factor sign-in is already on.');
    const secret = newSecret();
    await this.prisma.user.update({ where: { id: adminId }, data: { totpSecret: secret } });
    return { secret, otpauthUri: otpauthUri(secret, u.email) };
  }

  async twoFactorEnable(adminId: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    if (u.totpEnabledAt) throw new ConflictException('Two-factor sign-in is already on.');
    if (!u.totpSecret) throw new BadRequestException({ message: 'Start the setup first.', code: ErrorCode.Validation });
    if (!verifyTotp(u.totpSecret, code)) throw new BadRequestException({ message: 'That code is not right. Check the app and try again.', code: ErrorCode.InvalidCode });
    await this.prisma.user.update({ where: { id: adminId }, data: { totpEnabledAt: new Date() } });
    await audit(this.prisma, adminId, 'admin.2fa_enabled', 'User', adminId);
    return this.me(adminId);
  }

  async twoFactorDisable(adminId: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    if (!u.totpEnabledAt || !u.totpSecret) throw new ConflictException('Two-factor sign-in is not on.');
    if (!verifyTotp(u.totpSecret, code)) throw new BadRequestException({ message: 'That code is not right. Check the app and try again.', code: ErrorCode.InvalidCode });
    await this.prisma.user.update({ where: { id: adminId }, data: { totpEnabledAt: null, totpSecret: null } });
    await audit(this.prisma, adminId, 'admin.2fa_disabled', 'User', adminId);
    return this.me(adminId);
  }

  // ---------- Admin accounts (super admins only) ----------

  async admins() {
    const rows = await this.prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true, email: true, status: true, adminRole: true, totpEnabledAt: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ id: r.id, email: r.email, status: r.status, role: r.adminRole ?? 'SUPER', twoFactorEnabled: !!r.totpEnabledAt, createdAt: r.createdAt }));
  }

  async createAdmin(actorId: string, input: z.infer<typeof createAdminSchema>) {
    await this.access.need(actorId, 'admins');
    const email = input.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException({ message: 'An account with this email already exists.', code: ErrorCode.Conflict });
    const u = await this.prisma.user.create({ data: { email, role: 'ADMIN', adminRole: input.role, passwordHash: await bcrypt.hash(input.password, 10), emailVerifiedAt: new Date(), onboardedAt: new Date() } });
    await audit(this.prisma, actorId, 'admin.admin_created', 'User', u.id, { role: input.role });
    return this.admins();
  }

  private async otherSupers(exceptId: string) {
    return this.prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE', id: { not: exceptId }, OR: [{ adminRole: 'SUPER' }, { adminRole: null }] } });
  }

  private async adminTarget(id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, role: 'ADMIN' } });
    if (!u) throw new NotFoundException('Admin not found');
    return u;
  }

  async setRole(actorId: string, id: string, role: 'SUPER' | 'SUPPORT' | 'FINANCE') {
    await this.access.need(actorId, 'admins');
    const u = await this.adminTarget(id);
    if (role !== 'SUPER' && (u.adminRole ?? 'SUPER') === 'SUPER' && (await this.otherSupers(id)) === 0) throw new ConflictException('There must always be at least one active super admin.');
    await this.prisma.user.update({ where: { id }, data: { adminRole: role } });
    await audit(this.prisma, actorId, 'admin.role_changed', 'User', id, { role });
    return this.admins();
  }

  async disable(actorId: string, id: string) {
    await this.access.need(actorId, 'admins');
    const u = await this.adminTarget(id);
    if (id === actorId) throw new ConflictException("You can't disable your own account.");
    if ((u.adminRole ?? 'SUPER') === 'SUPER' && (await this.otherSupers(id)) === 0) throw new ConflictException('There must always be at least one active super admin.');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { status: 'SUSPENDED', suspendedReason: 'Admin access removed' } }),
      this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit(this.prisma, actorId, 'admin.admin_disabled', 'User', id);
    return this.admins();
  }

  async enable(actorId: string, id: string) {
    await this.access.need(actorId, 'admins');
    await this.adminTarget(id);
    await this.prisma.user.update({ where: { id }, data: { status: 'ACTIVE', suspendedReason: null } });
    await audit(this.prisma, actorId, 'admin.admin_enabled', 'User', id);
    return this.admins();
  }

  /** For an admin who lost their authenticator: a super admin switches 2FA off so they can set it up again. */
  async reset2fa(actorId: string, id: string) {
    await this.access.need(actorId, 'admins');
    await this.adminTarget(id);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { totpEnabledAt: null, totpSecret: null } }),
      this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit(this.prisma, actorId, 'admin.2fa_reset', 'User', id);
    return this.admins();
  }
}

@Roles('ADMIN')
@Controller('admin')
export class AdminSystemController {
  constructor(private readonly svc: AdminSystemService) {}

  @Get('stats/timeseries') series(@Query(new ZodPipe(seriesQuery)) q: z.infer<typeof seriesQuery>) { return this.svc.timeseries(q.days); }
  @Get('audit') audit(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) { return this.svc.audit(q); }
  @Get('audit.csv') @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="audit.csv"') auditCsv(@Query(new ZodPipe(auditExport)) q: z.infer<typeof auditExport>) { return this.svc.auditCsv(q); }

  @Get('me') me(@CurrentUser() a: AuthUser) { return this.svc.me(a.id); }
  @Post('me/sign-out-everywhere') signOut(@CurrentUser() a: AuthUser) { return this.svc.signOutEverywhere(a.id); }
  @Post('2fa/setup') setup(@CurrentUser() a: AuthUser) { return this.svc.twoFactorSetup(a.id); }
  @Post('2fa/enable') enable2fa(@CurrentUser() a: AuthUser, @Body(new ZodPipe(codeSchema)) b: z.infer<typeof codeSchema>) { return this.svc.twoFactorEnable(a.id, b.code); }
  @Post('2fa/disable') disable2fa(@CurrentUser() a: AuthUser, @Body(new ZodPipe(codeSchema)) b: z.infer<typeof codeSchema>) { return this.svc.twoFactorDisable(a.id, b.code); }

  @Get('admins') admins() { return this.svc.admins(); }
  @Post('admins') create(@CurrentUser() a: AuthUser, @Body(new ZodPipe(createAdminSchema)) b: z.infer<typeof createAdminSchema>) { return this.svc.createAdmin(a.id, b); }
  @Post('admins/:id/role') role(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(roleSchema)) b: z.infer<typeof roleSchema>) { return this.svc.setRole(a.id, id, b.role); }
  @Post('admins/:id/disable') disable(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.disable(a.id, id); }
  @Post('admins/:id/enable') enable(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.enable(a.id, id); }
  @Post('admins/:id/reset-2fa') reset(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.reset2fa(a.id, id); }
}
