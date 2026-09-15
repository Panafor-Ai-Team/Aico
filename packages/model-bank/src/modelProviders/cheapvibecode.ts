import type { ModelProviderCard } from '../types';

const CheapVibeCode: ModelProviderCard = {
  chatModels: [],
  checkModel: 'gpt-5.6-luna',
  description:
    'CheapVibeCode is an OpenAI-compatible gateway offering frontier models from OpenAI, Anthropic, Google, xAI and others, priced as a coefficient on a shared token unit rather than per-model USD rates.',
  id: 'cheapvibecode',
  modelList: { showModelFetcher: true },
  modelsUrl: 'https://cheapvibecode.ru',
  name: 'CheapVibeCode',
  settings: {
    // Managed keys are injected server-side and must never reach the browser:
    // the account's primary key is both a management and an inference
    // credential, so a leak spends the float directly.
    disableBrowserRequest: true,
    proxyUrl: {
      placeholder: 'https://cheapvibecode.ru/v1',
    },
    sdkType: 'openai',
    showModelFetcher: true,
  },
  url: 'https://cheapvibecode.ru',
};

export default CheapVibeCode;
