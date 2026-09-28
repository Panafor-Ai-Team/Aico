import {
  type AsyncTaskError,
  AsyncTaskStatus,
  type BuiltinServerRuntimeOutput,
} from '@lobechat/types';
import type { RuntimeVideoGenParams, VideoModelParamsSchema } from 'model-bank';
import { extractVideoDefaultValues, resolveVideoModelParamsSchema } from 'model-bank';
import { limitVideoParamsToSingleImage } from 'model-bank/videoParameters';

import {
  DEFAULT_VIDEO_MODEL_PROVIDER,
  findVideoModelByRequestedId,
  pickDefaultVideoModel,
} from '../defaultModel';
import type {
  GeneratedVideoSettings,
  GeneratedVideoTask,
  GenerateVideoParams,
  GenerateVideoState,
  GetVideoGenerationStatusParams,
  GetVideoGenerationStatusState,
  GetVideoModelParametersParams,
  GetVideoModelParametersState,
  ListVideoModelsParams,
  ListVideoModelsState,
  VideoGenerationCreateVideoPayload,
  VideoGenerationCreateVideoResult,
} from '../types';
import { getVideoAssetUrl } from '../videoAsset';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const MAX_PARAMETER_LOOKUP_LIMIT = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 170_000;
const MAX_WAIT_TIMEOUT_MS = 175_000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const WAIT_TIMEOUT_BUFFER_MS = 5000;
const WAIT_POLL_INTERVAL_MS = 5000;
const MAX_GENERATION_TOPIC_TITLE_LENGTH = 100;

const REFERENCE_PARAM_KEYS = new Set(['endImageUrl', 'imageUrl', 'imageUrls', 'prompt']);

export interface GenerateVideoRuntimeContext {
  executionTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface VideoGenerationRuntimeService {
  createGenerationTopic: (type: 'video', title: string) => Promise<string>;
  createVideo: (
    payload: VideoGenerationCreateVideoPayload,
  ) => Promise<VideoGenerationCreateVideoResult>;
  getGenerationStatus: (
    params: GetVideoGenerationStatusParams,
  ) => Promise<GetVideoGenerationStatusState>;
  listVideoModels: (
    params: Required<Pick<ListVideoModelsParams, 'limit'>> &
      Pick<ListVideoModelsParams, 'provider'>,
  ) => Promise<ListVideoModelsState>;
}

interface ResolvedVideoModel {
  model: string;
  parameters?: VideoModelParamsSchema;
  provider: string;
}

const clampInteger = (value: number | undefined, fallback: number, max: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value as number)));
};

const formatErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;

const formatGenerationTopicTitle = (prompt: string) =>
  prompt.replaceAll(/\s+/g, ' ').trim().slice(0, MAX_GENERATION_TOPIC_TITLE_LENGTH);

const errorOutput = (
  type: string,
  message: string,
  state?: Record<string, unknown>,
): BuiltinServerRuntimeOutput => ({
  content: message,
  error: { message, type },
  state,
  success: false,
});

const asyncTaskErrorMessage = (error: AsyncTaskError | null | undefined) => {
  if (!error) return 'Video generation failed.';
  const body = error.body;
  if (typeof body === 'string') return body;
  return body.detail || error.name || 'Video generation failed.';
};

const isTerminalStatus = (status?: AsyncTaskStatus) =>
  status === AsyncTaskStatus.Success || status === AsyncTaskStatus.Error;

const resolveWaitTimeoutMs = (waitTimeoutMs: number | undefined, executionTimeoutMs?: number) => {
  const requested =
    typeof waitTimeoutMs === 'number' && Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0
      ? Math.trunc(waitTimeoutMs)
      : DEFAULT_WAIT_TIMEOUT_MS;
  const runtimeBudget =
    typeof executionTimeoutMs === 'number' && Number.isFinite(executionTimeoutMs)
      ? Math.max(MIN_WAIT_TIMEOUT_MS, Math.trunc(executionTimeoutMs) - WAIT_TIMEOUT_BUFFER_MS)
      : MAX_WAIT_TIMEOUT_MS;

  return Math.min(
    Math.max(requested, MIN_WAIT_TIMEOUT_MS),
    Math.min(runtimeBudget, MAX_WAIT_TIMEOUT_MS),
  );
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }

    if (signal?.aborted) {
      reject(new Error('Video generation wait was aborted.'));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      reject(new Error('Video generation wait was aborted.'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Schema defaults the request should carry; prompt and reference frames come from the call. */
const schemaDefaultParams = (schema: VideoModelParamsSchema): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(extractVideoDefaultValues(schema) as Record<string, unknown>).filter(
      ([key]) => !REFERENCE_PARAM_KEYS.has(key),
    ),
  );

const trimmedUrl = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Fit the caller's reference images to what the model accepts: a reference list
 * (`imageUrls`), a single start frame (`imageUrl`), or neither (text-to-video).
 */
const resolveReferenceParams = (
  args: GenerateVideoParams,
  schema: VideoModelParamsSchema,
): { ignoredReferenceCount: number; params: Record<string, unknown> } => {
  const candidates = [
    trimmedUrl(args.imageUrl),
    ...(args.imageUrls ?? []).map(trimmedUrl),
    trimmedUrl(args.parameters?.imageUrl),
    ...(Array.isArray(args.parameters?.imageUrls) ? args.parameters.imageUrls : []).map(trimmedUrl),
  ].filter((url): url is string => Boolean(url));
  const references = [...new Set(candidates)];
  const endImageUrl = trimmedUrl(args.endImageUrl) ?? trimmedUrl(args.parameters?.endImageUrl);

  const schemaRecord = schema as Record<string, { maxCount?: number } | undefined>;
  const params: Record<string, unknown> = {};
  let accepted = 0;

  if (references.length > 0) {
    if (schemaRecord.imageUrls) {
      const maxCount = schemaRecord.imageUrls.maxCount ?? references.length;
      params.imageUrls = references.slice(0, maxCount);
      accepted = (params.imageUrls as string[]).length;
    } else if (schemaRecord.imageUrl) {
      params.imageUrl = references[0];
      accepted = 1;
    }
  }

  let ignoredEndImage = 0;
  if (endImageUrl) {
    if (schemaRecord.endImageUrl) params.endImageUrl = endImageUrl;
    else ignoredEndImage = 1;
  }

  return { ignoredReferenceCount: references.length - accepted + ignoredEndImage, params };
};

const toDurationSeconds = (value: unknown) => {
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : undefined;
};

/** Closest length the model accepts: the nearest enum value, or the request clamped to min/max. */
const fitDuration = (
  requested: number,
  schema: NonNullable<VideoModelParamsSchema['duration']>,
) => {
  if (schema.enum?.length) {
    return schema.enum.reduce((best, value) =>
      Math.abs(value - requested) < Math.abs(best - requested) ? value : best,
    );
  }

  const step = schema.step && schema.step > 0 ? schema.step : 1;
  let seconds = Math.round(requested / step) * step;
  if (typeof schema.min === 'number') seconds = Math.max(schema.min, seconds);
  if (typeof schema.max === 'number') seconds = Math.min(schema.max, seconds);
  return seconds;
};

const toOption = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;

const resolutionHeight = (value: string) => Number.parseInt(value, 10);

/** The requested resolution if offered, otherwise the offered one closest in height. */
const fitResolution = (requested: string, options: string[]) => {
  const exact = options.find((option) => option.toLowerCase() === requested);
  if (exact) return exact;

  const height = resolutionHeight(requested);
  if (!Number.isFinite(height)) return;
  return options
    .filter((option) => Number.isFinite(resolutionHeight(option)))
    .reduce<string | undefined>(
      (best, option) =>
        best === undefined ||
        Math.abs(resolutionHeight(option) - height) < Math.abs(resolutionHeight(best) - height)
          ? option
          : best,
      undefined,
    );
};

/**
 * Explicit length / quality / frame-shape requests, fitted to the model schema.
 * Notes tell the chat model when a request could not be honoured exactly.
 */
const resolveOutputSettings = (
  args: GenerateVideoParams,
  schema: VideoModelParamsSchema,
): { notes: string[]; params: GeneratedVideoSettings } => {
  const notes: string[] = [];
  const params: GeneratedVideoSettings = {};

  const duration = toDurationSeconds(args.duration ?? args.parameters?.duration);
  if (duration && schema.duration) {
    params.duration = fitDuration(duration, schema.duration);
    if (params.duration !== duration) {
      notes.push(
        `Note: the selected model cannot make a ${duration}s video; it was generated at the closest supported length, ${params.duration}s.`,
      );
    }
  }

  const resolution = toOption(args.resolution ?? args.parameters?.resolution);
  if (resolution) {
    const fitted = schema.resolution?.enum?.length
      ? fitResolution(resolution, schema.resolution.enum)
      : undefined;
    if (fitted) params.resolution = fitted;
    if (fitted?.toLowerCase() !== resolution) {
      notes.push(
        fitted
          ? `Note: the selected model does not offer ${resolution}; it was generated at the closest supported quality, ${fitted}.`
          : `Note: the selected model does not let you choose ${resolution}; it used its default quality.`,
      );
    }
  }

  const aspectRatio = toOption(args.aspectRatio ?? args.parameters?.aspectRatio);
  if (aspectRatio) {
    const offered = schema.aspectRatio?.enum?.find(
      (option) => option.toLowerCase() === aspectRatio,
    );
    if (offered) params.aspectRatio = offered;
    else {
      notes.push(
        `Note: the selected model does not offer a ${aspectRatio} frame; it used its default aspect ratio.`,
      );
    }
  }

  return { notes, params };
};

const OUTPUT_SETTING_KEYS = new Set(['aspectRatio', 'duration', 'resolution']);

const formatModelList = (state: ListVideoModelsState) => {
  if (state.totalModels === 0) {
    return 'No available video generation models were found.';
  }

  const lines = [`Available video generation models (${state.totalModels}):`];

  for (const provider of state.providers) {
    if (provider.models.length === 0) continue;

    lines.push(`\n${provider.name || provider.id} (${provider.id})`);
    for (const model of provider.models) {
      const displayName =
        model.displayName && model.displayName !== model.id ? ` — ${model.displayName}` : '';
      const description = model.description?.replaceAll(/\s+/g, ' ').trim() || 'Not provided.';
      const parameterKeys = model.parameters ? Object.keys(model.parameters) : [];
      const parameterHint =
        parameterKeys.length > 0 ? `; parameters: ${parameterKeys.join(', ')}` : '';
      lines.push(`- ${model.id}${displayName}${parameterHint}`);
      lines.push(`  Description: ${description}`);
    }
  }

  lines.push(
    '\nCall getVideoModelParameters with provider and model before passing model-specific parameters.',
  );

  return lines.join('\n');
};

const formatParameterDetails = (state: GetVideoModelParametersState) => {
  if (!state.parameters) {
    return `No parameter schema is available for ${state.provider}/${state.model}. Use prompt only unless the provider documentation says otherwise.`;
  }

  return [
    `Complete parameter schema for ${state.provider}/${state.model}:`,
    JSON.stringify(state.parameters, null, 2),
  ].join('\n');
};

const formatTaskLine = (task: GeneratedVideoTask) => {
  const status = task.status ? `, status=${task.status}` : '';
  const error =
    task.status === AsyncTaskStatus.Error ? `, error=${asyncTaskErrorMessage(task.error)}` : '';
  return `generationId=${task.generationId}, asyncTaskId=${task.asyncTaskId}${status}${error}`;
};

const ignoredReferenceNote = (count: number) =>
  count > 0
    ? `Note: video generation takes only one image, so the first was used and ${count} other image(s) were not sent. Tell the user only one image is supported.`
    : undefined;

const formatSettingsLine = ({ aspectRatio, duration, resolution }: GeneratedVideoSettings) => {
  const parts = [
    duration ? `duration=${duration}s` : undefined,
    resolution ? `resolution=${resolution}` : undefined,
    aspectRatio ? `aspectRatio=${aspectRatio}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `Settings sent: ${parts.join(', ')}` : undefined;
};

const joinLines = (lines: Array<string | undefined>) =>
  lines.filter((line): line is string => Boolean(line)).join('\n');

const formatStatusContent = (state: GetVideoGenerationStatusState) => {
  if (state.status === AsyncTaskStatus.Success) {
    const url = getVideoAssetUrl(state.generation?.asset);
    return url
      ? `Video generation ${state.generationId} succeeded.\nVideo URL: ${url}`
      : `Video generation ${state.generationId} succeeded.`;
  }

  if (state.status === AsyncTaskStatus.Error) {
    return `Video generation ${state.generationId} failed: ${asyncTaskErrorMessage(state.error)}`;
  }

  return `Video generation ${state.generationId} is ${state.status}. It will appear in the chat automatically when ready.`;
};

export class VideoGenerationExecutionRuntime {
  private service: VideoGenerationRuntimeService;

  constructor(service: VideoGenerationRuntimeService) {
    this.service = service;
  }

  async listVideoModels(args: ListVideoModelsParams = {}): Promise<BuiltinServerRuntimeOutput> {
    try {
      const provider = args.provider?.trim() || undefined;
      const limit = clampInteger(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const state = await this.service.listVideoModels({ limit, provider });

      return { content: formatModelList(state), state, success: true };
    } catch (error) {
      const message = formatErrorMessage(error, 'Failed to list video models');
      return errorOutput('ListVideoModelsFailed', message);
    }
  }

  async getVideoModelParameters(
    args: GetVideoModelParametersParams,
  ): Promise<BuiltinServerRuntimeOutput> {
    const provider = args.provider?.trim();
    const model = args.model?.trim();

    if (!provider || !model) {
      return errorOutput('InvalidToolArguments', '`provider` and `model` are required.');
    }

    try {
      const list = await this.service.listVideoModels({
        limit: MAX_PARAMETER_LOOKUP_LIMIT,
        provider,
      });
      const modelItem = findVideoModelByRequestedId(
        list.providers.flatMap((item) => item.models),
        (item) => item.id,
        model,
      );

      if (!modelItem) {
        return errorOutput('VideoModelNotFound', `Video model not found: ${provider}/${model}`);
      }

      const parameters = limitVideoParamsToSingleImage(
        resolveVideoModelParamsSchema(modelItem.parameters),
      );
      const state: GetVideoModelParametersState = {
        defaultValues: extractVideoDefaultValues(parameters),
        displayName: modelItem.displayName,
        model: modelItem.id,
        parameters,
        provider,
      };

      return { content: formatParameterDetails(state), state, success: true };
    } catch (error) {
      const message = formatErrorMessage(error, 'Failed to get video model parameters');
      return errorOutput('GetVideoModelParametersFailed', message);
    }
  }

  private async resolveVideoModel(provider?: string, model?: string): Promise<ResolvedVideoModel> {
    const state = await this.service.listVideoModels({
      limit: MAX_PARAMETER_LOOKUP_LIMIT,
      provider,
    });
    const flat = state.providers.flatMap((providerItem) =>
      providerItem.models.map((candidate) => ({ candidate, providerId: providerItem.id })),
    );

    const matched = model
      ? findVideoModelByRequestedId(flat, (entry) => entry.candidate.id, model)
      : (pickDefaultVideoModel(
          flat.filter((entry) => entry.providerId === DEFAULT_VIDEO_MODEL_PROVIDER),
          (entry) => entry.candidate.id,
        ) ??
        pickDefaultVideoModel(flat, (entry) => entry.candidate.id) ??
        flat[0]);

    if (matched) {
      return {
        model: matched.candidate.id,
        parameters: matched.candidate.parameters,
        provider: matched.providerId,
      };
    }

    const requestedSelection = [provider, model].filter(Boolean).join('/');
    throw new Error(
      requestedSelection
        ? `No enabled video generation model matched ${requestedSelection}.`
        : 'No enabled video generation model is available.',
    );
  }

  private async waitForGeneration(
    task: GeneratedVideoTask,
    waitTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ task: GeneratedVideoTask; timedOut: boolean }> {
    const deadline = Date.now() + waitTimeoutMs;
    let current = task;

    while (true) {
      const state = await this.service.getGenerationStatus({
        asyncTaskId: current.asyncTaskId,
        generationId: current.generationId,
      });

      current = {
        ...current,
        asset: state.generation?.asset ?? current.asset,
        error: state.error,
        status: state.status,
      };

      if (isTerminalStatus(state.status)) return { task: current, timedOut: false };

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { task: current, timedOut: true };

      await sleep(Math.min(WAIT_POLL_INTERVAL_MS, remainingMs), signal);
    }
  }

  async generateVideo(
    args: GenerateVideoParams,
    context: GenerateVideoRuntimeContext = {},
  ): Promise<BuiltinServerRuntimeOutput> {
    const prompt = args.prompt?.trim();
    if (!prompt) {
      return errorOutput('InvalidToolArguments', '`prompt` is required.');
    }

    let selection: ResolvedVideoModel;
    try {
      selection = await this.resolveVideoModel(args.provider?.trim(), args.model?.trim());
    } catch (error) {
      const message = formatErrorMessage(error, 'Failed to resolve a video generation model');
      return errorOutput('VideoModelNotFound', message);
    }

    const { model, provider } = selection;
    const schema = limitVideoParamsToSingleImage(
      resolveVideoModelParamsSchema(selection.parameters),
    );
    const { ignoredReferenceCount, params: referenceParams } = resolveReferenceParams(args, schema);
    const { notes: settingNotes, params: settingParams } = resolveOutputSettings(args, schema);
    const callerParams = Object.fromEntries(
      Object.entries(args.parameters ?? {}).filter(
        ([key]) => !REFERENCE_PARAM_KEYS.has(key) && !OUTPUT_SETTING_KEYS.has(key),
      ),
    );
    const params = {
      // Schema defaults first (duration, resolution, aspect ratio) so the tool
      // sends what Create → Video would; explicit arguments still win.
      ...schemaDefaultParams(schema),
      ...callerParams,
      ...settingParams,
      ...referenceParams,
      prompt,
    } as RuntimeVideoGenParams & Record<string, unknown>;
    const settings: GeneratedVideoSettings = {
      aspectRatio: typeof params.aspectRatio === 'string' ? params.aspectRatio : undefined,
      duration: typeof params.duration === 'number' ? params.duration : undefined,
      resolution: typeof params.resolution === 'string' ? params.resolution : undefined,
    };
    const waitUntilComplete = args.waitUntilComplete !== false;

    try {
      const generationTopicId = await this.service.createGenerationTopic(
        'video',
        formatGenerationTopicTitle(prompt),
      );
      const result = await this.service.createVideo({
        generationTopicId,
        model,
        params,
        provider,
      });

      const created = result.data?.generations?.[0];
      if (!result.success || !created?.id || !created.asyncTaskId) {
        return errorOutput(
          'GenerateVideoFailed',
          'Video generation did not return generation or async task ids.',
          { generationTopicId, model, provider },
        );
      }

      const state: GenerateVideoState = {
        batchId: result.data?.batch?.id,
        generation: { asyncTaskId: created.asyncTaskId, generationId: created.id },
        generationTopicId,
        model,
        prompt,
        provider,
        settings,
        waitUntilComplete,
      };
      const note = joinLines([
        formatSettingsLine(settings),
        ignoredReferenceNote(ignoredReferenceCount),
        ...settingNotes,
      ]);

      if (!waitUntilComplete) {
        return {
          content: joinLines([
            `Video generation started with ${model}.`,
            formatTaskLine(state.generation),
            note,
            'The video will appear in the chat automatically when it is ready.',
          ]),
          state,
          success: true,
        };
      }

      const waitTimeoutMs = resolveWaitTimeoutMs(args.waitTimeoutMs, context.executionTimeoutMs);
      let waitResult: { task: GeneratedVideoTask; timedOut: boolean };
      try {
        waitResult = await this.waitForGeneration(state.generation, waitTimeoutMs, context.signal);
      } catch (error) {
        if (context.signal?.aborted) throw error;

        const message = formatErrorMessage(error, 'Failed to wait for video generation status');
        return {
          content: joinLines([
            `Video generation started with ${model}, but the latest status could not be checked.`,
            formatTaskLine(state.generation),
            `Status check error: ${message}`,
            note,
            'The video will appear in the chat automatically when it is ready.',
          ]),
          state: { ...state, waitError: message },
          success: true,
        };
      }

      const waitedState: GenerateVideoState = {
        ...state,
        generation: waitResult.task,
        waitTimedOut: waitResult.timedOut,
      };

      if (waitResult.timedOut) {
        return {
          content: joinLines([
            `Video generation started with ${model} and is still processing after ${Math.round(waitTimeoutMs / 1000)}s.`,
            formatTaskLine(waitedState.generation),
            note,
            'The video keeps rendering in the background and will appear in the chat automatically when it is ready. Tell the user that; do not poll getVideoGenerationStatus in a loop.',
          ]),
          state: waitedState,
          success: true,
        };
      }

      if (waitResult.task.status === AsyncTaskStatus.Error) {
        const message = asyncTaskErrorMessage(waitResult.task.error);
        return {
          content: joinLines([
            `Video generation failed using ${model}: ${message}`,
            formatTaskLine(waitedState.generation),
          ]),
          error: { message, type: 'VideoGenerationFailed' },
          state: waitedState,
          success: false,
        };
      }

      const url = getVideoAssetUrl(waitResult.task.asset);
      return {
        content: joinLines([
          `Video generation completed with ${model}.`,
          formatTaskLine(waitedState.generation),
          note,
          'The video is already playing in the chat for the user.',
          url
            ? `In the final response, briefly confirm it is ready and include this markdown link exactly (do not rewrite the URL): [Generated video](${url})`
            : undefined,
        ]),
        state: waitedState,
        success: true,
      };
    } catch (error) {
      if (context.signal?.aborted) throw error;

      const message = formatErrorMessage(error, 'Failed to start video generation');
      return errorOutput('GenerateVideoFailed', message, { model, provider });
    }
  }

  async getVideoGenerationStatus(
    args: GetVideoGenerationStatusParams,
  ): Promise<BuiltinServerRuntimeOutput> {
    const generationId = args.generationId?.trim();
    const asyncTaskId = args.asyncTaskId?.trim();

    if (!generationId || !asyncTaskId) {
      return errorOutput('InvalidToolArguments', '`generationId` and `asyncTaskId` are required.');
    }

    try {
      const state = await this.service.getGenerationStatus({ asyncTaskId, generationId });
      const content = formatStatusContent(state);

      if (state.status === AsyncTaskStatus.Error) {
        return {
          content,
          error: { message: asyncTaskErrorMessage(state.error), type: 'VideoGenerationFailed' },
          state,
          success: false,
        };
      }

      return { content, state, success: true };
    } catch (error) {
      const message = formatErrorMessage(error, 'Failed to get video generation status');
      return errorOutput('GetVideoGenerationStatusFailed', message, { asyncTaskId, generationId });
    }
  }
}
