-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "providerReference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_providerReference_key" ON "Transaction"("providerReference");

