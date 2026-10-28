import { describe, expect, it } from 'vitest';

import { describeConnectedComposioApp } from './composio';

describe('describeConnectedComposioApp', () => {
  it("says the app is the user's own account and rules out web search", () => {
    const text = describeConnectedComposioApp('Google Drive');

    expect(text).toContain("user's own Google Drive account");
    expect(text).toContain('do not use web search');
  });
});
