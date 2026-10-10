-- AlterEnum
ALTER TYPE "DisputeStatus" ADD VALUE 'RESOLVED_SPLIT';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "payoutKobo" INTEGER;

-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "noResponse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "respondBy" TIMESTAMP(3),
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "respondedById" TEXT,
ADD COLUMN     "responseEvidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "responseReason" TEXT,
ADD COLUMN     "splitBrandKobo" INTEGER,
ADD COLUMN     "splitCreatorKobo" INTEGER;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "purpose" TEXT;

-- CreateTable
CREATE TABLE "DisputeNote" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DisputeNote_disputeId_createdAt_idx" ON "DisputeNote"("disputeId", "createdAt");

-- CreateIndex
CREATE INDEX "Dispute_status_createdAt_idx" ON "Dispute"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "DisputeNote" ADD CONSTRAINT "DisputeNote_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
