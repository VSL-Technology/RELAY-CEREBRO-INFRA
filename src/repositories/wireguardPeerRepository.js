import prisma from "../lib/prisma.js";
import { validateWgPublicKey } from "../bootstrap/validators.js";

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

export async function findPeerByPublicKey(publicKey, { tenantId } = {}) {
  const normalizedPublicKey = validateWgPublicKey(publicKey);
  const where = tenantId
    ? {
        publicKey: normalizedPublicKey,
        router: {
          tenantId
        }
      }
    : { publicKey: normalizedPublicKey };

  return prisma.wireguardPeer.findFirst({
    where,
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
  if (!allowedIps) throw new Error("allowedIps is required");
  const normalizedPublicKey = validateWgPublicKey(publicKey);

  const keepalive =
    persistentKeepalive === undefined || persistentKeepalive === null
      ? 25
      : Number(persistentKeepalive);

  return prisma.wireguardPeer.upsert({
    where: { publicKey: normalizedPublicKey },
    create: {
      routerId,
      publicKey: normalizedPublicKey,
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
  const normalizedPublicKey = validateWgPublicKey(publicKey);

  return prisma.wireguardPeer.update({
    where: { publicKey: normalizedPublicKey },
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

export async function listPeersDesired({ tenantId } = {}) {
  const where = {
    desiredState: {
      not: "REMOVED"
    }
  };

  if (tenantId) {
    where.router = {
      tenantId
    };
  }

  return prisma.wireguardPeer.findMany({
    where,
    include: {
      router: true
    },
    orderBy: {
      updatedAt: "desc"
    }
  });
}

export async function listPeersWithRouter({ tenantId } = {}) {
  const where = tenantId
    ? {
        router: {
          tenantId
        }
      }
    : undefined;

  return prisma.wireguardPeer.findMany({
    where,
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
  listPeersWithRouter,
  upsertPeer,
  updatePeerActual,
  listPeersDesired
};
