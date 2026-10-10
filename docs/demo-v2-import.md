# Demo-v2 database import

The importer defaults to disposable local databases whose name visibly contains `demo`, `test`, or `local`. A Railway replacement target is allowed only with the separate `DEMO_RAILWAY_REPLACEMENT_APPROVED=true` opt-in, the exact `REPLACE_WITH_SYNTHETIC_DEMO` confirmation phrase, a matching target fingerprint, and the normal write opt-in. It rejects production/staging names and mismatched fingerprints. It never reads `generator_truth.json` and never creates operational campaigns, submissions, verifications, disputes, transactions, audit events, or payout records.

For the complete synthetic operational seed and Railway replacement procedure, use [railway-ml-and-demo-database.md](railway-ml-and-demo-database.md). Do not use the legacy `db:seed` command for that workflow.

## Validate files without a database

```powershell
npm run demo:validate
```

This verifies the manifest, public-file checksums, namespace, exact counts, foreign references, event chains, mandatory ML fields, rates, and private-field exclusions. It performs no database connection.

## Prepare a disposable local database

Example with an explicitly named local PostgreSQL database:

```powershell
createdb africre8_demo
$env:DATABASE_URL = 'postgresql://<demo-user>:<demo-password>@localhost:5432/<demo-database>'
$env:DIRECT_URL = $env:DATABASE_URL
$env:NODE_ENV = 'test'
$env:DEMO_DATABASE_ENV = 'demo'
$env:DEMO_DATABASE_FINGERPRINT = npm exec tsx -- -e "import { databaseIdentity } from './prisma/demo-import/core.ts'; console.log(databaseIdentity(process.env.DATABASE_URL).fingerprint)"
npx prisma migrate deploy
```

The fingerprint contains only protocol, lowercase host, port and database name. Credentials are excluded.

## Dry run

Dry run is the default. It reads the approved demo database to detect identities but writes nothing:

```powershell
npm run demo:import -- --confirm-fingerprint=$env:DEMO_DATABASE_FINGERPRINT
```

Legacy seed accounts are conflicts unless a human-reviewed mapping is supplied. Copy `prisma/demo-import/reviewed-mapping.example.json` outside source control, verify every source ID/email pair against the dry-run report, and pass it explicitly:

```powershell
npm run demo:import -- --confirm-fingerprint=$env:DEMO_DATABASE_FINGERPRINT --reviewed-mapping=C:\safe\reviewed-demo-mapping.json
```

Display names never establish identity. An adopted account must have the reviewed email, `CREATOR` role and matching creator-profile display name. Existing user and operational profile fields are preserved.

## Approved write

Only after reviewing a conflict-free dry run:

```powershell
$env:DEMO_DATA_IMPORT_ENABLED = 'true'
npm run demo:import -- --write --confirm-fingerprint=$env:DEMO_DATABASE_FINGERPRINT --reviewed-mapping=C:\safe\reviewed-demo-mapping.json
```

Missing accounts receive unusable random password hashes. The import runs in one transaction and records a completed `DemoDatasetImport`. Re-running the same manifest reports 500 creators, 50 brands, 150 opportunities and 3,000 evidence events as unchanged.

## Validation queries

Run only against the approved demo database:

```sql
SELECT count(*) FROM "CreatorMlProfile" WHERE namespace = 'africre8-demo-v2' AND synthetic;
SELECT count(*) FROM "CreatorAudienceMarket" m JOIN "CreatorMlProfile" p ON p.id = m."creatorMlProfileId" WHERE p.namespace = 'africre8-demo-v2';
SELECT count(*) FROM "CreatorDeliverableCapability" c JOIN "CreatorMlProfile" p ON p.id = c."creatorMlProfileId" WHERE p.namespace = 'africre8-demo-v2';
SELECT count(*) FROM "CreatorCommercialRate" r JOIN "CreatorMlProfile" p ON p.id = r."creatorMlProfileId" WHERE p.namespace = 'africre8-demo-v2';
SELECT count(*) FROM "OpportunityMlProfile" WHERE namespace = 'africre8-demo-v2' AND synthetic;
SELECT count(*) FROM "DemoMlEvidenceEvent" WHERE namespace = 'africre8-demo-v2' AND synthetic;
SELECT count(*) FROM "Campaign";
SELECT count(*) FROM "Transaction";
SELECT count(*) FROM "Dispute";
```

Expected ML counts are 500 profiles, 2,000 audience markets, 2,631 capabilities, 2,631 rates, 150 opportunity profiles and 3,000 evidence events. Capture operational-table counts before and after import; they must not change.

## Reset the disposable database

After verifying the target name again:

```powershell
dropdb africre8_demo
createdb africre8_demo
npx prisma migrate deploy
```

Never run reset commands against a shared database. Synthetic portrait assets remain pending, so newly created profiles have no portrait or portfolio images. Demo opportunities are operational display records, but synthetic historical outcomes remain isolated in `DemoMlEvidenceEvent`.
