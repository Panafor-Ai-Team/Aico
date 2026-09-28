import {
  IMAGE_GENERATION_CONFIRM_AUDIT,
  imageGenerationModelConfirmAudit,
} from '@lobechat/builtin-tool-image-generation';
import { pathScopeAudit } from '@lobechat/builtin-tool-local-system';
import {
  VIDEO_GENERATION_CONFIRM_AUDIT,
  videoGenerationSettingsConfirmAudit,
} from '@lobechat/builtin-tool-video-generation';
import { type DynamicInterventionResolver } from '@lobechat/types';

/**
 * Server AgentRuntime loads these audits. Chat image / video generation runs on
 * the server when DEVICE_GATEWAY is unset; without these entries the dynamic
 * intervention falls back to `default: 'never'`, so the confirm card never opens.
 */
export const dynamicInterventionAudits: Record<string, DynamicInterventionResolver> = {
  [IMAGE_GENERATION_CONFIRM_AUDIT]: imageGenerationModelConfirmAudit,
  [VIDEO_GENERATION_CONFIRM_AUDIT]: videoGenerationSettingsConfirmAudit,
  pathScopeAudit,
};
