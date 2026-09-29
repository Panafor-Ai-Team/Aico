import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regression: product 404 copy must stay plain ("Page not found"), not the
 * upstream LobeHub "Entered Unknown Territory?" tone.
 */
describe('notFound error copy', () => {
  const defaultError = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../packages/locales/src/default/error.ts',
    ),
    'utf8',
  );

  it('uses plain page-not-found wording in the English source', () => {
    expect(defaultError).toContain("'notFound.title': 'Page not found'");
    expect(defaultError).not.toContain('Unknown Territory');
  });
});
