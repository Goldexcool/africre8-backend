-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('VERIFIED', 'FAILED');

-- DropTable
DROP TABLE "IdVerification";

-- DropEnum
DROP TYPE "IdStatus";

-- CreateTable
CREATE TABLE "KycVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "idType" TEXT NOT NULL DEFAULT 'NIN',
    "idLast4" TEXT NOT NULL,
    "idHash" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KycVerification_userId_createdAt_idx" ON "KycVerification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "KycVerification_idHash_status_idx" ON "KycVerification"("idHash", "status");


-- One verified ID, one account.
CREATE UNIQUE INDEX "KycVerification_idHash_verified_key" ON "KycVerification"("idHash") WHERE status = 'VERIFIED';
