-- One live refund per campaign, like payouts. Payout and refund exclude each other through the campaign state machine.
CREATE UNIQUE INDEX "one_live_refund_per_campaign" ON "Transaction" ("campaignId") WHERE "kind" = 'REFUND' AND "status" <> 'failed';
