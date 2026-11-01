import { describe, expect, it } from 'vitest';

import { ArtifactType } from '@/types/artifact';

import { getArtifactFileName } from './getArtifactFileName';

describe('getArtifactFileName', () => {
  it.each([
    [ArtifactType.Default, 'html'],
    ['text/html', 'html'],
    [undefined, 'html'],
    ['application/x-unknown', 'html'],
    ['image/svg+xml', 'svg'],
    ['application/lobe.artifacts.mermaid', 'mmd'],
    ['text/markdown', 'md'],
    [ArtifactType.React, 'tsx'],
    [ArtifactType.Python, 'py'],
  ])('maps type %s to .%s', (type, extension) => {
    expect(getArtifactFileName({ identifier: 'hero-examples', type })).toBe(
      `hero-examples.${extension}`,
    );
  });

  it('uses the language of a code artifact', () => {
    expect(
      getArtifactFileName({ identifier: 'utils', language: 'TypeScript', type: ArtifactType.Code }),
    ).toBe('utils.ts');
  });

  it('falls back to .txt for an unknown code language', () => {
    expect(
      getArtifactFileName({ identifier: 'notes', language: 'brainfuck', type: ArtifactType.Code }),
    ).toBe('notes.txt');
    expect(getArtifactFileName({ identifier: 'notes', type: ArtifactType.Code })).toBe('notes.txt');
  });

  it('falls back from identifier to title to a default name', () => {
    expect(getArtifactFileName({ identifier: '', title: 'نمونه‌های Hero', type: 'html' })).toBe(
      'نمونه‌های Hero.html',
    );
    expect(getArtifactFileName({ type: 'html' })).toBe('artifact.html');
  });

  it('strips characters that file systems reject', () => {
    expect(getArtifactFileName({ title: 'a/b:c*d?"e"<f>|g\\h', type: 'html' })).toBe(
      'abcdefgh.html',
    );
    expect(getArtifactFileName({ identifier: '???', title: 'Report', type: 'html' })).toBe(
      'Report.html',
    );
  });
});
