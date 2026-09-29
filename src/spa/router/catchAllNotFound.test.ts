import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regression: unknown SPA URLs must render a light 404 page, not redirect to
 * `/` (which boots the full home shell and feels like a broken miss).
 */
describe('SPA catch-all 404', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));

  it('desktop catch-all loads the not-found route instead of redirecting home', () => {
    const source = readFileSync(path.join(root, 'desktopRouter.shared.tsx'), 'utf8');
    const catchAll = source.slice(source.lastIndexOf("path: '*'") - 200);

    expect(catchAll).toContain("import('@/routes/not-found')");
    expect(catchAll).not.toContain("redirectElement('/')");
  });

  it('mobile catch-all loads the not-found route instead of redirecting home', () => {
    const source = readFileSync(path.join(root, 'mobileRouter.config.tsx'), 'utf8');
    const catchAll = source.slice(source.lastIndexOf("path: '*'") - 200);

    expect(catchAll).toContain("import('@/routes/not-found')");
    expect(catchAll).not.toContain("redirectElement('/')");
  });
});
