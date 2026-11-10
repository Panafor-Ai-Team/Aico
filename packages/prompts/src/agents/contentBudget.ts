// Shared with the DB hydration path so an oversized file never reaches the
// wire (agent config) before the prompt formatter can cap it.
export { PROMPT_CONTENT_BUDGET, truncatePromptContent } from '@lobechat/const';
