import { describe, expect, it } from 'vitest';

import { ArtifactType } from '@/types/artifact';

import { isLivePreviewableArtifactType } from './livePreview';

describe('isLivePreviewableArtifactType', () => {
  it('treats HTML / SVG / mermaid / markdown as live-previewable', () => {
    expect(isLivePreviewableArtifactType('text/html')).toBe(true);
    expect(isLivePreviewableArtifactType('html')).toBe(true);
    expect(isLivePreviewableArtifactType(ArtifactType.Default)).toBe(true);
    expect(isLivePreviewableArtifactType('image/svg+xml')).toBe(true);
    expect(isLivePreviewableArtifactType('application/lobe.artifacts.mermaid')).toBe(true);
    expect(isLivePreviewableArtifactType('text/markdown')).toBe(true);
    expect(isLivePreviewableArtifactType(undefined)).toBe(true);
  });

  it('keeps code / python / react on the source highlighter', () => {
    expect(isLivePreviewableArtifactType(ArtifactType.Code)).toBe(false);
    expect(isLivePreviewableArtifactType(ArtifactType.Python)).toBe(false);
    expect(isLivePreviewableArtifactType(ArtifactType.React)).toBe(false);
  });
});
