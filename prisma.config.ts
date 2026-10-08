import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// CLI (migrate) uses the direct Neon host; the app uses the pooled DATABASE_URL via the pg adapter.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --import tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
