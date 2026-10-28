import { describe, expect, it } from 'vitest';

import { COMPOSIO_APP_TYPES } from './composio';

describe('COMPOSIO_APP_TYPES', () => {
  // Composio has no managed auth for TWITTER and no `CALCOM` toolkit, so neither can
  // ever connect from this deployment; listing them only shows users dead buttons.
  it('does not list apps that cannot connect through Composio-managed auth', () => {
    const identifiers = COMPOSIO_APP_TYPES.map((app) => app.identifier);
    expect(identifiers).not.toContain('twitter');
    expect(identifiers).not.toContain('cal-com');
  });

  it('has unique identifiers and app slugs', () => {
    const identifiers = COMPOSIO_APP_TYPES.map((app) => app.identifier);
    const slugs = COMPOSIO_APP_TYPES.map((app) => app.appSlug);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
