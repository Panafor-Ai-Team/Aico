import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSkillZip } from './skillZip';

const tmpDir = () => mkdtemp(path.join(os.tmpdir(), 'skill-zips-'));

describe('readSkillZip', () => {
  it('reads {identifier}.zip from the catalog directory', async () => {
    const dir = await tmpDir();
    await writeFile(path.join(dir, 'acme-skill.zip'), Buffer.from('PK'));

    await expect(readSkillZip('acme-skill', dir)).resolves.toEqual(Buffer.from('PK'));
  });

  it('returns undefined for a missing archive', async () => {
    await expect(readSkillZip('nope', await tmpDir())).resolves.toBeUndefined();
  });

  it('rejects identifiers that could escape the directory', async () => {
    const dir = await tmpDir();
    await writeFile(path.join(dir, 'secret.zip'), Buffer.from('nope'));

    await expect(readSkillZip('../secret', dir)).resolves.toBeUndefined();
  });
});
