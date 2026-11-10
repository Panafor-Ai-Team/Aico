import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import semver from 'semver';
import { describe, expect, it } from 'vitest';

const rootPackageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
  pnpm: { overrides: Record<string, string> };
};

const overrides = rootPackageJson.pnpm.overrides;

// No lockfile is committed, so Docker builds resolve fresh versions. Packages that
// import from @lobehub/ui must stay pinned alongside it, or a new release that needs
// a newer @lobehub/ui breaks the SPA build with MISSING_EXPORT errors.
describe('@lobehub overrides', () => {
  it('pins @lobehub/ui to an exact version', () => {
    expect(semver.valid(overrides['@lobehub/ui'])).not.toBeNull();
  });

  it.each(['@lobehub/editor', '@lobehub/charts', '@lobehub/icons', '@lobehub/tts'])(
    'pins %s to an exact version while @lobehub/ui is pinned',
    (name) => {
      expect(semver.valid(overrides[name])).not.toBeNull();
    },
  );
});
