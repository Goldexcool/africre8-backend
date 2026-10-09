ALTER TYPE "CampaignStatus" ADD VALUE 'cancelled';
ALTER TYPE "CampaignStatus" ADD VALUE 'refund_processing';
ALTER TYPE "CampaignStatus" ADD VALUE 'refund_failed';
ALTER TYPE "CampaignStatus" ADD VALUE 'refunded';
ALTER TYPE "TransactionKind" ADD VALUE 'REFUND';
