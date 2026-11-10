/**
 * Shared tool filtering logic used across both runtime (ToolsEngine)
 * and display layer (selectors)
 */
import { CloudSandboxManifest } from '@lobechat/builtin-tool-cloud-sandbox';
import { LocalSystemManifest } from '@lobechat/builtin-tool-local-system';
import { isDesktop } from '@lobechat/const';

/**
 * Check if a tool should be enabled based on platform-specific constraints
 * @param toolId - The tool identifier to check
 * @returns true if the tool should be enabled, false otherwise
 */
export const shouldEnableTool = (toolId: string): boolean => {
  // Filter LocalSystem tool in non-desktop environment
  if (toolId === LocalSystemManifest.identifier) {
    return isDesktop;
  }

  // Cloud Sandbox needs a sandbox backend on the deployment. Without one every
  // call dead-ends in a Market 401, so keep it out of discovery and activation
  // too (the activator resolves through this same check).
  if (toolId === CloudSandboxManifest.identifier) {
    if (typeof window === 'undefined') return true;

    return window.global_serverConfigStore?.getState()?.serverConfig?.enableCloudSandbox !== false;
  }

  return true;
};

/**
 * Filter tool IDs based on platform constraints
 * @param toolIds - Array of tool identifiers to filter
 * @returns Filtered array of tool identifiers
 */
export const filterToolIds = (toolIds: string[]): string[] => {
  return toolIds.filter(shouldEnableTool);
};
