// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  MAX_PAGE_PAYLOAD_LENGTH,
  PAGE_TOO_LARGE_MESSAGE,
  saveDocumentHistoryInputSchema,
  updateDocumentInputSchema,
} from './documentHistory';

describe('page payload cap', () => {
  it('accepts a page up to 5 MB', () => {
    const body = 'x'.repeat(MAX_PAGE_PAYLOAD_LENGTH);
    expect(updateDocumentInputSchema.safeParse({ content: body, id: 'docs_1' }).success).toBe(true);
  });

  it('refuses a larger page with PAGE_TOO_LARGE', () => {
    const body = 'x'.repeat(MAX_PAGE_PAYLOAD_LENGTH + 1);
    for (const result of [
      updateDocumentInputSchema.safeParse({ editorData: body, id: 'docs_1' }),
      saveDocumentHistoryInputSchema.safeParse({
        documentId: 'docs_1',
        editorData: body,
        saveSource: 'autosave',
      }),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(PAGE_TOO_LARGE_MESSAGE);
    }
  });
});
