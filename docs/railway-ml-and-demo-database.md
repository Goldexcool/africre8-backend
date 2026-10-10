# Railway ML deployment and controlled dataset replacement

This procedure keeps the existing Railway PostgreSQL service and replaces its logical dataset with the reviewed union of retained production records and explicitly approved synthetic records. No live Railway action is performed by repository scripts without the administrator's database URL and confirmations.

## FastAPI service

Create a private Railway service named `africre8-ml` from this repository with **Root Directory** `/services/ml`. Use its existing `Dockerfile`, one worker, at least 2 GB RAM, `PORT=8001`, `AFRICRE8_ML_SEMANTIC_ENABLED=true`, health path `/health`, and a 600-second health timeout. Do not assign a public domain.

Configure NestJS only after FastAPI is healthy:

```text
ML_SERVICE_URL=http://${{africre8-ml.RAILWAY_PRIVATE_DOMAIN}}:8001
ML_REQUEST_TIMEOUT_MS=20000
ML_SEMANTIC_TIMEOUT_MS=120000
```

## 1. Identify and back up the exact database

Set `PUBLIC_URL` to the externally reachable HTTPS origin of the NestJS Railway service. Synthetic creator placeholders are served at `/demo-media/creators/<source-id>.svg`; no R2 credentials or object writes are required for them. Existing production `avatarUrl` and `portfolio` values remain unchanged and continue to depend on the configured Cloudflare R2 service and `/media/*` proxy.

For synthetic portraits, complete and verify the offline 10-image pool workflow in `docs/synthetic-portraits.md` before any Railway action. Upload the 10 optimized WebP files to `africre8/demo/portrait-pool/`, verify sample media URLs, then run the fingerprint-confirmed display-override activation. Never copy a production creator's object key to a synthetic identity or overwrite a retained production avatar.

1. In Railway, record the project, environment, PostgreSQL service name, database name, service ID, and volume ID. Have a second administrator confirm them.
2. Record baseline counts for users, creators, brands, opportunities, interests, matches, campaigns, submissions, disputes, transactions, notifications, and Prisma migrations.
3. Create a Railway volume backup and an encrypted custom-format logical backup:

   ```powershell
   pg_dump --format=custom --no-owner --file=<encrypted-restricted-path> $env:DATABASE_URL
   ```

4. Restore the dump into a disposable PostgreSQL instance using `pg_restore --no-owner --exit-on-error`.
5. Compare migration history, table counts, authentication samples, recent campaigns, and financial references. Record a backup reference only after the restore succeeds.

The production backup and restored clone are the authorized production snapshot. Never commit either one.

## 2. Prepare the reviewed scope on the restored snapshot

Copy `prisma/consolidation/scope.example.json` outside source control. Review every synthetic ID and identity mapping. Empty arrays retain production data without adding synthetic identities. Synthetic evidence is allowed only for newly synthetic creators and only when every related opportunity is approved or mapped.

Use process-scoped variables; do not write the database URL to `.env`:

```powershell
$env:DATABASE_URL = '<restored-snapshot-or-existing-railway-url>'
$env:DIRECT_URL = $env:DATABASE_URL
$env:CONSOLIDATION_TARGET_LABEL = '<project>/<environment>/<postgres-service>/<database>'
$env:CONSOLIDATION_ENABLED = 'false'
$env:CONSOLIDATION_BACKUP_CONFIRMED = 'false'
$env:CONSOLIDATION_BACKUP_REFERENCE = '<successfully-restored-backup-reference>'
$env:CONSOLIDATION_TARGET_FINGERPRINT = npm exec tsx -- -e "import { consolidationDatabaseIdentity } from './prisma/consolidation/core.ts'; console.log(consolidationDatabaseIdentity(process.env.DATABASE_URL).fingerprint)"
$targetFingerprint = $env:CONSOLIDATION_TARGET_FINGERPRINT
$targetLabel = $env:CONSOLIDATION_TARGET_LABEL
$backupReference = $env:CONSOLIDATION_BACKUP_REFERENCE
$scope = '<absolute-path-to-reviewed-scope.json>'
```

Apply migrations to the restored clone, then generate the read-only reconciliation report:

```powershell
npx prisma migrate status
npx prisma migrate deploy
node --import tsx prisma/consolidate-dataset.ts --scope=$scope --confirm-target-fingerprint=$targetFingerprint --confirm-target-label=$targetLabel | Tee-Object consolidation-report.json
```

Review `productionSnapshotFingerprint`, `syntheticDatasetFingerprint`, `scopeHash`, `planHash`, retained counts, approved synthetic counts, identity mappings, controlled ML reconciliation, and every conflict. The write command refuses any conflict.

## 3. Simulate the complete replacement on the restored clone

Copy the exact fingerprint and plan hash from the reviewed report:

```powershell
$productionFingerprint = '<reviewed-productionSnapshotFingerprint>'
$planHash = '<reviewed-planHash>'
$env:CONSOLIDATION_ENABLED = 'true'
$env:CONSOLIDATION_BACKUP_CONFIRMED = 'true'

node --import tsx prisma/consolidate-dataset.ts --write --scope=$scope --batch-size=25 --confirm-target-fingerprint=$targetFingerprint --confirm-target-label=$targetLabel --confirm-production-fingerprint=$productionFingerprint --confirm-plan-hash=$planHash --confirm-consolidation=APPLY_REVIEWED_CONSOLIDATION --confirm-backup-reference=$backupReference

$env:CONSOLIDATION_ENABLED = 'false'
$env:CONSOLIDATION_BACKUP_CONFIRMED = 'false'
npm run data:consolidate:verify -- --confirm-target-fingerprint=$targetFingerprint --confirm-target-label=$targetLabel
```

Start isolated NestJS and FastAPI instances with mock payments, no Payaza secrets, no Brevo key, a separate Redis namespace, and the restored clone. Test authentication, creator and brand discovery, opportunities, applications, matches, campaigns, structured recommendations, semantic recommendations, credibility, and financial-record visibility. Confirm no outbound provider call occurred.

Rerun the same scope on the clone and verify that user, creator, brand, opportunity, campaign, transaction, and evidence counts do not duplicate. Preserve the final reconciliation and verification reports outside source control.

## 4. Controlled replacement in the existing Railway service

1. Schedule a maintenance window and prevent API and worker writes. Do not run the worker during replacement.
2. Take and restore-test a fresh final backup. Production may have changed since the earlier snapshot, so its fingerprint and plan hash must be regenerated.
3. Point only the administrator process at the confirmed existing Railway database. Recompute `CONSOLIDATION_TARGET_FINGERPRINT`; have a second administrator compare the Railway identifiers and target label.
4. Run `prisma migrate status`, review the additive migration, then run `prisma migrate deploy`.
5. Run the dry-run command against the paused live database. Review the fresh production fingerprint, plan hash, counts, and conflicts. Do not reuse hashes from the restored clone.
6. With the fresh restored-backup reference, enable the two write environment switches and run the exact reviewed write command.
7. Immediately disable both write switches and run `data:consolidate:verify`.
   The report must show zero invalid synthetic image references. Test at least one generated demo avatar through the public NestJS URL and separately spot-check retained production `/media/*` images; database validation alone cannot prove that remote R2 objects or permissions are available.
8. Start an isolated API process against the consolidated database with `PAYMENT_PROVIDER=mock`. Verify logins, discovery, opportunities, relationships, campaigns, recommendations, credibility, and transaction visibility.
9. Restore the normal API and worker only after verification passes. Monitor PostgreSQL, Redis, NestJS, and FastAPI logs and metrics.

## 5. Rollback

If migration, consolidation, verification, or smoke testing fails, keep application writes disabled. Restore the final logical backup into the existing PostgreSQL service using the team's reviewed Railway restore procedure, or use the verified Railway volume backup. Confirm migrations, counts, authentication, recent campaigns, and financial references before restoring API and worker access.

Do not attempt piecemeal deletion of synthetic records during an incident. The backup is the rollback boundary. Retain the failed reconciliation report and `DatasetConsolidationRun` details for diagnosis.

## Isolation guarantees

- No uncontrolled `DROP`, `TRUNCATE`, reset, or cascade operation is used.
- Existing authentication and operational rows are never updated by the consolidation engine.
- Payments, payouts, webhooks, notifications, and outbound integrations are never invoked.
- ML child-row replacement is restricted to profiles in the reviewed unified plan and is transactional.
- New synthetic identities use `.invalid` email addresses, unusable passwords, and explicit provenance.
- Synthetic evidence can attach only to explicitly approved new synthetic creators.
- Private generator truth is never loaded.
- The legacy `demo:*` commands reject Railway and production targets and remain isolated-test-only.
