import { act, renderHook } from '@testing-library/react';
import {
  type AIVideoModelCard,
  extractVideoDefaultValues,
  type RuntimeVideoGenParams,
  type VideoModelParamsSchema,
} from 'model-bank';
import { limitVideoParamsToSingleImage } from 'model-bank/videoParameters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVideoStore } from '@/store/video';

const modelASchema: VideoModelParamsSchema = {
  prompt: { default: '' },
  imageUrl: { default: '' },
  endImageUrl: { default: '' },
  duration: { default: 5, min: 1, max: 10 },
};

const modelBSchema: VideoModelParamsSchema = {
  prompt: { default: '' },
  imageUrl: { default: '' },
  endImageUrl: { default: '' },
  duration: { default: 3, min: 1, max: 10 },
};

const multiImageSchema: VideoModelParamsSchema = {
  prompt: { default: '' },
  imageUrls: { default: [], maxCount: 9 },
  endImageUrl: { default: null },
};

const testVideoModels: AIVideoModelCard[] = [
  {
    id: 'video-model-a',
    displayName: 'Video Model A',
    type: 'video',
    parameters: modelASchema,
    releasedAt: '2025-01-01',
  },
  {
    id: 'video-model-b',
    displayName: 'Video Model B',
    type: 'video',
    parameters: modelBSchema,
    releasedAt: '2025-01-02',
  },
  {
    id: 'video-model-multi',
    displayName: 'Multi Image Model',
    type: 'video',
    parameters: multiImageSchema,
    releasedAt: '2025-01-03',
  },
];

const mockProviders = [
  {
    id: 'provider-a',
    name: 'Provider A',
    children: [testVideoModels[0]],
  },
  {
    id: 'provider-b',
    name: 'Provider B',
    children: [testVideoModels[1], testVideoModels[2]],
  },
];

vi.mock('@/store/aiInfra', () => ({
  aiProviderSelectors: {
    enabledVideoModelList: vi.fn(() => mockProviders),
  },
  getAiInfraStoreState: vi.fn(() => ({})),
}));

const modelBDefaultValues = extractVideoDefaultValues(limitVideoParamsToSingleImage(modelBSchema));

beforeEach(() => {
  vi.clearAllMocks();

  useVideoStore.setState({
    isInit: true,
    model: 'video-model-a',
    provider: 'provider-a',
    parametersSchema: modelASchema,
    parameters: {
      prompt: 'initial prompt',
      imageUrl: 'start-frame.png',
      endImageUrl: 'end-frame.png',
      duration: 6,
    } as RuntimeVideoGenParams,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('video generationConfig actions', () => {
  it('should preserve prompt and the start frame when switching model, but not an end frame', () => {
    const { result } = renderHook(() => useVideoStore());

    act(() => {
      result.current.setParamOnInput('prompt', 'cinematic sunset');
      result.current.setParamOnInput('imageUrl', 'start-custom.png');
      result.current.setParamOnInput('endImageUrl', 'end-custom.png');
      result.current.setParamOnInput('duration', 8);
    });

    act(() => {
      result.current.setModelAndProviderOnSelect('video-model-b', 'provider-b');
    });

    expect(result.current.parameters).toEqual({
      ...modelBDefaultValues,
      prompt: 'cinematic sunset',
      imageUrl: 'start-custom.png',
    });
    expect(result.current.parametersSchema.endImageUrl).toBeUndefined();
    expect(result.current.parameters?.duration).toBe(modelBDefaultValues.duration);
  });

  it('accepts only one image even for models that take a reference list', () => {
    const { result } = renderHook(() => useVideoStore());

    act(() => {
      result.current.setModelAndProviderOnSelect('video-model-multi', 'provider-b');
    });

    expect(result.current.parametersSchema.imageUrls).toMatchObject({ maxCount: 1 });
    expect(result.current.parametersSchema.endImageUrl).toBeUndefined();

    act(() => {
      result.current.setParamOnInput('imageUrls', ['a.png', 'b.png', 'c.png']);
      result.current.setModelAndProviderOnSelect('video-model-multi', 'provider-b');
    });

    expect(result.current.parameters?.imageUrls).toEqual(['a.png']);
  });
});

describe('uploading image previews', () => {
  it('should append and remove in-flight upload previews', () => {
    const { result } = renderHook(() => useVideoStore());

    act(() => {
      useVideoStore.setState({ uploadingImagePreviews: [] });
    });

    act(() => {
      result.current.addUploadingImagePreviews(['blob:a', 'blob:b']);
    });
    expect(result.current.uploadingImagePreviews).toEqual(['blob:a', 'blob:b']);

    act(() => {
      result.current.addUploadingImagePreviews(['blob:c']);
    });
    expect(result.current.uploadingImagePreviews).toEqual(['blob:a', 'blob:b', 'blob:c']);

    act(() => {
      result.current.removeUploadingImagePreviews(['blob:a', 'blob:c']);
    });
    expect(result.current.uploadingImagePreviews).toEqual(['blob:b']);
  });
});
