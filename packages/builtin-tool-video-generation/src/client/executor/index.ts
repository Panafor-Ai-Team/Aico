import type {
  BuiltinServerRuntimeOutput,
  BuiltinToolContext,
  BuiltinToolResult,
} from '@lobechat/types';
import { BaseExecutor } from '@lobechat/types';
import type { AiModelForSelect, AiProviderModelListItem, VideoModelParamsSchema } from 'model-bank';

import { aiModelService } from '@/services/aiModel';
import { aiProviderService } from '@/services/aiProvider';
import { generationService } from '@/services/generation';
import { generationTopicService } from '@/services/generationTopic';
import { videoService } from '@/services/video';
import { getAgentStoreState } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';
import { aiProviderSelectors, getAiInfraStoreState } from '@/store/aiInfra';
import { filterHiddenProviderModels } from '@/utils/aiProvider';

import { isVideoGenerationProvider } from '../../defaultModel';
import { VideoGenerationExecutionRuntime } from '../../ExecutionRuntime';
import { VideoGenerationManifest } from '../../manifest';
import type {
  GenerateVideoParams,
  GetVideoGenerationStatusParams,
  GetVideoModelParametersParams,
  ListVideoModelsParams,
  VideoGenerationCreateVideoResult,
  VideoGenerationModelSummary,
  VideoGenerationProviderModels,
} from '../../types';
import { VideoGenerationApiName } from '../../types';

const normalizeModel = (
  model: AiModelForSelect | AiProviderModelListItem,
): VideoGenerationModelSummary => ({
  description: model.description,
  displayName: model.displayName,
  id: model.id,
  parameters: model.parameters as VideoModelParamsSchema | undefined,
  pricePerVideo: 'pricePerVideo' in model ? model.pricePerVideo : undefined,
  pricing: model.pricing,
  releasedAt: model.releasedAt,
});

const withTotal = (providers: VideoGenerationProviderModels[]) => {
  const nonEmpty = providers.filter((item) => item.models.length > 0);
  return {
    providers: nonEmpty,
    totalModels: nonEmpty.reduce((sum, item) => sum + item.models.length, 0),
  };
};

const createClientVideoGenerationRuntime = (topicVisibility?: 'private' | 'public') =>
  new VideoGenerationExecutionRuntime({
    createGenerationTopic: (type, title) =>
      generationTopicService.createTopic(type, topicVisibility, title),
    createVideo: async (payload) =>
      (await videoService.createVideo(payload)) as VideoGenerationCreateVideoResult,
    getGenerationStatus: async ({ asyncTaskId, generationId }) => {
      const result = await generationService.getGenerationStatus(generationId, asyncTaskId);
      return { ...result, asyncTaskId, generationId };
    },
    listVideoModels: async ({ provider, limit }) => {
      // Same surface as Create → Video in Aico mode: wallet-backed providers only.
      const storeProviders = aiProviderSelectors
        .enabledVideoModelList(getAiInfraStoreState())
        .filter((item) => isVideoGenerationProvider(item.id))
        .filter((item) => !provider || item.id === provider);

      if (storeProviders.length > 0) {
        return withTotal(
          storeProviders.map((item) => ({
            id: item.id,
            models: item.children.slice(0, limit).map(normalizeModel),
            name: item.name,
          })),
        );
      }

      const runtimeState = await aiProviderService.getAiProviderRuntimeState();
      const hiddenBuiltinModels = runtimeState.hiddenBuiltinModels ?? [];
      const enabledProviders = runtimeState.enabledVideoAiProviders
        .filter((item) => isVideoGenerationProvider(item.id))
        .filter((item) => !provider || item.id === provider);

      const providers = await Promise.all(
        enabledProviders.map(async (item) => {
          const models = await aiModelService.getAiProviderModelList(item.id, {
            enabled: true,
            type: 'video',
          });
          const visibleModels = filterHiddenProviderModels(models, item.id, hiddenBuiltinModels);
          return {
            id: item.id,
            models: visibleModels.slice(0, limit).map(normalizeModel),
            name: item.name || item.id,
          };
        }),
      );

      return withTotal(providers);
    },
  });

class VideoGenerationExecutor extends BaseExecutor<typeof VideoGenerationApiName> {
  readonly identifier = VideoGenerationManifest.identifier;
  protected readonly apiEnum = VideoGenerationApiName;

  private runtime = createClientVideoGenerationRuntime();

  private toResult(output: BuiltinServerRuntimeOutput): BuiltinToolResult {
    const errorMessage =
      typeof output.error?.message === 'string' ? output.error.message : undefined;
    const content = output.content || errorMessage || 'Tool execution failed';

    if (!output.success) {
      return {
        content,
        error: output.error
          ? { body: output.error, message: errorMessage ?? content, type: 'PluginServerError' }
          : undefined,
        state: output.state,
        success: false,
      };
    }

    return { content, state: output.state, success: true };
  }

  listVideoModels = async (params: ListVideoModelsParams): Promise<BuiltinToolResult> =>
    this.toResult(await this.runtime.listVideoModels(params));

  getVideoModelParameters = async (
    params: GetVideoModelParametersParams,
  ): Promise<BuiltinToolResult> =>
    this.toResult(await this.runtime.getVideoModelParameters(params));

  generateVideo = async (
    params: GenerateVideoParams,
    ctx?: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    const topicVisibility = ctx?.agentId
      ? agentByIdSelectors.getAgentById(ctx.agentId)(getAgentStoreState())?.visibility
      : undefined;
    const runtime = createClientVideoGenerationRuntime(topicVisibility);

    return this.toResult(await runtime.generateVideo(params, { signal: ctx?.signal }));
  };

  getVideoGenerationStatus = async (
    params: GetVideoGenerationStatusParams,
  ): Promise<BuiltinToolResult> =>
    this.toResult(await this.runtime.getVideoGenerationStatus(params));
}

export const videoGenerationExecutor = new VideoGenerationExecutor();
