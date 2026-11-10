import type { DynamicInterventionResolver } from '@lobechat/types';

/**
 * Dynamic intervention resolver id registered by the client and server runtimes.
 * Referenced from the manifest so `generateVideo` opens the settings / confirm
 * card before every interactive generation.
 */
export const VIDEO_GENERATION_CONFIRM_AUDIT = 'videoGenerationSettingsConfirmAudit';

/**
 * Every interactive `generateVideo` call waits for the confirm card, where the
 * user picks the quality, frame shape and duration — whatever their approval
 * mode. Headless runs (bots, scheduled tasks) have no card to answer, so they
 * generate straight away.
 */
export const videoGenerationSettingsConfirmAudit: DynamicInterventionResolver = async (
  _toolArgs,
  metadata,
) => metadata?.approvalMode !== 'headless';
