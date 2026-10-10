-- Additive ML feature and demo-evidence storage. No operational campaign,
-- payment, matching, dispute, or audit semantics are changed.

CREATE TABLE "CreatorMlProfile" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "sourceCreatorId" TEXT NOT NULL,
    "sourceRecordHash" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "sourceKind" TEXT NOT NULL,
    "portfolioDescription" TEXT,
    "contentTone" TEXT,
    "contentLanguages" TEXT[] NOT NULL,
    "audienceInterests" TEXT[] NOT NULL,
    "creativeStyles" TEXT[] NOT NULL,
    "productionCapabilities" TEXT[] NOT NULL,
    "typicalLeadTimeDays" INTEGER,
    "imageAssetId" TEXT,
    "sourceAvailability" TEXT,
    "commercialExperience" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorMlProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorAudienceMarket" (
    "id" TEXT NOT NULL,
    "creatorMlProfileId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "sharePercent" DECIMAL(5,2) NOT NULL,
    CONSTRAINT "CreatorAudienceMarket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorDeliverableCapability" (
    "id" TEXT NOT NULL,
    "creatorMlProfileId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "format" TEXT NOT NULL,
    CONSTRAINT "CreatorDeliverableCapability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorCommercialRate" (
    "id" TEXT NOT NULL,
    "creatorMlProfileId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "format" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "normalizedUsd" DECIMAL(18,2) NOT NULL,
    "rateVersion" TEXT NOT NULL,
    "purpose" TEXT,
    "includes" TEXT[] NOT NULL,
    "usageRightsMultipliers" JSONB NOT NULL,
    "categoryExclusivity30DaysMultiplier" DECIMAL(8,4) NOT NULL,
    CONSTRAINT "CreatorCommercialRate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpportunityMlProfile" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "sourceOpportunityId" TEXT NOT NULL,
    "sourceRecordHash" TEXT NOT NULL,
    "sourceBrandId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "industry" TEXT,
    "product" TEXT,
    "objective" TEXT,
    "tone" TEXT,
    "creativeConcept" TEXT,
    "crossCategoryRationale" TEXT,
    "callToAction" TEXT,
    "budgetAmount" DECIMAL(18,2) NOT NULL,
    "budgetCurrency" TEXT NOT NULL,
    "budgetNormalizedUsd" DECIMAL(18,2) NOT NULL,
    "budgetRateVersion" TEXT NOT NULL,
    "budgetPurpose" TEXT,
    "budgetScope" TEXT,
    "compatibleNiches" TEXT[] NOT NULL,
    "preferredLanguages" TEXT[] NOT NULL,
    "preferredPlatforms" TEXT[] NOT NULL,
    "requiredLanguages" TEXT[] NOT NULL,
    "requiredPlatforms" TEXT[] NOT NULL,
    "keyMessages" TEXT[] NOT NULL,
    "successMetrics" TEXT[] NOT NULL,
    "targetAudienceDescription" TEXT,
    "targetAudienceInterests" TEXT[] NOT NULL,
    "targetAudienceMarkets" TEXT[] NOT NULL,
    "deliverables" JSONB NOT NULL,
    "usageRights" JSONB NOT NULL,
    "timeline" JSONB,
    "brandSnapshot" JSONB,
    "heldOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OpportunityMlProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DemoMlEvidenceEvent" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT true,
    "sourceEventId" TEXT NOT NULL,
    "sourceRecordHash" TEXT NOT NULL,
    "sourceJourneyId" TEXT NOT NULL,
    "sourceContractId" TEXT,
    "previousSourceEventId" TEXT,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "details" JSONB NOT NULL,
    "creatorMlProfileId" TEXT NOT NULL,
    "opportunityMlProfileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DemoMlEvidenceEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DemoDatasetImport" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "generatorVersion" TEXT NOT NULL,
    "manifestSha256" TEXT NOT NULL,
    "datasetFingerprint" TEXT NOT NULL,
    "databaseFingerprint" TEXT NOT NULL,
    "importerVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "counts" JSONB NOT NULL,
    "conflicts" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DemoDatasetImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorMlProfile_creatorId_key" ON "CreatorMlProfile"("creatorId");
CREATE UNIQUE INDEX "CreatorMlProfile_namespace_sourceCreatorId_key" ON "CreatorMlProfile"("namespace", "sourceCreatorId");
CREATE INDEX "CreatorMlProfile_namespace_synthetic_idx" ON "CreatorMlProfile"("namespace", "synthetic");
CREATE UNIQUE INDEX "CreatorAudienceMarket_creatorMlProfileId_countryCode_key" ON "CreatorAudienceMarket"("creatorMlProfileId", "countryCode");
CREATE INDEX "CreatorAudienceMarket_countryCode_idx" ON "CreatorAudienceMarket"("countryCode");
CREATE UNIQUE INDEX "CreatorDeliverableCapability_creatorMlProfileId_platform_format_key" ON "CreatorDeliverableCapability"("creatorMlProfileId", "platform", "format");
CREATE INDEX "CreatorDeliverableCapability_platform_format_idx" ON "CreatorDeliverableCapability"("platform", "format");
CREATE UNIQUE INDEX "CreatorCommercialRate_creatorMlProfileId_platform_format_rateVersion_key" ON "CreatorCommercialRate"("creatorMlProfileId", "platform", "format", "rateVersion");
CREATE INDEX "CreatorCommercialRate_platform_format_idx" ON "CreatorCommercialRate"("platform", "format");
CREATE INDEX "CreatorCommercialRate_currency_rateVersion_idx" ON "CreatorCommercialRate"("currency", "rateVersion");
CREATE UNIQUE INDEX "OpportunityMlProfile_opportunityId_key" ON "OpportunityMlProfile"("opportunityId");
CREATE UNIQUE INDEX "OpportunityMlProfile_namespace_sourceOpportunityId_key" ON "OpportunityMlProfile"("namespace", "sourceOpportunityId");
CREATE INDEX "OpportunityMlProfile_namespace_synthetic_idx" ON "OpportunityMlProfile"("namespace", "synthetic");
CREATE INDEX "OpportunityMlProfile_sourceBrandId_idx" ON "OpportunityMlProfile"("sourceBrandId");
CREATE UNIQUE INDEX "DemoMlEvidenceEvent_namespace_sourceEventId_key" ON "DemoMlEvidenceEvent"("namespace", "sourceEventId");
CREATE UNIQUE INDEX "DemoMlEvidenceEvent_namespace_sourceJourneyId_sequence_key" ON "DemoMlEvidenceEvent"("namespace", "sourceJourneyId", "sequence");
CREATE INDEX "DemoMlEvidenceEvent_creatorMlProfileId_occurredAt_idx" ON "DemoMlEvidenceEvent"("creatorMlProfileId", "occurredAt");
CREATE INDEX "DemoMlEvidenceEvent_opportunityMlProfileId_occurredAt_idx" ON "DemoMlEvidenceEvent"("opportunityMlProfileId", "occurredAt");
CREATE INDEX "DemoMlEvidenceEvent_sourceJourneyId_idx" ON "DemoMlEvidenceEvent"("sourceJourneyId");
CREATE UNIQUE INDEX "DemoDatasetImport_namespace_manifestSha256_databaseFingerprint_key" ON "DemoDatasetImport"("namespace", "manifestSha256", "databaseFingerprint");
CREATE INDEX "DemoDatasetImport_namespace_status_idx" ON "DemoDatasetImport"("namespace", "status");

ALTER TABLE "CreatorMlProfile" ADD CONSTRAINT "CreatorMlProfile_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorAudienceMarket" ADD CONSTRAINT "CreatorAudienceMarket_creatorMlProfileId_fkey" FOREIGN KEY ("creatorMlProfileId") REFERENCES "CreatorMlProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorDeliverableCapability" ADD CONSTRAINT "CreatorDeliverableCapability_creatorMlProfileId_fkey" FOREIGN KEY ("creatorMlProfileId") REFERENCES "CreatorMlProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorCommercialRate" ADD CONSTRAINT "CreatorCommercialRate_creatorMlProfileId_fkey" FOREIGN KEY ("creatorMlProfileId") REFERENCES "CreatorMlProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityMlProfile" ADD CONSTRAINT "OpportunityMlProfile_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DemoMlEvidenceEvent" ADD CONSTRAINT "DemoMlEvidenceEvent_creatorMlProfileId_fkey" FOREIGN KEY ("creatorMlProfileId") REFERENCES "CreatorMlProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DemoMlEvidenceEvent" ADD CONSTRAINT "DemoMlEvidenceEvent_opportunityMlProfileId_fkey" FOREIGN KEY ("opportunityMlProfileId") REFERENCES "OpportunityMlProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
