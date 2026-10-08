-- CreateEnum
CREATE TYPE "OpportunityVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- DropIndex
DROP INDEX "Interest_brandId_creatorId_key";

-- DropIndex
DROP INDEX "Swipe_brandId_creatorId_key";

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "brandReadAt" TIMESTAMP(3),
ADD COLUMN     "creatorReadAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Interest" ADD COLUMN     "message" TEXT,
ADD COLUMN     "opportunityId" TEXT,
ADD COLUMN     "scopeKey" TEXT NOT NULL DEFAULT 'general';

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "opportunityId" TEXT;

-- AlterTable
ALTER TABLE "Swipe" ADD COLUMN     "scopeKey" TEXT NOT NULL DEFAULT 'general';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "openToInvites" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "budgetKobo" INTEGER NOT NULL,
    "deadlineDays" INTEGER NOT NULL,
    "deliverables" TEXT[],
    "coverImageUrl" TEXT,
    "visibility" "OpportunityVisibility" NOT NULL DEFAULT 'PUBLIC',
    "applicationLimit" INTEGER,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'PUBLISHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Opportunity_status_visibility_idx" ON "Opportunity"("status", "visibility");

-- CreateIndex
CREATE INDEX "Opportunity_brandId_idx" ON "Opportunity"("brandId");

-- CreateIndex
CREATE INDEX "Interest_opportunityId_status_idx" ON "Interest"("opportunityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Interest_brandId_creatorId_scopeKey_key" ON "Interest"("brandId", "creatorId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Swipe_brandId_creatorId_scopeKey_key" ON "Swipe"("brandId", "creatorId", "scopeKey");

-- AddForeignKey
ALTER TABLE "Interest" ADD CONSTRAINT "Interest_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

