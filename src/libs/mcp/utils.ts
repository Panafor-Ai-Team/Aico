import { isRecord } from '@lobechat/utils/object';

import type { ToolCRUDType } from '@/database/schemas';

// Prefix-based matching (anchored at ^). The verb must end at a word boundary
// or a longer word swallows it: `drop` would match `dropbox_…` (classifying the
// whole Dropbox toolkit as delete) and `check` would match `checkout_…`. The
// boundary differs by naming style: underscore names (GITHUB_GET_X,
// linear_list_issues) end the verb at `_`; camelCase names (getReactions) end
// it at an uppercase hump. A false delete mislabels mutating tools as safe; a
// false write only costs an extra approval, so this errs safe-side.
const verbPrefixes = (boundary: string) => ({
  delete: new RegExp(`^(?:delete|remove|destroy|drop|unlink|uninstall|clear|purge)${boundary}`),
  update: new RegExp(`^(?:update|edit|modify|patch|set|change|rename|move)${boundary}`),
  read: new RegExp(
    `^(?:get|list|read|fetch|search|find|check|compare|describe|show|view|extract|query|count)${boundary}`,
  ),
});
const SNAKE_PREFIXES = verbPrefixes('(?=_|$)');
const CAMEL_PREFIXES = verbPrefixes('(?=[A-Z]|$)');

/** Drops a leading toolkit namespace (`github_list_issues` → `list_issues`). */
const stripNamespace = (name: string) => {
  const separator = name.indexOf('_');
  return separator === -1 ? name : name.slice(separator + 1);
};

export interface MCPErrorLogMetadata {
  code?: number;
  name: string;
}

/**
 * Error messages and objects are untrusted remote data, so MCP logs only keep fixed metadata.
 */
export const getMCPErrorLogMetadata = (error: unknown): MCPErrorLogMetadata => {
  const errorRecord = isRecord(error) ? error : undefined;
  const rawCode = errorRecord?.code;
  const code = typeof rawCode === 'number' ? rawCode : undefined;

  return {
    code,
    name: error instanceof Error ? 'Error' : typeof error,
  };
};

/**
 * URL paths can contain session keys or signed values, so logs retain the origin only.
 */
export const getMCPLogOrigin = (endpoint: string): string | undefined => {
  try {
    return new URL(endpoint).origin;
  } catch {
    return undefined;
  }
};

/**
 * Infer the CRUD operation type from an MCP tool name.
 *
 * Uses prefix matching so camelCase names like getReactions, listPins, searchMessages
 * are correctly classified as 'read'. Priority: delete > update > read > write.
 * The 'write' fallback covers create/add/save/send/upload/post/connect etc.
 */
export function inferCrudType(toolName: string): ToolCRUDType {
  // camelCase names keep their case for the uppercase-hump boundary; underscore
  // names (`GITHUB_GET_REPOS`, `linear_list_issues`) are lowercased and also
  // tried without their leading namespace, since the anchors never match it.
  const isCamel = !toolName.includes('_') && /[A-Z]/.test(toolName);
  const prefixes = isCamel ? CAMEL_PREFIXES : SNAKE_PREFIXES;
  const names = isCamel
    ? [toolName]
    : [toolName.toLowerCase(), stripNamespace(toolName.toLowerCase())];
  for (const name of names) {
    if (prefixes.delete.test(name)) return 'delete';
    if (prefixes.update.test(name)) return 'update';
    if (prefixes.read.test(name)) return 'read';
  }
  return 'write';
}
