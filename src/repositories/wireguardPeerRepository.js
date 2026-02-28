import prisma from "../lib/prisma.js";

function toDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toBigIntOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    return BigInt(value);
  } catch (_) {
    return null;
  }
}

function optional(value) {
  return value === undefined ? undefined : value;
}

export async function findPeerByPublicKey(publicKey) {
  if (!publicKey) throw new Error("publicKey is required");
  return prisma.wireguardPeer.findUnique({
    where: { publicKey },
    include: {
      router: true
    }
  });
}

export async function upsertPeer({
  routerId,
  publicKey,
  allowedIps,
  endpoint,
  persistentKeepalive,
  desiredStatus
} = {}) {
  if (!routerId) throw new Error("routerId is required");
  if (!publicKey) throw new Error("publicKey is required");
  if (!allowedIps) throw new Error("allowedIps is required");

  const keepalive =
    persistentKeepalive === undefined || persistentKeepalive === null
      ? 25
      : Number(persistentKeepalive);

  return prisma.wireguardPeer.upsert({
    where: { publicKey },
    create: {
      routerId,
      publicKey,
      allowedIps,
      endpoint: optional(endpoint),
      keepalive,
      persistentKeepalive: keepalive,
      desiredState: optional(desiredStatus) || "PENDING"
    },
    update: {
      routerId,
      allowedIps,
      endpoint: optional(endpoint),
      keepalive,
      persistentKeepalive: keepalive,
      desiredState: optional(desiredStatus)
    },
    include: {
      router: true
    }
  });
}

export async function updatePeerActual({
  publicKey,
  actualStatus,
  lastHandshakeAt,
  bytesRx,
  bytesTx
} = {}) {
  if (!publicKey) throw new Error("publicKey is required");

  return prisma.wireguardPeer.update({
    where: { publicKey },
    data: {
      actualState: optional(actualStatus),
      status: optional(actualStatus),
      lastHandshake: toDateOrNull(lastHandshakeAt),
      bytesRx: toBigIntOrNull(bytesRx),
      bytesTx: toBigIntOrNull(bytesTx)
    },
    include: {
      router: true
    }
  });
}

export async function listPeersDesired() {
  return prisma.wireguardPeer.findMany({
    where: {
      desiredState: {
        not: "REMOVED"
      }
    },
    include: {
      router: true
    },
    orderBy: {
      updatedAt: "desc"
    }
  });
}

export default {
  findPeerByPublicKey,
  upsertPeer,
  updatePeerActual,
  listPeersDesired
};
