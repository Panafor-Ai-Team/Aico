import { BRANDING_NAME } from '@lobechat/business-const';

import type { ModelProviderCard } from '../types';

// ref :https://openrouter.ai/docs#models
const OpenRouter: ModelProviderCard = {
  chatModels: [],
  checkModel: 'google/gemma-2-9b-it:free',
  description:
    'Access frontier models from OpenAI, Anthropic, LLaMA, and more — pick the best model and price for your use case.',
  id: 'openrouter',
  modelList: { showModelFetcher: true },
  modelsUrl: 'https://openrouter.ai/models',
  // Managed gateway: shown to users under the product name (D-018).
  name: BRANDING_NAME,
  settings: {
    // OpenRouter don't support browser request
    // https://github.com/lobehub/lobe-chat/issues/5900
    disableBrowserRequest: true,
    proxyUrl: {
      placeholder: 'https://openrouter.ai/api/v1',
    },
    sdkType: 'openai',
    searchMode: 'params',
    showModelFetcher: true,
  },
  url: 'https://openrouter.ai',
};

export default OpenRouter;
