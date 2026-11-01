import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression: `docker.cjs` requires `./dualJournalRunner.cjs` (the default migrator since
 * #739), but only the root Dockerfile shipped it. Images built with Dockerfile.prebuilt or
 * staged by `deploy-local.sh` (`moz -u`) would fail to migrate on boot and never start.
 * Every recipe that ships the migration entry point must ship everything it requires.
 */
const root = path.join(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const localRequires = [
  ...read('scripts/migrateServerDB/docker.cjs').matchAll(/require\('\.\/([^']+)'\)/g),
].map((match) => match[1]);

describe('migration entry point image layout', () => {
  it('docker.cjs still requires its helpers from the same directory', () => {
    expect(localRequires).toEqual(expect.arrayContaining(['errorHint', 'dualJournalRunner.cjs']));
  });

  it.each(['Dockerfile', 'Dockerfile.prebuilt', 'scripts/deploy-local.sh'])(
    '%s ships every file docker.cjs requires',
    (recipe) => {
      const source = read(recipe);
      expect(source).toContain('docker.cjs');
      for (const required of localRequires) {
        const file = required.includes('.') ? required : `${required}.js`;
        expect(source, `${recipe} must copy ${file}`).toContain(`migrateServerDB/${file}`);
      }
    },
  );
});
