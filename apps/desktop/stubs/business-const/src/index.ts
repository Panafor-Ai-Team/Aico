// Branding has no server-only imports, so re-export it instead of copying values:
// a hand-written copy fell behind (BRANDING_EMAIL was missing and broke the renderer build).
export * from '../../../../../packages/business/const/src/branding';

export const DEFAULT_EMBEDDING_PROVIDER = 'openrouter';
export const DEFAULT_MINI_MODEL = 'openai/gpt-4o-mini';
export const DEFAULT_SUB_AGENT_MODEL = 'deepseek/deepseek-chat-v3.1';
export const toLiveManagedModelId = (modelId: string): string => modelId;
export const DEFAULT_MINI_PROVIDER = 'openrouter';
export const DEFAULT_MODEL = 'openrouter/auto';
export const DEFAULT_ONBOARDING_MODEL = 'openrouter/auto';
export const DEFAULT_ONBOARDING_PROVIDER = 'openrouter';
export const DEFAULT_PROVIDER = 'openrouter';
// mirrored from packages/business/const — model-bank gates the LobeHub
// provider entry on this flag; the OSS desktop build keeps it off
export const ENABLE_BUSINESS_FEATURES = false;

// Re-export Aico error catalog so client imports stay resolvable in desktop stubs.
export {
  AICO_ERROR_ALIASES,
  AICO_ERROR_CODES,
  AICO_ERROR_MESSAGES_FA,
  isAicoErrorCode,
  normalizeAicoErrorCode,
  resolveAicoErrorCode,
} from '../../../../../packages/business/const/src/aicoErrors';
