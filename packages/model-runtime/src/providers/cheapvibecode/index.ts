import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { resolveAutoModel } from './autoRouting';
import { createCheapVibeCodeVideo, pollCheapVibeCodeVideoStatus } from './createVideo';
import { fetchCheapVibeCodeModels } from './modelFetch';

export type { CheapVibeCodeAutoRoute } from './autoRouting';
export {
  DEFAULT_CVC_AUTO_ROUTE,
  isAutoModelId,
  resolveAutoModel,
  resolveAutoRoute,
} from './autoRouting';
export {
  createCheapVibeCodeVideo,
  DEFAULT_CVC_VIDEO_BASE_URL,
  pollCheapVibeCodeVideoStatus,
} from './createVideo';
export {
  cvcMultiplierToPricing,
  DEFAULT_CVC_TOKENS_PER_USD,
  fetchCheapVibeCodeModels,
  mapCheapVibeCodeModelCard,
} from './modelFetch';

/**
 * CheapVibeCode is OpenAI-compatible on `/v1/chat/completions`, including
 * streaming (usage arrives in the final chunk with `stream_options`) and tool
 * calls. What it lacks is everything around the edges: no `:online` search
 * plugin, no provider routing preferences, no multi-provider fallback. Their own
 * guidance for an unavailable upstream is a Primary/Fallback *domain* switch,
 * which is why `baseURL` is configurable per deployment rather than pinned.
 */
export const params = {
  baseURL: 'https://cheapvibecode.ru/v1',
  chatCompletion: {
    handlePayload: (payload) => {
      const {
        enabledSearch: _enabledSearch,
        imageAspectRatio: _imageAspectRatio,
        imageResolution: _imageResolution,
        thinking,
        thinkingLevel,
        reasoning_effort,
        ...rest
      } = payload as any;

      // Reasoning is a property of the model here, not a per-request switch:
      // `/v1/models` publishes `supports_reasoning` and there is no documented
      // request field to turn it on or off. Dropping these rather than forwarding
      // them keeps us from sending parameters the gateway may reject outright.
      void thinking;
      void thinkingLevel;
      void reasoning_effort;

      return {
        ...rest,
        // CheapVibeCode has no `auto` route, so the product Auto router resolves
        // to a concrete model here — see ./autoRouting. Any other id passes
        // through untouched.
        model: resolveAutoModel(payload),
        stream: payload.stream ?? true,
      } as any;
    },
  },
  createVideo: createCheapVibeCodeVideo,
  debug: {
    chatCompletion: () => process.env.DEBUG_CHEAPVIBECODE_CHAT_COMPLETION === '1',
  },
  handlePollVideoStatus: async (requestId, options) =>
    pollCheapVibeCodeVideoStatus(requestId, { apiKey: options.apiKey }),
  models: fetchCheapVibeCodeModels,
  provider: ModelProvider.CheapVibeCode,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeCheapVibeCodeAI = createOpenAICompatibleRuntime(params);
