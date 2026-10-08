import { z } from 'zod';

const platform = z.enum(['instagram', 'tiktok', 'youtube', 'x', 'facebook']);

export const creatorSchema = z.object({
  displayName: z.string().min(2),
  avatarUrl: z.string().url().optional(),
  bio: z.string().max(500).optional(),
  location: z.string().optional(),
  category: z.string().optional(),
  niches: z.array(z.string()).optional(),
  portfolio: z.array(z.string().url()).max(12).optional(),
  priceFromNgn: z.number().nonnegative().optional(),
  priceToNgn: z.number().nonnegative().optional(),
  availability: z.enum(['available', 'busy', 'booked']).optional(),
  /** Lets brands find and invite this creator in Discover. */
  openToInvites: z.boolean().optional(),
  socials: z
    .array(
      z.object({
        platform,
        handle: z.string().min(1),
        url: z.string().url().optional(),
        followers: z.number().int().nonnegative().default(0),
        engagementRate: z.number().min(0).max(100).default(0),
      }),
    )
    .optional(),
});
export type CreatorInput = z.infer<typeof creatorSchema>;

export const brandSchema = z.object({
  businessName: z.string().min(2),
  logoUrl: z.string().url().optional(),
  industry: z.string().optional(),
  website: z.string().url().optional(),
  contactName: z.string().optional(),
  location: z.string().optional(),
  about: z.string().max(1000).optional(),
});
export type BrandInput = z.infer<typeof brandSchema>;

export const payoutSchema = z.object({
  bankCode: z.string().min(2),
  bankName: z.string().min(2),
  accountNumber: z.string().regex(/^\d{10}$/, 'NUBAN must be 10 digits'),
});
export type PayoutInput = z.infer<typeof payoutSchema>;
