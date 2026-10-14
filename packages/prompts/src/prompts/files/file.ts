import type { ChatFileItem } from '@lobechat/types';

/**
 * Max file-content chars injected into the LLM prompt per file. Unbounded
 * injection hangs the agent run (a 100MB CSV becomes a ~25M-token prompt no
 * provider answers). Full content stays in storage/RAG — only the prompt
 * copy is cut, with a note telling the agent what happened.
 */
export const FILE_PROMPT_CONTENT_BUDGET = 50_000;

const truncateContent = (content: string): string => {
  if (content.length <= FILE_PROMPT_CONTENT_BUDGET) return content;
  return `${content.slice(0, FILE_PROMPT_CONTENT_BUDGET)}… [file content truncated: showing first ${FILE_PROMPT_CONTENT_BUDGET} of ${content.length} chars. Ask the user to narrow down what they need.]`;
};

const filePrompt = (item: ChatFileItem, addUrl: boolean) => {
  const content = truncateContent(item.content || '');
  return addUrl
    ? `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}" url="${item.url}">${content}</file>`
    : `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}">${content}</file>`;
};

export const filePrompts = (fileList: ChatFileItem[], addUrl: boolean) => {
  if (fileList.length === 0) return '';

  const prompt = `<files>
<files_docstring>here are user upload files you can refer to</files_docstring>
${fileList.map((item) => filePrompt(item, addUrl)).join('\n')}
</files>`;

  return prompt.trim();
};
