import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const { mockGetUserAvatar } = vi.hoisted(() => ({ mockGetUserAvatar: vi.fn() }));

vi.mock('@/database/server', () => ({ serverDB: {} }));
vi.mock('@/server/services/user', () => ({
  UserService: vi.fn().mockImplementation(() => ({ getUserAvatar: mockGetUserAvatar })),
}));

const request = (image: string) =>
  GET(new Request(`https://app.example.com/webapi/user/avatar/user-1/${image}`), {
    params: Promise.resolve({ id: 'user-1', image }),
  });

describe('GET /webapi/user/avatar/[id]/[image]', () => {
  beforeEach(() => {
    mockGetUserAvatar.mockReset();
    mockGetUserAvatar.mockResolvedValue(Buffer.from('avatar-bytes'));
  });

  it('serves raster avatars inline with a sandboxing CSP and nosniff', async () => {
    const response = await request('avatar.webp');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it.each(['legacy.svg', 'legacy.svg+xml', 'payload.html', 'no-extension'])(
    'never serves %s as renderable content',
    async (image) => {
      const response = await request(image);

      expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(response.headers.get('Content-Disposition')).toBe('attachment');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    },
  );

  it('returns 404 when the avatar is missing', async () => {
    mockGetUserAvatar.mockResolvedValue(undefined);

    const response = await request('avatar.png');

    expect(response.status).toBe(404);
  });
});
