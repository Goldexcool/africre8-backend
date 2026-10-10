import type { CreatorProfile, SocialAccount } from '../generated/prisma/client.js';

/** Shape the mobile app's `Creator` card expects (src/types/creator.ts). */
export function toCreatorCard(p: CreatorProfile & { socials: SocialAccount[]; mlProfile?: { displayImageOverrideUrl: string | null } | null }) {
  const best = p.socials.reduce<SocialAccount | undefined>((a, s) => (!a || s.followers > a.followers ? s : a), undefined);
  return {
    id: p.userId,
    name: p.displayName,
    avatarUrl: p.mlProfile?.displayImageOverrideUrl ?? p.avatarUrl ?? '',
    bio: p.bio ?? '',
    location: p.location ?? '',
    category: p.category ?? '',
    niches: p.niches,
    platforms: p.socials.map((s) => ({ platform: s.platform, handle: s.handle, url: s.url, followers: s.followers })),
    engagementRate: best?.engagementRate ?? 0,
    portfolio: p.portfolio,
    credibilityScore: p.credibilityScore,
    rating: p.ratingAvg,
    completedCampaigns: p.completedCampaigns,
    availability: p.availability,
    budgetRangeNgn: [(p.priceFromKobo ?? 0) / 100, (p.priceToKobo ?? p.priceFromKobo ?? 0) / 100] as [number, number],
  };
}
