import { TRPCError } from '@trpc/server';

/** Deeper than any real folder tree; stops a walk over corrupted data. */
export const MAX_DOCUMENT_TREE_DEPTH = 100;

interface ParentLookup {
  findById: (id: string) => Promise<{ id: string; parentId: string | null } | undefined>;
}

/**
 * Check a requested parent before a document or file is created under it or
 * moved into it:
 * - the parent must be a document the caller can see (not another user's id),
 * - a document cannot become its own parent or move under one of its own
 *   descendants. Such a cycle makes the breadcrumb, recursive delete and
 *   subtree walks loop forever.
 */
export const assertValidParentDocument = async (
  documentModel: ParentLookup,
  parentId: string | null | undefined,
  movingDocumentId?: string,
) => {
  if (!parentId) return;

  if (movingDocumentId && parentId === movingDocumentId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A folder cannot be moved into itself' });
  }

  const parent = await documentModel.findById(parentId);
  if (!parent) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Parent folder not found' });
  }

  if (!movingDocumentId) return;

  const seen = new Set<string>([parent.id]);
  let ancestorId = parent.parentId;
  for (let depth = 0; ancestorId && depth < MAX_DOCUMENT_TREE_DEPTH; depth++) {
    if (ancestorId === movingDocumentId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A folder cannot be moved into one of its own subfolders',
      });
    }
    if (seen.has(ancestorId)) break;
    seen.add(ancestorId);

    const ancestor = await documentModel.findById(ancestorId);
    ancestorId = ancestor?.parentId ?? null;
  }
};
