// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('upstream Release CI', () => {
  // Publishing Panachat Desktop 1.0.0 created the v1.0.0 tag, which started
  // upstream's release job; it failed on upstream's missing GH_TOKEN and would
  // otherwise push a lobehubbot README commit into this fork.
  it('runs only in the upstream repository', () => {
    const yaml = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

    expect(yaml).toMatch(/^\s+if: \$\{\{ github\.repository == 'lobehub\/lobehub' && /m);
  });
});
