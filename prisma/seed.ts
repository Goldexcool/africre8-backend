import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '../src/generated/prisma/client.js';

type MockCreator = {
  name: string;
  avatarUrl: string;
  bio: string;
  location: string;
  category: string;
  platforms: { platform: 'instagram' | 'tiktok' | 'youtube' | 'x' | 'facebook'; handle: string; followers: number }[];
  engagementRate: number;
  portfolio: string[];
  credibilityScore: number;
  completedCampaigns: number;
  availability: 'available' | 'busy' | 'booked';
  budgetRangeUsd: [number, number];
};

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const USD_TO_NGN = 1500; // demo conversion for the mobile fixture's USD budgets

// Same public demo logins as the mobile app (src/lib/dev-credentials.ts).
const DEMO = {
  creator: { email: 'creator.dev@africre8.app', password: 'CreatorDemo!2026' },
  brand: { email: 'brand.dev@africre8.app', password: 'BrandDemo!2026' },
  admin: { email: 'admin.dev@africre8.app', password: process.env.SEED_ADMIN_PASSWORD },
};

const BRANDS = [
  { email: DEMO.brand.email, businessName: 'Adire Atelier', industry: 'Fashion', contactName: 'Kemi Adebayo', location: 'Lagos, Nigeria', website: 'https://adireatelier.example', about: 'Contemporary ready-to-wear rooted in Yoruba adire craft.' },
  { email: 'brand.zest@africre8.app', businessName: 'Zest Foods', industry: 'Food & Beverage', contactName: 'Bola Hassan', location: 'Abuja, Nigeria', website: 'https://zestfoods.example', about: 'Healthy snacks made from West African grains.' },
  { email: 'brand.kora@africre8.app', businessName: 'KoraPay Wallet', industry: 'Fintech', contactName: 'Yaw Boateng', location: 'Accra, Ghana', website: 'https://korawallet.example', about: 'Mobile wallet for cross-border creator payments.' },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

async function upsertUser(email: string, password: string | undefined, role: 'BRAND' | 'CREATOR' | 'ADMIN') {
  const passwordHash = await bcrypt.hash(password ?? randomBytes(24).toString('hex'), 10);
  return prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, role, onboardedAt: new Date(), verificationStatus: 'VERIFIED' },
    update: { passwordHash, role },
  });
}

async function main() {
  const creators: MockCreator[] = JSON.parse(readFileSync(new URL('./seed-data/creators.json', import.meta.url), 'utf8'));

  for (const [i, c] of creators.slice(0, 30).entries()) {
    const email = i === 0 ? DEMO.creator.email : `${slug(c.name)}@creators.africre8.app`;
    const user = await upsertUser(email, i === 0 ? DEMO.creator.password : undefined, 'CREATOR');
    const profile = {
      displayName: c.name,
      avatarUrl: c.avatarUrl,
      bio: c.bio,
      location: c.location,
      category: c.category,
      niches: [c.category],
      portfolio: c.portfolio,
      priceFromKobo: c.budgetRangeUsd[0] * USD_TO_NGN * 100,
      priceToKobo: c.budgetRangeUsd[1] * USD_TO_NGN * 100,
      credibilityScore: c.credibilityScore,
      ratingAvg: Math.min(5, 3.8 + c.credibilityScore / 80),
      completedCampaigns: c.completedCampaigns,
      availability: c.availability,
    };
    await prisma.creatorProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...profile }, update: profile });
    await prisma.socialAccount.deleteMany({ where: { creatorId: user.id } });
    await prisma.socialAccount.createMany({
      data: c.platforms.map((p) => ({
        creatorId: user.id,
        platform: p.platform,
        handle: p.handle,
        followers: p.followers,
        engagementRate: c.engagementRate,
      })),
    });
  }

  for (const { email, ...b } of BRANDS) {
    const user = await upsertUser(email, email === DEMO.brand.email ? DEMO.brand.password : undefined, 'BRAND');
    await prisma.brandProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...b }, update: b });
  }

  if (DEMO.admin.password) await upsertUser(DEMO.admin.email, DEMO.admin.password, 'ADMIN');
  else console.warn('SEED_ADMIN_PASSWORD not set; admin user skipped');

  console.log(`Seeded ${Math.min(30, creators.length)} creators, ${BRANDS.length} brands, admin=${Boolean(DEMO.admin.password)}`);
}

await main().finally(() => prisma.$disconnect());
