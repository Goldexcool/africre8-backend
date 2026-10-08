
-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "instructions" JSONB,
ADD COLUMN     "method" TEXT,
ADD COLUMN     "providerStatus" TEXT;
