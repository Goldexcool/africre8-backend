import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
  PAYMENT_PROVIDER: z.enum(['payaza', 'mock']).default('mock'),
  PAYAZA_PUBLIC_KEY: z.string().optional(),
  PAYAZA_SECRET_KEY: z.string().optional(),
  PAYAZA_ENV: z.enum(['test', 'live']).default('test'),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  CLOUDINARY_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

// Empty strings in .env mean "unset".
export function validateEnv(raw: Record<string, unknown>): Env {
  const cleaned = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  return schema.parse(cleaned);
}
