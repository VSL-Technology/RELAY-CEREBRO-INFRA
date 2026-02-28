-- CreateTable
CREATE TABLE "Router" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "wgPublicKey" TEXT NOT NULL,
    "wgIp" TEXT NOT NULL,
    "endpoint" TEXT,
    "desiredState" TEXT NOT NULL DEFAULT 'PENDING',
    "actualState" TEXT,
    "lastHandshake" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Router_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WireguardPeer" (
    "id" TEXT NOT NULL,
    "routerId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "allowedIps" TEXT NOT NULL,
    "keepalive" INTEGER NOT NULL DEFAULT 25,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastHandshake" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WireguardPeer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Router_busId_key" ON "Router"("busId");

-- AddForeignKey
ALTER TABLE "WireguardPeer" ADD CONSTRAINT "WireguardPeer_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
