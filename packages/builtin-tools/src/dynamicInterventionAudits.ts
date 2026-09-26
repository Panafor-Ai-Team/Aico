import {
  IMAGE_GENERATION_CONFIRM_AUDIT,
  imageGenerationModelConfirmAudit,
} from '@lobechat/builtin-tool-image-generation';
import { pathScopeAudit } from '@lobechat/builtin-tool-local-system';
import { type DynamicInterventionResolver } from '@lobechat/types';

/**
 * Server AgentRuntime loads these audits. Chat image generation runs on the
 * server when DEVICE_GATEWAY is unset; without this entry the dynamic
 * intervention falls back to `default: 'never'`, so the confirm card never
 * opens and a bare `gpt-image-2` arg is never rewritten to the catalog id.
 */
export const dynamicInterventionAudits: Record<string, DynamicInterventionResolver> = {
  [IMAGE_GENERATION_CONFIRM_AUDIT]: imageGenerationModelConfirmAudit,
  pathScopeAudit,
};
