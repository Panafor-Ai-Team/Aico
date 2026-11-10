import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CHIEF_AGENT_ARTWORKS,
  DEFAULT_CHIEF_AGENT_ARTWORK,
  resolveChiefAgentArtwork,
} from './artwork';

const publicDir = path.join(__dirname, '../../../public');

describe('chief agent artwork', () => {
  it('ships every catalog asset from /public', () => {
    for (const artwork of CHIEF_AGENT_ARTWORKS) {
      for (const src of [artwork.avatar, artwork.hero]) {
        expect(src).toMatch(/^\/ops-assets\/[0-9a-f]{64}\.webp$/);
        expect(existsSync(path.join(publicDir, src))).toBe(true);
      }
    }
  });

  it('falls back to the default artwork for an unknown avatar', () => {
    expect(resolveChiefAgentArtwork('/brand/flame.png')).toBe(DEFAULT_CHIEF_AGENT_ARTWORK);
  });
});
