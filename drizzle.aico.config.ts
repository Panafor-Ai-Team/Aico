import * as dotenv from 'dotenv';
import type { Config } from 'drizzle-kit';

dotenv.config();

/**
 * Aico's own tables (`aicoOrganization.ts`) and their journal. Generate with
 * `bun run db:generate:aico`; never add Aico migrations to `packages/database/migrations`,
 * which stays upstream-shaped so upstream's journal can be merged verbatim.
 * Timestamp prefixes keep new Aico files from looking like upstream index numbers.
 */
export default {
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  dialect: 'postgresql',
  migrations: { prefix: 'timestamp' },
  out: './packages/database/migrations-aico',
  schema: './packages/database/src/schemas/aicoOrganization.ts',
  strict: true,
} satisfies Config;
