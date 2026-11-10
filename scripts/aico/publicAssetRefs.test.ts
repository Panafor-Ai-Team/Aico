import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Root-relative app icons/images referenced in source must exist under `public/`.
 *
 * Upstream M1 moved `public/icons` → `public/app-icons` (lobehub/lobehub#18221). Aico's
 * branding logo, splash screens and deploy health checks still pointed at `/icons/…`, so
 * every logo and default avatar would have 404'd — and nothing failed until the image
 * smoke test. This catches the next such rename at test time.
 */
const repoRoot = path.join(__dirname, '../..');

const ASSET_REF = /["'`(]\/((?:app-)?(?:icons|images)\/[\w./-]+\.(?:gif|ico|jpe?g|png|svg|webp))/g;

const sourceFiles = execFileSync(
  'git',
  ['ls-files', '--', 'index.html', 'src', 'packages', 'scripts', '.github/workflows'],
  { cwd: repoRoot, encoding: 'utf8' },
)
  .split('\n')
  .filter((file) => /\.(?:html|mts|sh|ts|tsx|ya?ml)$/.test(file))
  .filter((file) => !/(?:^|\/)(?:__tests__|__fixtures__)\/|\.test\.tsx?$/.test(file));

describe('public asset references', () => {
  it('scans the app sources', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it('only references app icons and images that exist under public/', () => {
    const missing: string[] = [];
    for (const file of sourceFiles) {
      const absolute = path.join(repoRoot, file);
      if (!existsSync(absolute)) continue;
      for (const [, asset] of readFileSync(absolute, 'utf8').matchAll(ASSET_REF)) {
        if (!existsSync(path.join(repoRoot, 'public', asset))) missing.push(`${file}: /${asset}`);
      }
    }

    expect([...new Set(missing)]).toEqual([]);
  });
});
