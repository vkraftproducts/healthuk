// Raw, UNSCOPED Prisma client. Only for migrations, seeds, workers that set their own context,
// and tests. ESLint forbids importing '@hub/db/raw' from request-handling code (CLAUDE.md #2).
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export { PrismaClient };
export * from './generated/client.js';

export function createRawClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
