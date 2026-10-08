import { config } from 'dotenv';
// Tests run against a local Postgres (docker: africre8-pg-test) so they're fast and never touch Neon.
config({ path: '.env.test', override: true });
config();
