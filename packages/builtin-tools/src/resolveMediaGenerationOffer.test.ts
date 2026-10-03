import { ImageGenerationManifest } from '@lobechat/builtin-tool-image-generation';
import { VideoGenerationManifest } from '@lobechat/builtin-tool-video-generation';
import { describe, expect, it } from 'vitest';

import { resolveMediaGenerationOffer } from './resolveMediaGenerationOffer';

describe('resolveMediaGenerationOffer', () => {
  it('offers nothing when the model cannot call tools', () => {
    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'Generate an image of a cat', role: 'user' }],
        modelCanUseTools: false,
        toolMode: 'chat',
      }),
    ).toEqual({ image: false, video: false });
  });

  it('offers image in chat mode only for clear photo intent', () => {
    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'hello', role: 'user' }],
        modelCanUseTools: true,
        toolMode: 'chat',
      }),
    ).toEqual({ image: false, video: false });

    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'Generate an image of a red apple', role: 'user' }],
        modelCanUseTools: true,
        toolMode: 'chat',
      }),
    ).toEqual({ image: true, video: false });
  });

  it('offers video in chat mode for clear video intent', () => {
    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'Generate a 5 second video of waves', role: 'user' }],
        modelCanUseTools: true,
        toolMode: 'chat',
      }),
    ).toEqual({ image: false, video: true });
  });

  it('offers pinned media tools in agent mode without intent', () => {
    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'hello', role: 'user' }],
        modelCanUseTools: true,
        plugins: [ImageGenerationManifest.identifier],
        toolMode: 'agent',
      }),
    ).toEqual({ image: true, video: false });

    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'hello', role: 'user' }],
        modelCanUseTools: true,
        plugins: [VideoGenerationManifest.identifier],
        toolMode: 'agent',
      }),
    ).toEqual({ image: false, video: true });
  });

  it('does not offer unpinned media tools in agent mode without intent', () => {
    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'explain photosynthesis', role: 'user' }],
        modelCanUseTools: true,
        plugins: [],
        toolMode: 'agent',
      }),
    ).toEqual({ image: false, video: false });
  });

  it('respects custom mode pin-only rules', () => {
    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'Generate an image of a cat', role: 'user' }],
        modelCanUseTools: true,
        plugins: [],
        toolMode: 'custom',
      }),
    ).toEqual({ image: false, video: false });

    expect(
      resolveMediaGenerationOffer({
        messages: [{ content: 'hello', role: 'user' }],
        modelCanUseTools: true,
        plugins: [ImageGenerationManifest.identifier],
        toolMode: 'custom',
      }),
    ).toEqual({ image: true, video: false });
  });
});
