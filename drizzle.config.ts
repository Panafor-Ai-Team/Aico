import { readdirSync } from 'node:fs';
import path from 'node:path';

import * as dotenv from 'dotenv';
import type { Config } from 'drizzle-kit';

// Read the .env file if it exists, or a file specified by the

// dotenv_config_path parameter that's passed to Node.js

dotenv.config();

const connectionString = process.env.DATABASE_URL!;

const schemasDir = './packages/database/src/schemas';

/**
 * Upstream-shaped schema only. Aico's tables live in `aicoOrganization.ts` and migrate
 * through their own journal (`drizzle.aico.config.ts` → `packages/database/migrations-aico`),
 * so they are left out here, as is the `index.ts` barrel that re-exports them.
 */
const AICO_SCHEMA_FILES = new Set(['aicoOrganization.ts', 'index.ts']);

const mainSchemaFiles = readdirSync(schemasDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .filter(
    (file) =>
      !(
        path.dirname(file) === path.normalize(schemasDir) &&
        AICO_SCHEMA_FILES.has(path.basename(file))
      ),
  )
  .sort();

export default {
  dbCredentials: {
    url: connectionString,
  },
  dialect: 'postgresql',
  out: './packages/database/migrations',

  schema: mainSchemaFiles,
  strict: true,
} satisfies Config;
