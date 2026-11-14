import { pluginHelpers } from '@/store/tool/helpers';

import type { ActivateToolsState } from '../../../types';

type ToolNameTranslator = Parameters<typeof pluginHelpers.getToolDisplayName>[1];

export interface ActivateToolChip {
  avatar?: string;
  identifier: string;
  name: string;
}

export interface ActivateToolsDisplay {
  /** Localized names of identifiers the activator could not resolve. */
  notFoundNames: string[];
  /** Tools named in the call arguments (shown while streaming / awaiting approval). */
  requestedTools: ActivateToolChip[];
  /** Activated tools once the call finished, else the requested ones. */
  visibleTools: ActivateToolChip[];
}

/**
 * Turns activator arguments/state into the labels the inspector shows. Users
 * see tool titles; internal identifiers such as `lobe-skill-store` (and the raw
 * names persisted in older tool results) never reach the chip text.
 */
export const getActivateToolsDisplay = (
  identifiers: string[] | undefined,
  pluginState: Partial<ActivateToolsState> | undefined,
  t: ToolNameTranslator,
): ActivateToolsDisplay => {
  const displayName = (identifier: string, title?: string) =>
    pluginHelpers.getToolDisplayName(identifier, t, title);

  const requestedTools = (identifiers ?? []).map((identifier) => ({
    identifier,
    name: displayName(identifier),
  }));
  const activatedTools = (pluginState?.activatedTools ?? []).map((tool) => ({
    avatar: tool.avatar,
    identifier: tool.identifier,
    name: displayName(tool.identifier, tool.name),
  }));

  return {
    notFoundNames: (pluginState?.notFound ?? []).map((identifier) => displayName(identifier)),
    requestedTools,
    visibleTools: activatedTools.length > 0 ? activatedTools : requestedTools,
  };
};
