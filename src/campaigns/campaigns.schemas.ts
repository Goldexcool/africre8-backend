import { z } from 'zod';

export const requirementSchema = z.object({
  title: z.string().min(2),
  platform: z.enum(['instagram', 'tiktok', 'youtube', 'x', 'facebook']).optional(),
  hashtags: z.array(z.string().regex(/^#?\w+$/)).default([]),
  mentions: z.array(z.string().regex(/^@?[\w.]+$/)).default([]),
  contentBrief: z.string().max(1000).optional(),
});

export const termsSchema = z.object({
  title: z.string().min(3),
  brief: z.string().min(10).max(4000),
  amountNgn: z.number().int().min(1000).max(50_000_000),
  deadline: z.coerce.date().refine((d) => d > new Date(), 'Deadline must be in the future'),
  revisionLimit: z.number().int().min(0).max(5).default(2),
  usageRights: z.string().max(1000).optional(),
  requirements: z.array(requirementSchema).min(1).max(10),
});
export type TermsInput = z.infer<typeof termsSchema>;

export const createSchema = termsSchema.extend({ matchId: z.string().uuid() });
export type CreateInput = z.infer<typeof createSchema>;

export const acceptSchema = z.object({ termsVersion: z.number().int().min(1) });
