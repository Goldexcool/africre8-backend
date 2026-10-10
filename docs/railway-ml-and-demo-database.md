# Railway ML deployment and synthetic demo database replacement

This runbook prepares two separate changes: a private FastAPI service and a replacement PostgreSQL service. Do not point the existing NestJS deployment at either replacement until every validation step passes. The Python service is stateless and never connects to PostgreSQL or Redis.

## Private FastAPI service

1. In the same Railway project and environment as NestJS, create a new service from the `Goldexcool/africre8-backend` GitHub repository. Name it `africre8-ml` and set **Root Directory** to `/services/ml`.
2. Railway will detect `services/ml/Dockerfile`. Do not add a build or start-command override. The image installs CPU-only PyTorch, packages `africre8_ml`, and downloads the pinned `intfloat/multilingual-e5-small` revision `fd1525a9fd15316a2d503bf26ab031a61d056e98`. Demo datasets, local caches, and duplicate model formats are excluded.
3. Set `PORT=8001` and `AFRICRE8_ML_SEMANTIC_ENABLED=true`. Configure the deployment healthcheck path as `/health` with a 600-second timeout and one replica. Allocate at least 2 GB RAM; measured local steady memory after semantic inference was about 719 MiB, while 2 GB leaves room for model loading, native libraries, request payloads, and transient embeddings. Start with one CPU worker.
4. Do not generate a public domain. Railway private networking exposes the service inside the environment as `africre8-ml.railway.internal`. `/health` reports process liveness; `/ready` reports model-asset and lazy-load state.
5. On the existing NestJS service, stage these variables only after the ML deployment is healthy:

   ```text
   ML_SERVICE_URL=http://${{africre8-ml.RAILWAY_PRIVATE_DOMAIN}}:8001
   ML_REQUEST_TIMEOUT_MS=20000
   ML_SEMANTIC_TIMEOUT_MS=120000
   ```

   The concrete fallback is `http://africre8-ml.railway.internal:8001`. Use HTTP on Railway's encrypted private network. Keep the ML service without a public domain because the current API has no service token; any service in the same Railway environment can otherwise call it. NestJS remains the authentication and authorization boundary.

## Synthetic database commands

The existing importer creates 500 creator users/profiles, 50 brand users/profiles, 150 operational opportunities, 500 creator ML profiles, 150 opportunity ML profiles, and 3,000 isolated evidence events. The operational seeder then adds three password-enabled test accounts, applications/invitations, accepted collaborations, 360 synthetic campaigns, and deliverable requirements. It deliberately creates no payment transactions, payout destinations, webhooks, outbound emails, notifications, submissions, verification runs, or operational disputes.

Use process-scoped variables. Passwords must be unique demo-only values of at least 12 characters and must be stored in Railway secrets or the administrator's password manager, never committed:

```powershell
$env:DATABASE_URL = '<replacement-postgres-public-or-tunnel-url>'
$env:DIRECT_URL = $env:DATABASE_URL
$env:NODE_ENV = 'production'
$env:DEMO_DATABASE_ENV = 'demo'
$env:DEMO_DATA_IMPORT_ENABLED = 'false'
$env:DEMO_RAILWAY_REPLACEMENT_APPROVED = 'true'
$env:DEMO_BRAND_PASSWORD = '<unique-demo-brand-password>'
$env:DEMO_CREATOR_PASSWORD = '<unique-demo-creator-password>'
$env:DEMO_ADMIN_PASSWORD = '<unique-demo-admin-password>'
$env:DEMO_DATABASE_FINGERPRINT = npm exec tsx -- -e "import { databaseIdentity } from './prisma/demo-import/core.ts'; console.log(databaseIdentity(process.env.DATABASE_URL).fingerprint)"
$confirm = $env:DEMO_DATABASE_FINGERPRINT
```

Review the fingerprint and replacement URL before every write. The importer excludes credentials from the fingerprint and requires both the fingerprint and the literal replacement confirmation:

```powershell
npx prisma migrate status
npx prisma migrate deploy
npm run demo:validate
npm run demo:import -- --confirm-fingerprint=$confirm --confirm-replacement=REPLACE_WITH_SYNTHETIC_DEMO
$env:DEMO_DATA_IMPORT_ENABLED = 'true'
npm run demo:import -- --write --confirm-fingerprint=$confirm --confirm-replacement=REPLACE_WITH_SYNTHETIC_DEMO
$env:DEMO_DATA_IMPORT_ENABLED = 'false'
npm run demo:import -- --confirm-fingerprint=$confirm --confirm-replacement=REPLACE_WITH_SYNTHETIC_DEMO
npm run demo:seed-operational -- --confirm-fingerprint=$confirm --confirm-replacement=REPLACE_WITH_SYNTHETIC_DEMO
$env:DEMO_DATA_IMPORT_ENABLED = 'true'
npm run demo:seed-operational -- --write --confirm-fingerprint=$confirm --confirm-replacement=REPLACE_WITH_SYNTHETIC_DEMO
$env:DEMO_DATA_IMPORT_ENABLED = 'false'
npm run demo:verify -- --confirm-fingerprint=$confirm --confirm-replacement=REPLACE_WITH_SYNTHETIC_DEMO
```

None of these application scripts drops, truncates, or resets a database. Import refreshes only ML child rows attached to versioned synthetic profiles, and the operational seeder refreshes deliverable requirements only for its deterministic synthetic campaign IDs. `prisma migrate deploy` still changes the selected database schema, so run it only after confirming that `DATABASE_URL` identifies the newly provisioned sibling service. Keep `DEMO_DATA_IMPORT_ENABLED=false` except for the two reviewed write commands shown above.

The generated login emails are printed by the dry run and verifier. Passwords are never printed. Keep `PAYMENT_PROVIDER=mock`; leave all Payaza and Brevo variables unset. Do not start the worker during import or validation.

## Replacement and cutover runbook

1. **Freeze and back up the current database.** Record current row counts, trigger a manual Railway volume backup, and take an encrypted custom-format logical dump with `pg_dump --format=custom --no-owner`. Store the dump outside Railway with restricted access.
2. **Prove restoration.** Restore the logical dump into a scratch PostgreSQL database using `pg_restore --no-owner --exit-on-error`. Compare schema migration history, table counts, and several recent records. Record the dump checksum, restore duration, and verification result.
3. **Provision a sibling PostgreSQL service.** Create a new Railway PostgreSQL service in the same project/environment. Name it clearly as the synthetic replacement. Do not change the existing NestJS `DATABASE_URL`. Temporarily enable a TCP proxy or use `railway connect ... --tunnel-only` for the administrator's commands, then remove the proxy after validation.
4. **Apply reviewed migrations.** Point only the administrator's local process at the replacement URL. Run `prisma migrate status` and `prisma migrate deploy`. The ML migration is additive and the replacement database should contain all eight current migrations before import.
5. **Import public synthetic ML data.** Run importer offline validation, database dry run, reviewed write, then a second dry run to confirm idempotence. Private generator truth is neither read nor stored.
6. **Seed the operational demo graph.** Run the operational dry run and reviewed write. It refuses accounts outside the imported synthetic dataset and uses deterministic IDs, so reruns update the same records. No payment, mail, notification, or worker process is invoked.
7. **Validate before application access.** Run `demo:verify`; confirm 500 creators, 50 brands, 150 opportunities, 3,000 evidence events, 430 source journeys, 342 applications/invitations, 320 matches/conversations, 360 campaigns, zero payment/webhook/payout rows, and the printed test-account emails. Start an isolated NestJS instance with `PAYMENT_PROVIDER=mock`, no Brevo key, the replacement database URL, a separate Redis instance, and the private ML URL. Test login, `/discover`, `/opportunities/feed`, recommendation, and credibility endpoints.
8. **Stage the controlled cutover.** Put the current application into a short maintenance window or otherwise stop writes. Take a final backup of the original database. Change only the NestJS `DATABASE_URL` and `DIRECT_URL` reference variables to the replacement PostgreSQL service, retain `PAYMENT_PROVIDER=mock`, leave Payaza/Brevo secrets unset, and redeploy. Do not run seeds or migrations in the web start command.
9. **Smoke test.** Verify `/health`, brand and creator login, discovery, opportunity feed/detail, structured and semantic recommendations, credibility, and absence of payment/provider calls. Watch NestJS, ML, Redis, and PostgreSQL metrics and logs.
10. **Rollback.** If any check fails, restore the previous NestJS deployment variables so `DATABASE_URL` and `DIRECT_URL` reference the untouched original PostgreSQL service, redeploy, and verify health/login. Do not delete either database until the team accepts the replacement and the rollback retention period expires.

Railway's private network uses `<service-name>.railway.internal` within one project environment. Railway deployment healthchecks use the injected `PORT`, and Railway recommends validating database backups with an actual restore rather than assuming a snapshot is usable.
