import { PrismaClient } from '@prisma/client';

let instance: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!instance) {
    instance = new PrismaClient();
  }
  return instance;
}

export async function disconnectPrisma(): Promise<void> {
  if (instance) {
    await instance.$disconnect();
    instance = null;
  }
}
