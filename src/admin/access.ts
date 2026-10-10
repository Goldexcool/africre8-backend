import { ForbiddenException, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/errors.js';
import type { AdminRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * What each admin role may change. Everyone signed in as an admin can READ every page; this gates the actions.
 * SUPER (also an admin with no role set, like the seeded account) can do everything.
 *   SUPPORT: disputes, verification review, users, ID checks, reports, content moderation.
 *   FINANCE: money operations and exports, disputes.
 *   SUPER only: settings, announcements, admin accounts.
 */
export const ADMIN_ACTIONS = {
  disputes: ['SUPPORT', 'FINANCE'],
  verification: ['SUPPORT'],
  users: ['SUPPORT'],
  moderation: ['SUPPORT'],
  money: ['FINANCE'],
  settings: [],
  announcements: [],
  admins: [],
} as const satisfies Record<string, AdminRole[]>;
export type AdminAction = keyof typeof ADMIN_ACTIONS;

@Injectable()
export class AdminAccess {
  constructor(private readonly prisma: PrismaService) {}

  async roleOf(userId: string): Promise<AdminRole> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { adminRole: true } });
    return u?.adminRole ?? 'SUPER';
  }

  /** Throws 403 unless this admin's role allows the action. */
  async need(userId: string, action: AdminAction) {
    const role = await this.roleOf(userId);
    if (role === 'SUPER' || (ADMIN_ACTIONS[action] as readonly AdminRole[]).includes(role)) return role;
    throw new ForbiddenException({ message: `Your admin role (${role.toLowerCase()}) can't do this. Ask a super admin.`, code: ErrorCode.Forbidden });
  }
}
