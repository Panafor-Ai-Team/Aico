// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const state = vi.hoisted(() => ({ appUrl: 'https://app.example.com' }));

vi.mock('@/envs/app', () => ({
  appEnv: {
    get APP_URL() {
      return state.appUrl;
    },
  },
}));

describe('GET /oauth/connector/client-metadata', () => {
  it('serves a document whose client_id is its own URL', async () => {
    const body = await (await GET()).json();

    expect(body.client_id).toBe('https://app.example.com/oauth/connector/client-metadata');
    expect(body.redirect_uris).toEqual(['https://app.example.com/oauth/connector/callback']);
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('is unavailable over plain http', async () => {
    state.appUrl = 'http://localhost:3010';

    expect((await GET()).status).toBe(404);
    state.appUrl = 'https://app.example.com';
  });
});
