import { createHash } from 'node:crypto';

export {
  NGN_PER_USD,
  OPERATIONAL_ML_NAMESPACE,
  OPERATIONAL_RATE_VERSION,
  OPERATIONAL_SCHEMA_VERSION,
  mapOperationalCreator,
  mapOperationalOpportunity,
  operationalFormat,
  operationalRecordHash,
  platformFromDeliverable,
} from '../../src/ml/operational-profile.js';

export function assertApprovedEnrichmentTarget(input: {
  databaseUrl?: string;
  expectedFingerprint?: string;
  confirmedFingerprint?: string;
  targetLabel?: string;
  confirmedTargetLabel?: string;
  enabled?: string;
  confirmation?: string;
  backupConfirmed?: string;
  backupReference?: string;
  confirmedBackupReference?: string;
  write: boolean;
}) {
  if (!input.databaseUrl) throw new Error('DATABASE_URL is required');
  const url = new URL(input.databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const canonicalTarget = `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}/${database}`;
  const fingerprint = createHash('sha256')
    .update(canonicalTarget)
    .digest('hex');
  if (!input.targetLabel || input.targetLabel.length < 3)
    throw new Error('ML_ENRICHMENT_TARGET_LABEL is required');
  if (input.targetLabel !== input.confirmedTargetLabel)
    throw new Error('target label confirmation is missing or incorrect');
  if (input.expectedFingerprint !== fingerprint)
    throw new Error(
      'ML_ENRICHMENT_TARGET_FINGERPRINT does not match DATABASE_URL',
    );
  if (input.confirmedFingerprint !== fingerprint)
    throw new Error('CLI fingerprint confirmation is missing or incorrect');
  if (input.write) {
    if (input.enabled !== 'true')
      throw new Error('ML_ENRICHMENT_ENABLED=true is required for writes');
    if (input.confirmation !== 'ENRICH_EXISTING_ML_PROFILES')
      throw new Error('enrichment confirmation is missing or incorrect');
    if (input.backupConfirmed !== 'true')
      throw new Error(
        'ML_ENRICHMENT_BACKUP_CONFIRMED=true is required for writes',
      );
    if (!input.backupReference || input.backupReference.length < 8)
      throw new Error('ML_ENRICHMENT_BACKUP_REFERENCE is required for writes');
    if (input.backupReference !== input.confirmedBackupReference)
      throw new Error('backup reference confirmation is missing or incorrect');
  }
  return { database, host: url.hostname.toLowerCase(), fingerprint };
}
