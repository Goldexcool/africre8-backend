import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().default(3000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(20),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
  PAYMENT_PROVIDER: z.enum(['payaza', 'mock']).default('mock'),
  PAYAZA_PUBLIC_KEY: z.string().optional(),
  PAYAZA_SECRET_KEY: z.string().optional(),
  PAYAZA_ENV: z.enum(['test', 'live']).default('test'),
  /** Identity checks (NIN + selfie). `mock` needs no keys and never calls out. */
  KYC_PROVIDER: z.enum(['dojah', 'mock']).default('mock'),
  DOJAH_BASE_URL: z.string().url().default('https://sandbox.dojah.io'),
  DOJAH_APP_ID: z.string().optional(),
  DOJAH_SECRET_KEY: z.string().optional(),
  DOJAH_PUBLIC_KEY: z.string().optional(),
  KYC_MIN_CONFIDENCE: z.coerce.number().min(50).max(100).default(90),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  OBJECT_STORE_DRIVER: z.enum(['r2']).optional(),
  R2_ENDPOINT: z.string().url().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  ML_SERVICE_URL: z.string().url().default('http://127.0.0.1:8001'),
  ML_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .default(20_000),
  ML_SEMANTIC_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(180_000)
    .default(60_000),
});

export type Env = z.infer<typeof schema>;

// Empty strings in .env mean "unset".
export function validateEnv(raw: Record<string, unknown>): Env {
  const cleaned = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  return schema.parse(cleaned);
}
