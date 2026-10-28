import { ConnectorToolPermission } from '@/database/schemas';
import { inferCrudType } from '@/libs/mcp/utils';

export interface ComposioToolLike {
  description?: string;
  inputParameters?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  name?: string;
  slug?: string;
}

/**
 * Manifest budget per Composio app. Composio exposes hundreds of tools per
 * toolkit (823 for GitHub); advertising all of them costs hundreds of KB of
 * schema on every turn. The curated set keeps reads (list/get/search) plus the
 * few writes people actually ask for — everything else stays in Composio and
 * can be surfaced later by a tool search/activation path.
 */
const DEFAULT_MAX_TOOLS = 40;

/** Writes worth advertising up front. Everything not listed stays out of the manifest. */
const PRIORITY_WRITES = 8;

const GITHUB_PRIORITY_SLUGS = [
  // Reads — the common "look at my repo" path.
  'GITHUB_GET_THE_AUTHENTICATED_USER',
  'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
  'GITHUB_LIST_REPOSITORIES_FOR_A_USER',
  'GITHUB_GET_A_REPOSITORY',
  'GITHUB_GET_REPOSITORY_CONTENT',
  'GITHUB_GET_A_REPOSITORY_README',
  'GITHUB_SEARCH_CODE',
  'GITHUB_SEARCH_REPOSITORIES',
  'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS',
  'GITHUB_LIST_BRANCHES',
  'GITHUB_GET_A_BRANCH',
  'GITHUB_LIST_COMMITS',
  'GITHUB_GET_A_COMMIT',
  'GITHUB_LIST_PULL_REQUESTS',
  'GITHUB_GET_A_PULL_REQUEST',
  'GITHUB_LIST_PULL_REQUESTS_FILES',
  'GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER',
  'GITHUB_GET_AN_ISSUE',
  'GITHUB_LIST_ISSUE_COMMENTS',
  'GITHUB_LIST_RELEASES',
  'GITHUB_GET_THE_LATEST_RELEASE',
  'GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY',
  'GITHUB_LIST_REVIEWS_FOR_A_PULL_REQUEST',
  'GITHUB_GET_A_TREE',
  'GITHUB_LIST_ORGANIZATIONS_FOR_THE_AUTHENTICATED_USER',
  'GITHUB_CHECK_IF_A_PULL_REQUEST_HAS_BEEN_MERGED',
  'GITHUB_COMPARE_TWO_COMMITS',
  // Writes — approval-gated at sync time.
  'GITHUB_CREATE_AN_ISSUE',
  'GITHUB_CREATE_AN_ISSUE_COMMENT',
  'GITHUB_CREATE_A_PULL_REQUEST',
  'GITHUB_ADD_LABELS_TO_AN_ISSUE',
  'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
  'GITHUB_MERGE_A_PULL_REQUEST',
  'GITHUB_CREATE_A_RELEASE',
  'GITHUB_UPDATE_AN_ISSUE',
];

const PRIORITY_SLUGS_BY_APP: Record<string, string[]> = {
  github: GITHUB_PRIORITY_SLUGS,
};

const slugOf = (tool: ComposioToolLike) => (tool.slug || tool.name || '').toUpperCase();

export const isComposioReadTool = (slug: string) => inferCrudType(slug) === 'read';

/**
 * Keep the highest-value slice of a Composio tool list: reads first (priority
 * slugs in curated order, then alphabetical), plus a handful of priority
 * writes. Non-priority writes are dropped — they are destructive and the model
 * can still reach them after a future activation/search surface.
 */
export const curateComposioTools = <T extends ComposioToolLike>(
  tools: T[],
  options: { max?: number; prioritySlugs?: string[] } = {},
): T[] => {
  const max = options.max ?? DEFAULT_MAX_TOOLS;
  const prioritySlugs = options.prioritySlugs ?? [];
  const priorityRank = (slug: string) => {
    const index = prioritySlugs.indexOf(slug);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  const seen = new Set<string>();
  const unique = tools.filter((tool) => {
    const slug = slugOf(tool);
    if (!slug || seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });

  const reads = unique.filter((tool) => isComposioReadTool(slugOf(tool)));
  const writes = unique.filter((tool) => !isComposioReadTool(slugOf(tool)));

  const priorityWrites = writes
    .filter((tool) => prioritySlugs.includes(slugOf(tool)))
    .slice(0, PRIORITY_WRITES);

  const readBudget = Math.max(0, max - priorityWrites.length);
  const selectedReads = [...reads]
    .sort(
      (a, b) =>
        priorityRank(slugOf(a)) - priorityRank(slugOf(b)) || slugOf(a).localeCompare(slugOf(b)),
    )
    .slice(0, readBudget);

  return [...selectedReads, ...priorityWrites];
};

export type RawToolsClient = {
  tools: {
    getRawComposioTools: (query: {
      limit?: number;
      toolkits: string[];
    }) => Promise<ComposioToolLike[] | { items?: ComposioToolLike[] }>;
  };
};

/**
 * Fetch the tools Composio exposes for a toolkit.
 *
 * Apps with a curation list (currently GitHub) are fetched in full and curated:
 * passing `limit` is what makes this work, because without it the SDK implicitly
 * adds `important: true`, which returns only page 1 (20 "important", mostly
 * write tools) and hides every read action.
 *
 * Other apps keep the previous behaviour (the SDK's important page) until they
 * get their own curation list.
 */
export const fetchCuratedComposioTools = async (
  client: RawToolsClient,
  appSlug: string,
  max = DEFAULT_MAX_TOOLS,
): Promise<ComposioToolLike[]> => {
  const prioritySlugs = PRIORITY_SLUGS_BY_APP[appSlug.toLowerCase()];

  const response = await client.tools.getRawComposioTools(
    prioritySlugs ? { limit: 1000, toolkits: [appSlug] } : { toolkits: [appSlug] },
  );
  const items = (
    Array.isArray(response) ? response : (response?.items ?? [])
  ) as ComposioToolLike[];

  if (!prioritySlugs) return items.slice(0, max);

  return curateComposioTools(items, { max, prioritySlugs });
};

/**
 * Version of the tool set a Composio connector row was synced with. Bump it
 * whenever the curation rules change: ACTIVE connectors stamped with an older
 * (or no) `metadata.composio.toolsVersion` are re-synced on their next agent run,
 * because the saved tool rows are otherwise only written once, at connect time.
 */
export const COMPOSIO_TOOLS_VERSION = 1;

export interface ComposioToolInput {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
}

/** Normalize a raw Composio tool (slug/inputParameters) to the shape stored on connector rows. */
export const normalizeComposioTool = (tool: ComposioToolLike) => ({
  description: tool.description || '',
  inputSchema: tool.inputParameters ||
    tool.inputSchema || {
      properties: {},
      type: 'object',
    },
  name: tool.slug || tool.name || '',
});

/**
 * Map synced tools to `user_connector_tools` rows. Read actions run unattended;
 * anything that mutates the user's account needs a human approval. Only applied
 * to newly-inserted rows — an explicit user choice is preserved on re-sync.
 */
export const toConnectorToolRows = (tools: ComposioToolInput[]) =>
  tools.map((t) => {
    const crudType = inferCrudType(t.name);
    return {
      crudType,
      defaultPermission:
        crudType === 'read' ? ConnectorToolPermission.auto : ConnectorToolPermission.needs_approval,
      description: t.description,
      inputSchema: t.inputSchema,
      toolName: t.name,
    };
  });
