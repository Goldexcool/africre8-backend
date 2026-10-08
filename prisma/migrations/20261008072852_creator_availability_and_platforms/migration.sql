
-- CreateEnum
CREATE TYPE "Availability" AS ENUM ('available', 'busy', 'booked');

-- AlterEnum
BEGIN;
CREATE TYPE "Platform_new" AS ENUM ('instagram', 'tiktok', 'youtube', 'x', 'facebook');
ALTER TABLE "SocialAccount" ALTER COLUMN "platform" TYPE "Platform_new" USING ("platform"::text::"Platform_new");
ALTER TABLE "DeliverableRequirement" ALTER COLUMN "platform" TYPE "Platform_new" USING ("platform"::text::"Platform_new");
ALTER TYPE "Platform" RENAME TO "Platform_old";
ALTER TYPE "Platform_new" RENAME TO "Platform";
DROP TYPE "public"."Platform_old";
COMMIT;

-- AlterTable
ALTER TABLE "CreatorProfile" DROP COLUMN "available",
ADD COLUMN     "availability" "Availability" NOT NULL DEFAULT 'available',
ADD COLUMN     "priceToKobo" INTEGER;

