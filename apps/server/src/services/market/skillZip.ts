import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Catalog identifiers are `[a-z0-9._-]`; anything else never touches the FS. */
const SAFE_IDENTIFIER = /^[\w.-]+$/;

const DEFAULT_DIR = '/app/skill-zips';

/**
 * Read a skill's ZIP from the flat archive directory (`{identifier}.zip`).
 *
 * The directory is mounted read-only from the host on purpose: the ~11 GB
 * catalog must not land in Postgres or object storage, so it never multiplies
 * the nightly backup.
 */
export async function readSkillZip(
  identifier: string,
  dir = process.env.SKILL_ZIP_DIR || DEFAULT_DIR,
): Promise<Buffer | undefined> {
  if (!SAFE_IDENTIFIER.test(identifier)) return undefined;

  try {
    return await readFile(path.join(dir, `${identifier}.zip`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
