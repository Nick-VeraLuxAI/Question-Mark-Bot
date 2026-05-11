-- TenantMembership: per-user access to a tenant for the client portal (membership-scoped RBAC).

CREATE TABLE "public"."TenantMembership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantMembership_tenantId_userId_key" ON "public"."TenantMembership"("tenantId", "userId");

CREATE INDEX "TenantMembership_userId_idx" ON "public"."TenantMembership"("userId");

CREATE INDEX "TenantMembership_email_idx" ON "public"."TenantMembership"("email");

CREATE INDEX "TenantMembership_tenantId_idx" ON "public"."TenantMembership"("tenantId");

ALTER TABLE "public"."TenantMembership" ADD CONSTRAINT "TenantMembership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
