import type {
  VideoGenerationCreateVideoResult,
  VideoGenerationModelSummary,
} from '@lobechat/builtin-tool-video-generation';
import {
  isVideoGenerationProvider,
  VideoGenerationIdentifier,
} from '@lobechat/builtin-tool-video-generation';
import { VideoGenerationExecutionRuntime } from '@lobechat/builtin-tool-video-generation/executionRuntime';
import type { AiProviderModelListItem, VideoModelParamsSchema } from 'model-bank';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { aiModelRouter } from '@/server/routers/lambda/aiModel';
import { aiProviderRouter } from '@/server/routers/lambda/aiProvider';
import { generationRouter } from '@/server/routers/lambda/generation';
import { generationTopicRouter } from '@/server/routers/lambda/generationTopic';
import { videoRouter } from '@/server/routers/lambda/video';
import { resolvePreferredGenerationBilling } from '@/server/services/aico/generationBilling';
import { filterHiddenProviderModels } from '@/utils/aiProvider';

import { type ServerRuntimeRegistration } from './types';

const normalizeModel = (model: AiProviderModelListItem): VideoGenerationModelSummary => ({
  description: model.description,
  displayName: model.displayName,
  id: model.id,
  parameters: model.parameters as VideoModelParamsSchema | undefined,
  pricing: model.pricing,
  releasedAt: model.releasedAt,
});

export const videoGenerationRuntime: ServerRuntimeRegistration = {
  factory: async (context) => {
    if (!context.userId) {
      throw new Error('userId is required for Video Generation tool execution');
    }
    if (!context.serverDB) {
      throw new Error('serverDB is required for Video Generation tool execution');
    }

    const callerContext = {
      clientIp: context.clientIp,
      userId: context.userId,
      workspaceId: context.workspaceId,
    };
    const aiModelCaller = aiModelRouter.createCaller(callerContext);
    const aiProviderCaller = aiProviderRouter.createCaller(callerContext);
    const generationCaller = generationRouter.createCaller(callerContext);
    const generationTopicCaller = generationTopicRouter.createCaller(callerContext);
    const videoCaller = videoRouter.createCaller(callerContext);
    const billingModel = new AicoBillingModel(context.serverDB);
    const aicoBilling = await resolvePreferredGenerationBilling(
      (userId) => billingModel.getOrCreateUserWallet(userId),
      context.userId,
    );

    return new VideoGenerationExecutionRuntime({
      createGenerationTopic: (type, title) =>
        generationTopicCaller.createTopic({
          title,
          type,
          ...(context.agentVisibility === 'private' || context.agentVisibility === 'public'
            ? { visibility: context.agentVisibility }
            : {}),
        }),
      // Same lambda as Create → Video (`videoService.createVideo` → video.createVideo).
      createVideo: async (payload) =>
        (await videoCaller.createVideo({
          ...payload,
          aicoBilling,
        })) as VideoGenerationCreateVideoResult,
      getGenerationStatus: async ({ asyncTaskId, generationId }) => {
        const result = await generationCaller.getGenerationStatus({ asyncTaskId, generationId });
        return { ...result, asyncTaskId, generationId };
      },
      listVideoModels: async ({ provider, limit }) => {
        const runtimeState = await aiProviderCaller.getAiProviderRuntimeState({});
        const enabledProviders = runtimeState.enabledVideoAiProviders
          .filter((item) => isVideoGenerationProvider(item.id))
          .filter((item) => !provider || item.id === provider);

        const providers = await Promise.all(
          enabledProviders.map(async (item) => {
            // Drop hidden models before the limit so they never consume result slots.
            const models = await aiModelCaller.getAiProviderModelList({
              enabled: true,
              id: item.id,
              type: 'video',
            });
            const visibleModels = filterHiddenProviderModels(
              models,
              item.id,
              runtimeState.hiddenBuiltinModels,
            );

            return {
              id: item.id,
              models: visibleModels.slice(0, limit).map(normalizeModel),
              name: item.name || item.id,
            };
          }),
        );
        const nonEmptyProviders = providers.filter((item) => item.models.length > 0);

        return {
          providers: nonEmptyProviders,
          totalModels: nonEmptyProviders.reduce((sum, item) => sum + item.models.length, 0),
        };
      },
    });
  },
  identifier: VideoGenerationIdentifier,
};
