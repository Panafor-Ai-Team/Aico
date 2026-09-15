import type { AIChatModelCard } from '../types/aiModel';

/**
 * A fallback snapshot, not the catalog.
 *
 * CheapVibeCode publishes no USD pricing: it charges `coefficient x tokens` of
 * its own token unit, with input and output weighted equally and cached tokens
 * charged in full. Every `rate` below is that coefficient converted at 25M
 * tokens per USD — `coefficient x 0.04` USD per million tokens — which is the
 * same conversion `fetchCheapVibeCodeModels` performs. Anything served to a user
 * comes from the synced catalog whenever one exists; this file only covers the
 * window before the first sync.
 *
 * Two coefficients here are known to under-state what is actually charged:
 * `deepseek-v4.1-flash` bills ~x0.433 against a published x0.3 and `mimo-v2.5`
 * ~x0.072 against x0.05, both consistent with reasoning tokens being counted
 * twice. The published figure is kept deliberately — the per-model override
 * table is where a measured correction belongs, so that display and the synced
 * catalog never disagree about what the provider says.
 */
const cvcPricing = (coefficient: number) => ({
  units: [
    {
      name: 'textInput' as const,
      rate: coefficient * 0.04,
      strategy: 'fixed' as const,
      unit: 'millionTokens' as const,
    },
    {
      name: 'textOutput' as const,
      rate: coefficient * 0.04,
      strategy: 'fixed' as const,
      unit: 'millionTokens' as const,
    },
  ],
});

const cheapvibecodeChatModels: AIChatModelCard[] = [
  {
    abilities: { reasoning: true, vision: true },
    contextWindowTokens: 1_050_000,
    description:
      'The catalog reference point for quality, and the best value among vision-capable models. Default target of the managed auto route.',
    displayName: 'GPT-5.6 Luna',
    enabled: true,
    id: 'gpt-5.6-luna',
    pricing: cvcPricing(0.33),
    type: 'chat',
  },
  {
    abilities: { functionCall: true, reasoning: true },
    contextWindowTokens: 1_050_000,
    description:
      'Highest quality-per-cost in the catalog. Preferred for bulk text work that does not need vision.',
    displayName: 'GLM-5.3 Flash',
    enabled: true,
    id: 'glm-5.3-flash',
    pricing: cvcPricing(0.3),
    type: 'chat',
  },
  {
    abilities: { reasoning: true },
    contextWindowTokens: 1_050_000,
    description:
      'Reasoning model at flash pricing. Measured charges run ~44% above the published coefficient.',
    displayName: 'DeepSeek V4.1 Flash',
    id: 'deepseek-v4.1-flash',
    pricing: cvcPricing(0.3),
    type: 'chat',
  },
  {
    abilities: { functionCall: true, reasoning: true },
    contextWindowTokens: 500_000,
    description:
      'Strongest reasoning per unit cost, with a smaller context window than the flash tier.',
    displayName: 'Grok 4.6',
    enabled: true,
    id: 'grok-4.6',
    pricing: cvcPricing(0.5),
    type: 'chat',
  },
  {
    abilities: { functionCall: true },
    contextWindowTokens: 1_000_000,
    displayName: 'Qwen3.8 Flash',
    id: 'qwen3.8-flash',
    pricing: cvcPricing(0.7),
    type: 'chat',
  },
  {
    abilities: { functionCall: true, reasoning: true, vision: true },
    contextWindowTokens: 1_050_000,
    displayName: 'GPT-5.6 Terra',
    id: 'gpt-5.6-terra',
    pricing: cvcPricing(1.5),
    type: 'chat',
  },
  {
    abilities: { functionCall: true, vision: true },
    contextWindowTokens: 1_000_000,
    displayName: 'Claude Sonnet 5',
    enabled: true,
    id: 'claude-sonnet-5',
    pricing: cvcPricing(2),
    type: 'chat',
  },
  {
    abilities: { functionCall: true, reasoning: true, vision: true },
    contextWindowTokens: 1_050_000,
    displayName: 'Gemini 3.8 Flash',
    id: 'gemini-3.8-flash',
    pricing: cvcPricing(2),
    type: 'chat',
  },
  {
    abilities: { functionCall: true, reasoning: true, vision: true },
    contextWindowTokens: 1_000_000,
    description:
      'Reserved for long tool chains and explicit user escalation — twice the cost of Sonnet.',
    displayName: 'Claude Opus 5',
    id: 'claude-opus-5',
    pricing: cvcPricing(4),
    type: 'chat',
  },
  {
    abilities: { functionCall: true, reasoning: true, vision: true },
    contextWindowTokens: 1_000_000,
    description: 'Highest quality in the catalog and by far the most expensive.',
    displayName: 'Claude Fable 5.1',
    id: 'claude-fable-5-1',
    pricing: cvcPricing(8),
    type: 'chat',
  },
  {
    abilities: { reasoning: true },
    description:
      'Cheapest model in the catalog. Measured charges run ~45% above the published coefficient.',
    displayName: 'MiMo V2.5',
    id: 'mimo-v2.5',
    pricing: cvcPricing(0.05),
    type: 'chat',
  },
];

export const allModels = [...cheapvibecodeChatModels];

export default allModels;
