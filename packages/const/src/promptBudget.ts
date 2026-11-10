/**
 * Max chars of any single injected context (file content, page markdown/XML,
 * selections) copied into the LLM prompt. Unbounded injection turns a large
 * document into a multi-megabyte request body that dies at the reverse proxy
 * (HTTP 413) — or worse, reaches the provider as a tens-of-millions-token
 * prompt no model answers. Full content stays in storage/RAG; only the
 * prompt copy is cut, with a note telling the agent what happened.
 */
export const PROMPT_CONTENT_BUDGET = 50_000;

export const truncatePromptContent = (content: string, scope: string): string => {
  if (content.length <= PROMPT_CONTENT_BUDGET) return content;
  return `${content.slice(0, PROMPT_CONTENT_BUDGET)}… [truncated: showing first ${PROMPT_CONTENT_BUDGET} of ${content.length} chars of ${scope}. Ask the user to narrow down what they need.]`;
};
