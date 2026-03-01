import prisma from "../lib/prisma.js";
import { getDefaultTenant } from "../lib/getDefaultTenant.js";

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

async function resolveTenantId(tenantId) {
  if (tenantId) return tenantId;

  const existingDefault = await getDefaultTenant();
  if (existingDefault && existingDefault.id) {
    return existingDefault.id;
  }

  const createdDefault = await prisma.tenant.upsert({
    where: { slug: "default" },
    update: {},
    create: {
      name: "Default",
      slug: "default"
    }
  });
  return createdDefault.id;
}

export async function upsertRouter({
  tenantId,
  busId,
  nome,
  identity,
  ipLan,
  apiUser,
  apiPasswordEncrypted,
  portaApi,
  portaSsh,
  wgPublicKey,
  wgIp,
  endpoint,
  keepalive,
  status,
  desiredState
} = {}) {
  if (!busId) throw new Error("busId is required");

  const resolvedTenantId = await resolveTenantId(tenantId);
  const normalizedWgPublicKey = wgPublicKey || `pending:${busId}`;
  const normalizedWgIp = wgIp || "0.0.0.0/32";

  return prisma.router.upsert({
    where: { busId },
    create: {
      tenantId: resolvedTenantId,
      busId,
      nome: optional(nome),
      identity: optional(identity),
      ipLan: optional(ipLan),
      apiUser: optional(apiUser),
      apiPasswordEncrypted: optional(apiPasswordEncrypted),
      portaApi: optional(portaApi),
      portaSsh: optional(portaSsh),
      wgPublicKey: normalizedWgPublicKey,
      wgIp: normalizedWgIp,
      endpoint: optional(endpoint),
      keepalive: optional(keepalive),
      status: optional(status),
      desiredState: optional(desiredState) || "PENDING"
    },
    update: {
      nome: optional(nome),
      identity: optional(identity),
      ipLan: optional(ipLan),
      apiUser: optional(apiUser),
      apiPasswordEncrypted: optional(apiPasswordEncrypted),
      portaApi: optional(portaApi),
      portaSsh: optional(portaSsh),
      tenantId: optional(tenantId),
      wgPublicKey: optional(wgPublicKey),
      wgIp: optional(wgIp),
      endpoint: optional(endpoint),
      keepalive: optional(keepalive),
      status: optional(status),
      desiredState: optional(desiredState)
    }
  });
}

export async function updateRouterWireguardActual({
  busId,
  routerId,
  statusWireguard,
  lastHandshakeAt,
  bytesRx,
  bytesTx,
  lastSeenAt
} = {}) {
  if (!busId && !routerId) {
    throw new Error("busId or routerId is required");
  }

  const where = routerId ? { id: routerId } : { busId };

  return prisma.router.update({
    where,
    data: {
      statusWireguard: optional(statusWireguard),
      actualState: optional(statusWireguard),
      lastHandshake: toDateOrNull(lastHandshakeAt),
      lastSeenAt: toDateOrNull(lastSeenAt),
      bytesRx: toBigIntOrNull(bytesRx),
      bytesTx: toBigIntOrNull(bytesTx)
    },
    include: {
      peers: true
    }
  });
}

export async function listRoutersWithPeers({ tenantId } = {}) {
  return listRouters({ tenantId });
}

export async function listRouters({ tenantId } = {}) {
  const where = tenantId ? { tenantId } : undefined;
  return prisma.router.findMany({
    where,
    include: {
      peers: true
    },
    orderBy: {
      updatedAt: "desc"
    }
  });
}

export default {
  listRouters,
  upsertRouter,
  updateRouterWireguardActual,
  listRoutersWithPeers
};
