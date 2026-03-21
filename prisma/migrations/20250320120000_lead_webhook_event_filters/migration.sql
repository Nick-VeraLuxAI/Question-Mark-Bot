-- Per-endpoint subscription to canonical integration events (empty array = receive all).
ALTER TABLE "LeadWebhook" ADD COLUMN "events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
