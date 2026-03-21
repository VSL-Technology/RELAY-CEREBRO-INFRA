import { getPrisma } from "../lib/prisma.js";

export async function ensureDefaultTenant() {
  const prisma = getPrisma();

  try {
    const existing = await prisma.tenant.findUnique({
      where: { slug: "default" }
    });

    if (existing) return existing;

    return await prisma.tenant.create({
      data: {
        name: "Default",
        slug: "default"
      }
    });
  } catch (error) {
    console.error("Erro ao garantir tenant default:", error);
    return null;
  }
}

export default ensureDefaultTenant;
