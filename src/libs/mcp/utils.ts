import type { ToolCRUDType } from '@/database/schemas';

// Prefix-based matching (anchored at ^) handles camelCase names like getReactions, listPins.
// \b word-boundary fails on camelCase because adjacent word-chars share no boundary.
const DELETE_PREFIX = /^(?:delete|remove|destroy|drop|unlink|uninstall|clear|purge)/;
const UPDATE_PREFIX = /^(?:update|edit|modify|patch|set|change|rename|move)/;
const READ_PREFIX =
  /^(?:get|list|read|fetch|search|find|check|compare|describe|show|view|extract|query|count)/;

/** Drops a leading toolkit namespace (`github_list_issues` → `list_issues`). */
const stripNamespace = (name: string) => {
  const separator = name.indexOf('_');
  return separator === -1 ? name : name.slice(separator + 1);
};

/**
 * Infer the CRUD operation type from an MCP tool name.
 *
 * Uses prefix matching so camelCase names like getReactions, listPins, searchMessages
 * are correctly classified as 'read'. Priority: delete > update > read > write.
 * The 'write' fallback covers create/add/save/send/upload/post/connect etc.
 */
export function inferCrudType(toolName: string): ToolCRUDType {
  // Namespaced tool names (`GITHUB_GET_REPOS`, `linear_list_issues`) never match
  // the anchored prefixes, so also try the name without its leading namespace.
  for (const name of [toolName.toLowerCase(), stripNamespace(toolName.toLowerCase())]) {
    if (DELETE_PREFIX.test(name)) return 'delete';
    if (UPDATE_PREFIX.test(name)) return 'update';
    if (READ_PREFIX.test(name)) return 'read';
  }
  return 'write';
}
