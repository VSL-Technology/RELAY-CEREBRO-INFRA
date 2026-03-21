import { getPrisma } from "./prisma.js";

export async function getDefaultTenant() {
  const prisma = getPrisma();

  const existing = await prisma.tenant.findUnique({
    where: { slug: "default" }
  });

  if (existing) return existing;

  return prisma.tenant.create({
    data: {
      name: "Default",
      slug: "default"
    }
  });
}

export async function listTenants() {
  const prisma = getPrisma();
  const tenants = await prisma.tenant.findMany({
    orderBy: {
      createdAt: "asc"
    }
  });

  if (tenants.length > 0) return tenants;
  const defaultTenant = await getDefaultTenant();
  return defaultTenant ? [defaultTenant] : [];
}

export default getDefaultTenant;
