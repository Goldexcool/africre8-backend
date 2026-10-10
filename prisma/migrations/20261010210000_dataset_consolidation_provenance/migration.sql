ALTER TABLE "CreatorMlProfile"
  ADD COLUMN "featureProvenance" JSONB,
  ADD COLUMN "dataQuality" JSONB;

ALTER TABLE "OpportunityMlProfile"
  ADD COLUMN "featureProvenance" JSONB,
  ADD COLUMN "dataQuality" JSONB;

CREATE TABLE "DatasetConsolidationRun" (
  "id" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "planHash" TEXT NOT NULL,
  "productionFingerprint" TEXT NOT NULL,
  "syntheticFingerprint" TEXT NOT NULL,
  "targetDatabaseFingerprint" TEXT NOT NULL,
  "scope" JSONB NOT NULL,
  "counts" JSONB NOT NULL,
  "conflicts" JSONB NOT NULL,
  "backupReference" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DatasetConsolidationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DatasetRecordProvenance" (
  "id" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceRecordHash" TEXT NOT NULL,
  "synthetic" BOOLEAN NOT NULL,
  "consolidationRunId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DatasetRecordProvenance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DatasetConsolidationRun_planHash_key" ON "DatasetConsolidationRun"("planHash");
CREATE INDEX "DatasetConsolidationRun_namespace_status_idx" ON "DatasetConsolidationRun"("namespace", "status");
CREATE UNIQUE INDEX "DatasetRecordProvenance_namespace_entityType_entityId_key" ON "DatasetRecordProvenance"("namespace", "entityType", "entityId");
CREATE UNIQUE INDEX "DatasetRecordProvenance_namespace_entityType_sourceId_key" ON "DatasetRecordProvenance"("namespace", "entityType", "sourceId");
CREATE INDEX "DatasetRecordProvenance_sourceKind_synthetic_idx" ON "DatasetRecordProvenance"("sourceKind", "synthetic");

ALTER TABLE "DatasetRecordProvenance"
  ADD CONSTRAINT "DatasetRecordProvenance_consolidationRunId_fkey"
  FOREIGN KEY ("consolidationRunId") REFERENCES "DatasetConsolidationRun"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
