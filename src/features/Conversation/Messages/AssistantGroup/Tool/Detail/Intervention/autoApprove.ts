import { DEFAULT_SECURITY_BLACKLIST, InterventionChecker } from '@lobechat/agent-runtime';
import { isConfirmCancelIntervention } from '@lobechat/builtin-tools/interventions';
import type { ExtendedHumanInterventionConfig } from '@lobechat/types';
import { safeParseJSON } from '@lobechat/utils';

import { isCustomInteractionIdentifier } from './customInteractionHandlers';

interface InterventionManifest {
  api?: { humanIntervention?: ExtendedHumanInterventionConfig; name: string }[];
  humanIntervention?: ExtendedHumanInterventionConfig;
}

interface AutoApproveParams {
  apiName: string;
  identifier: string;
  manifest?: InterventionManifest;
  requestArgs: string;
}

/**
 * Whether a pending approval may be approved on the user's behalf once they
 * granted approval for the request or the chat. Mirrors the hard stops the
 * runtime keeps in `auto-run` mode: question / custom interaction cards, cost
 * confirmations, security-blacklisted arguments and `always` policies (static
 * or dynamic) still need the user.
 */
export const canAutoApprovePendingIntervention = ({
  apiName,
  identifier,
  manifest,
  requestArgs,
}: AutoApproveParams): boolean => {
  if (isCustomInteractionIdentifier(identifier, apiName)) return false;
  if (isConfirmCancelIntervention(identifier, apiName)) return false;

  const toolArgs = (safeParseJSON(requestArgs || '') ?? {}) as Record<string, any>;
  if (InterventionChecker.checkSecurityBlacklist(DEFAULT_SECURITY_BLACKLIST, toolArgs).blocked)
    return false;

  const config =
    manifest?.api?.find((api) => api.name === apiName)?.humanIntervention ??
    manifest?.humanIntervention;
  // Dynamic (audited) policy: a pending call means the audit fired, so it asks
  // with `dynamic.policy` (the runtime defaults it to `always`).
  if (config && typeof config === 'object' && !Array.isArray(config))
    return (config.dynamic.policy ?? 'always') !== 'always';

  return InterventionChecker.shouldIntervene({ config, toolArgs }) !== 'always';
};
