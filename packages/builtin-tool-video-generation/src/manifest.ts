import type { BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { VideoGenerationApiName, VideoGenerationIdentifier } from './types';

export const VideoGenerationManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'List currently available video generation providers and models. Use only when the user asks for model choices or needs a specific capability, quality, speed, or price tradeoff.',
      name: VideoGenerationApiName.listVideoModels,
      parameters: {
        additionalProperties: false,
        properties: {
          limit: {
            description:
              'Maximum models to return per provider. Defaults to a concise list; max is 50.',
            maximum: 50,
            minimum: 1,
            type: 'number',
          },
          provider: {
            description: 'Optional provider id to inspect.',
            type: 'string',
          },
        },
        required: [],
        type: 'object',
      },
    },
    {
      description:
        'Get the parameter schema and default values for a specific video model. Call this before passing model-specific parameters to generateVideo.',
      name: VideoGenerationApiName.getVideoModelParameters,
      parameters: {
        additionalProperties: false,
        properties: {
          model: {
            description: 'Video model id returned by listVideoModels.',
            type: 'string',
          },
          provider: {
            description: 'Provider id returned by listVideoModels.',
            type: 'string',
          },
        },
        required: ['provider', 'model'],
        type: 'object',
      },
    },
    {
      defaultTimeoutMs: 180_000,
      description:
        'Generate a video with the same pipeline as Create → Video and wait for the result. Returns a still-processing result when rendering takes longer than the wait window; the video then appears in the chat automatically.',
      name: VideoGenerationApiName.generateVideo,
      parameters: {
        additionalProperties: false,
        properties: {
          aspectRatio: {
            description:
              'Frame shape such as "16:9", "9:16" or "1:1". Pass it when the user asks for one (vertical → "9:16"). Omit to use the model default.',
            type: 'string',
          },
          duration: {
            description:
              'Video length in seconds. Always pass it when the user asks for a specific length (for example "2 seconds" → 2); the runtime fits it to what the model supports. Omit to use the model default.',
            minimum: 1,
            type: 'number',
          },
          imageUrl: {
            description:
              'The one accessible image URL to animate (for example an image the user attached in this chat). Video generation takes a single image. Omit for text-to-video.',
            type: ['string', 'null'],
          },
          model: {
            description:
              'Video model id. When omitted, the runtime selects the default enabled video model.',
            type: 'string',
          },
          parameters: {
            additionalProperties: true,
            description:
              'Model-specific parameters. Call getVideoModelParameters first and only pass supported keys such as duration, aspectRatio, resolution, generateAudio, or seed.',
            type: 'object',
          },
          prompt: {
            description:
              'The video prompt. Describe subjects, action, camera movement, style, and mood.',
            type: 'string',
          },
          provider: {
            description:
              'Video provider id. When omitted, the runtime resolves it from the requested model or the default selection.',
            type: 'string',
          },
          resolution: {
            description:
              'Output quality such as "480p" or "720p". Always pass it when the user asks for a quality; the runtime fits it to what the model supports. Omit to use the model default.',
            type: 'string',
          },
          waitTimeoutMs: {
            default: 170_000,
            description:
              'Maximum time in milliseconds to wait for the final video URL. Defaults to 170000; max is 175000.',
            maximum: 175_000,
            minimum: 1000,
            type: 'number',
          },
          waitUntilComplete: {
            default: true,
            description:
              'Whether to wait for the video before returning. Defaults to true. Set false only when explicitly starting a background task.',
            type: 'boolean',
          },
        },
        required: ['prompt'],
        type: 'object',
      },
      renderDisplayControl: 'alwaysExpand',
    },
    {
      description:
        'Check a video generation returned by generateVideo. Use at most once, and only when the user asks for an update on a video that was still processing.',
      name: VideoGenerationApiName.getVideoGenerationStatus,
      parameters: {
        additionalProperties: false,
        properties: {
          asyncTaskId: {
            description: 'Async task id returned by generateVideo.',
            type: 'string',
          },
          generationId: {
            description: 'Generation id returned by generateVideo.',
            type: 'string',
          },
        },
        required: ['generationId', 'asyncTaskId'],
        type: 'object',
      },
      renderDisplayControl: 'expand',
    },
  ],
  executors: ['client', 'server'],
  humanIntervention: 'never',
  identifier: VideoGenerationIdentifier,
  meta: {
    avatar: '🎬',
    description:
      'Generate videos from chat through the built-in Create → Video pipeline, with optional reference images.',
    title: 'Video Generation Assistant',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
