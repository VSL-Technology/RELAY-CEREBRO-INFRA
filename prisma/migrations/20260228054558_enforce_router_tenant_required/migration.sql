/*
  Warnings:

  - Made the column `tenantId` on table `Router` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "relay"."Router" DROP CONSTRAINT "Router_tenantId_fkey";

-- AlterTable
ALTER TABLE "relay"."Router" ALTER COLUMN "tenantId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "relay"."Router" ADD CONSTRAINT "Router_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "relay"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
