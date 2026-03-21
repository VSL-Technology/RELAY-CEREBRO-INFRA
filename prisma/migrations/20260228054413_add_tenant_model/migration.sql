-- AlterTable
ALTER TABLE "relay"."Router" ADD COLUMN     "tenantId" TEXT;

-- CreateTable
CREATE TABLE "relay"."Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "relay"."Tenant"("slug");

-- CreateIndex
CREATE INDEX "Router_tenantId_idx" ON "relay"."Router"("tenantId");

-- AddForeignKey
ALTER TABLE "relay"."Router" ADD CONSTRAINT "Router_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "relay"."Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
