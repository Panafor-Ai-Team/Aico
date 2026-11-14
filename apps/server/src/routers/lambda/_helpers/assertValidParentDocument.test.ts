// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { assertValidParentDocument } from './assertValidParentDocument';

const tree = (rows: Record<string, string | null>) => ({
  findById: async (id: string) => (id in rows ? { id, parentId: rows[id] } : undefined),
});

describe('assertValidParentDocument', () => {
  const docs = tree({ a: null, b: 'a', c: 'b', x: null });

  it('allows a parent the caller can see', async () => {
    await expect(assertValidParentDocument(docs, 'x', 'c')).resolves.toBeUndefined();
    await expect(assertValidParentDocument(docs, 'c')).resolves.toBeUndefined();
    await expect(assertValidParentDocument(docs, null, 'c')).resolves.toBeUndefined();
  });

  it('rejects a parent id the caller cannot see', async () => {
    await expect(assertValidParentDocument(docs, 'someone-else')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects moving a folder into itself', async () => {
    await expect(assertValidParentDocument(docs, 'a', 'a')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects moving a folder under its own descendant', async () => {
    await expect(assertValidParentDocument(docs, 'c', 'a')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('terminates on an existing loop in stored data', async () => {
    const looped = tree({ p: 'q', q: 'p', m: null });
    await expect(assertValidParentDocument(looped, 'p', 'm')).resolves.toBeUndefined();
  });
});
