/*
  Warnings:

  - You are about to drop the column `apiKey` on the `Tenant` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[subdomain]` on the table `Tenant` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "public"."Conversation" DROP CONSTRAINT "Conversation_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ConversationLog" DROP CONSTRAINT "ConversationLog_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Event" DROP CONSTRAINT "Event_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Lead" DROP CONSTRAINT "Lead_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Message" DROP CONSTRAINT "Message_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Metric" DROP CONSTRAINT "Metric_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Usage" DROP CONSTRAINT "Usage_tenantId_fkey";

-- DropIndex
DROP INDEX "public"."Tenant_apiKey_key";

-- AlterTable
ALTER TABLE "public"."Tenant" DROP COLUMN "apiKey",
ADD COLUMN     "blurPx" TEXT,
ADD COLUMN     "botBg" TEXT,
ADD COLUMN     "botText" TEXT,
ADD COLUMN     "brandColor" TEXT,
ADD COLUMN     "brandHover" TEXT,
ADD COLUMN     "branding" JSONB,
ADD COLUMN     "emailFrom" TEXT,
ADD COLUMN     "emailTo" TEXT,
ADD COLUMN     "fontFamily" TEXT,
ADD COLUMN     "glassBg" TEXT,
ADD COLUMN     "glassTop" TEXT,
ADD COLUMN     "googleClientId" TEXT,
ADD COLUMN     "googleClientSecret" TEXT,
ADD COLUMN     "googleRedirectUri" TEXT,
ADD COLUMN     "googleTokens" JSONB,
ADD COLUMN     "headerGlow" TEXT,
ADD COLUMN     "openaiKey" TEXT,
ADD COLUMN     "settings" JSONB,
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPass" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "smtpUser" TEXT,
ADD COLUMN     "subdomain" TEXT,
ADD COLUMN     "userBg" TEXT,
ADD COLUMN     "userText" TEXT,
ADD COLUMN     "watermarkUrl" TEXT;

-- CreateTable
CREATE TABLE "public"."TagDictionary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "keywords" TEXT[],

    CONSTRAINT "TagDictionary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TagDictionary_tenantId_idx" ON "public"."TagDictionary"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TagDictionary_tenantId_category_key" ON "public"."TagDictionary"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_subdomain_key" ON "public"."Tenant"("subdomain");

-- AddForeignKey
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Usage" ADD CONSTRAINT "Usage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Metric" ADD CONSTRAINT "Metric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationLog" ADD CONSTRAINT "ConversationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TagDictionary" ADD CONSTRAINT "TagDictionary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
