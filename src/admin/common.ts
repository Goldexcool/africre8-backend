import { z } from 'zod';
import type { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Query fields every admin list shares. */
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export type Person = { id: string; role: Role; name: string; email: string };

/** Names and emails for a set of user ids (brand business name, creator display name, or the email). */
export async function people(prisma: PrismaService, ids: (string | null | undefined)[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, role: true, email: true, creatorProfile: { select: { displayName: true } }, brandProfile: { select: { businessName: true } } },
  });
  return new Map(users.map((u) => [u.id, { id: u.id, role: u.role, email: u.email, name: u.creatorProfile?.displayName ?? u.brandProfile?.businessName ?? u.email }]));
}

/** Writes one audit row for an admin action. */
export const audit = (prisma: PrismaService, adminId: string, action: string, entity: string, entityId: string, meta?: Record<string, unknown>) =>
  prisma.auditLog.create({ data: { actorId: adminId, action, entity, entityId, meta: (meta ?? undefined) as never } });

/** Quotes a CSV cell. */
export const csvCell = (v: unknown) => {
  const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
