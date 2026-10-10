import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The settings an admin may change. Only settings the platform actually reads live here: each has a default (used until
 * an admin changes it), a range, and a label for the console.
 */
export const SETTING_DEFS = {
  platformFeeBps: { label: 'Platform fee (basis points, 800 = 8%)', min: 0, max: 3000, default: () => Number(process.env.PLATFORM_FEE_BPS ?? 800), note: 'Applies to campaigns created after the change. Existing campaigns keep their fee.' },
  disputeResponseHours: { label: 'Hours the other side has to answer a dispute', min: 1, max: 336, default: () => 72, note: 'Applies to disputes raised after the change.' },
  overdueRefundGraceDays: { label: 'Days after the deadline before undelivered work is refunded', min: 0, max: 30, default: () => 3, note: 'Used by the hourly expiry job.' },
} as const;
export type SettingKey = keyof typeof SETTING_DEFS;
export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];

const CACHE_MS = 15_000;

@Injectable()
export class SettingsService {
  private cache = new Map<string, { value: number; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** The current value of a setting (cached for a few seconds, so a change reaches every process quickly). */
  async number(key: SettingKey): Promise<number> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const row = await this.prisma.setting.findUnique({ where: { key } });
    const def = SETTING_DEFS[key];
    const value = typeof row?.value === 'number' ? row.value : def.default();
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  async all() {
    const rows = await this.prisma.setting.findMany();
    return SETTING_KEYS.map((key) => {
      const row = rows.find((r) => r.key === key);
      const def = SETTING_DEFS[key];
      return { key, label: def.label, note: def.note, min: def.min, max: def.max, default: def.default(), value: typeof row?.value === 'number' ? row.value : def.default(), updatedAt: row?.updatedAt ?? null, updatedById: row?.updatedById ?? null };
    });
  }

  async set(adminId: string, key: SettingKey, value: number) {
    const def = SETTING_DEFS[key];
    const before = await this.number(key);
    await this.prisma.setting.upsert({ where: { key }, create: { key, value, updatedById: adminId }, update: { value, updatedById: adminId } });
    this.cache.delete(key);
    await this.prisma.auditLog.create({ data: { actorId: adminId, action: 'settings.changed', entity: 'Setting', entityId: key, meta: { from: before, to: value, label: def.label } as Prisma.InputJsonValue } });
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
