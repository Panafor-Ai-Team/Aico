import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Aico's image recipes install from workspace manifests only (`package.json` files), so the
 * install layer stays cached across source-only commits. A package whose install lifecycle
 * hook runs a file then fails `pnpm i`: upstream M2 added `electron-mac-notifications`, whose
 * `install` runs `scripts/build-native.mjs` (a no-op off macOS), and both images stopped
 * building. The manifests stage also copies `scripts/` for such packages; this keeps every
 * hook inside what it copies.
 */
const repoRoot = path.join(__dirname, '../..');
const RECIPES = ['Dockerfile', 'apps/aico-control-plane/Dockerfile'];
const HOOKS = ['preinstall', 'install', 'postinstall'] as const;

const manifests = execFileSync('git', ['ls-files', '--', '*package.json'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file.endsWith('package.json') && !file.includes('node_modules'));

/** Install hooks that run a file of their own package (`node scripts/x.mjs`, `./x.sh`, …). */
const fileHooks = manifests.flatMap((manifest) => {
  const source = readFileSync(path.join(repoRoot, manifest), 'utf8');
  const scripts = (JSON.parse(source).scripts ?? {}) as Record<string, string>;
  return HOOKS.flatMap((hook) => {
    const command = scripts[hook];
    if (!command) return [];
    const files = command
      .split(/\s+/)
      .filter((token) => /\.(?:c?js|mjs|sh|ts)$/.test(token) && !token.includes('node_modules'));
    return files.length > 0 ? [{ command, files, hook, manifest, source }] : [];
  });
});

/** The ERE each recipe's manifests stage uses to pick packages whose `scripts/` it copies. */
const recipePattern = (recipe: string) => {
  const source = readFileSync(path.join(repoRoot, recipe), 'utf8');
  const match = source.match(/grep -lE '([^']+)'/);
  expect(source, `${recipe} must copy scripts/ for install hooks`).toContain(
    'cp -r --parents "$dir/scripts" /out/',
  );
  return new RegExp(match![1].replaceAll('[[:space:]]', String.raw`\s`));
};

describe('image install layer and install lifecycle hooks', () => {
  it('finds the workspace manifests', () => {
    expect(manifests.length).toBeGreaterThan(50);
  });

  it('keeps every file an install hook runs under its package scripts/', () => {
    const outside = fileHooks.flatMap(({ files, hook, manifest }) => {
      const dir = path.dirname(manifest);
      return files
        .filter(
          (file) =>
            !path.normalize(file).startsWith('scripts/') ||
            !existsSync(path.join(repoRoot, dir, file)),
        )
        .map((file) => `${manifest} ${hook}: ${file}`);
    });

    expect(outside).toEqual([]);
  });

  it.each(RECIPES)('%s copies scripts/ for every package whose install hook runs one', (recipe) => {
    const pattern = recipePattern(recipe);
    const missed = fileHooks
      .filter(({ source }) => !pattern.test(source))
      .map(({ hook, manifest }) => `${manifest} ${hook}`);

    expect(fileHooks.length).toBeGreaterThan(0);
    expect(missed).toEqual([]);
  });
});
