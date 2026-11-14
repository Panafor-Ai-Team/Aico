import { CUSTOM_FOLDER_FILE_TYPE, DERIVED_DOCUMENT_SOURCE_TYPE } from '@lobechat/const';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  businessFileTransferStorageCheck,
  businessFileUploadCheck,
} from '@/business/server/lambda-routers/file';
import { checkFileStorageUsage } from '@/business/server/trpc-middlewares/lambda';
import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { serverDBEnv } from '@/config/db';
import { AsyncTaskModel } from '@/database/models/asyncTask';
import { ChunkModel } from '@/database/models/chunk';
import { DocumentModel } from '@/database/models/document';
import { FileModel } from '@/database/models/file';
import { KnowledgeBaseModel } from '@/database/models/knowledgeBase';
import { KnowledgeRepo } from '@/database/repositories/knowledge';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { DocumentService } from '@/server/services/document';
import { FileService } from '@/server/services/file';
import { assertCanPerformResourceAction } from '@/server/services/resourcePermission';
import { hasWorkspaceScopedPermission } from '@/server/services/workspacePermission';
import { AsyncTaskStatus, AsyncTaskType, type IAsyncTaskError } from '@/types/asyncTask';
import type { FileListItem, KnowledgeItemStatus } from '@/types/files';
import { QueryFileListSchema, toFileSource, UploadFileSchema } from '@/types/files';
import { TransferErrorCode } from '@/types/transferError';

import { assertValidParentDocument } from './_helpers/assertValidParentDocument';
import {
  assertWorkspaceRowManageable,
  isWorkspaceNonOwner,
} from './_helpers/assertWorkspaceRowManageable';
import {
  assertFileNotInRestrictedKnowledgeBase,
  assertKnowledgeBaseBrowsable,
  getRestrictedKnowledgeBaseIds,
} from './_helpers/knowledgeBaseAccess';

const fileTransferEntityTypeSchema = z.enum(['document', 'file', 'folder']);
const deleteKnowledgeItemsByQuerySchema = QueryFileListSchema.extend({
  excludedIds: z.array(z.string()).optional(),
});

const filterKnowledgeItems = <
  T extends {
    fileType: string;
    sourceType: string;
  },
>(
  items: T[],
  knowledgeBaseId?: string,
) => {
  return !knowledgeBaseId
    ? items.filter(
        (item) =>
          !(
            item.sourceType === DERIVED_DOCUMENT_SOURCE_TYPE &&
            item.fileType === CUSTOM_FOLDER_FILE_TYPE
          ),
      )
    : items;
};

const getKnowledgeItemStatusMap = async (
  ctx: {
    asyncTaskModel: AsyncTaskModel;
    chunkModel: ChunkModel;
  },
  fileItems: Array<{
    chunkTaskId?: string | null;
    embeddingTaskId?: string | null;
    id: string;
  }>,
): Promise<Map<string, KnowledgeItemStatus>> => {
  if (fileItems.length === 0) return new Map();

  const fileIds = fileItems.map((item) => item.id);
  const chunkTaskIds = [
    ...new Set(fileItems.map((item) => item.chunkTaskId).filter(Boolean)),
  ] as string[];
  const embeddingTaskIds = [
    ...new Set(fileItems.map((item) => item.embeddingTaskId).filter(Boolean)),
  ] as string[];

  const [chunks, chunkTasks, embeddingTasks] = await Promise.all([
    ctx.chunkModel.countByFileIds(fileIds),
    chunkTaskIds.length > 0
      ? ctx.asyncTaskModel.findByIds(chunkTaskIds, AsyncTaskType.Chunking)
      : Promise.resolve([]),
    embeddingTaskIds.length > 0
      ? ctx.asyncTaskModel.findByIds(embeddingTaskIds, AsyncTaskType.Embedding)
      : Promise.resolve([]),
  ]);

  const chunkRows = chunks ?? [];
  const chunkTaskRows = chunkTasks ?? [];
  const embeddingTaskRows = embeddingTasks ?? [];

  const chunkCountMap = new Map(
    chunkRows.filter((item) => item.id).map((item) => [item.id, item.count] as const),
  );
  const chunkTaskMap = new Map(chunkTaskRows.map((task) => [task.id, task] as const));
  const embeddingTaskMap = new Map(embeddingTaskRows.map((task) => [task.id, task] as const));

  return new Map(
    fileItems.map((item) => {
      const chunkTask = item.chunkTaskId ? chunkTaskMap.get(item.chunkTaskId) : null;
      const embeddingTask = item.embeddingTaskId
        ? embeddingTaskMap.get(item.embeddingTaskId)
        : null;

      return [
        item.id,
        {
          chunkCount: chunkCountMap.get(item.id) ?? null,
          chunkingError: (chunkTask?.error as IAsyncTaskError | null | undefined) ?? null,
          chunkingStatus: (chunkTask?.status as AsyncTaskStatus | null | undefined) ?? null,
          embeddingError: (embeddingTask?.error as IAsyncTaskError | null | undefined) ?? null,
          embeddingStatus: (embeddingTask?.status as AsyncTaskStatus | null | undefined) ?? null,
          finishEmbedding: embeddingTask?.status === AsyncTaskStatus.Success,
          id: item.id,
        },
      ] as const;
    }),
  );
};

// A fresh upload is claimed by createFile right after the PUT finishes. Large
// multipart uploads can run long, so allow a day before an unclaimed object is
// treated as someone else's.
const UNCLAIMED_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isStoredObjectAvailable = async (fileService: FileService, url: string): Promise<boolean> => {
  try {
    // Hash records can outlive their backing object, for example when generated
    // assets are cleaned up but the global hash row remains. Treat stale rows as
    // missing so the client uploads a fresh copy instead of reusing a dead key.
    await fileService.getFileMetadata(url);
    return true;
  } catch (error) {
    console.error('Failed to verify existing file hash storage object:', error);
    return false;
  }
};

const fileProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const wsId = ctx.workspaceId ?? undefined;

  return opts.next({
    ctx: {
      asyncTaskModel: new AsyncTaskModel(ctx.serverDB, ctx.userId, wsId),
      chunkModel: new ChunkModel(ctx.serverDB, ctx.userId, wsId),
      documentModel: new DocumentModel(ctx.serverDB, ctx.userId, wsId),
      documentService: new DocumentService(ctx.serverDB, ctx.userId, wsId),
      fileModel: new FileModel(ctx.serverDB, ctx.userId, wsId),
      fileService: new FileService(ctx.serverDB, ctx.userId, wsId),
      knowledgeBaseModel: new KnowledgeBaseModel(ctx.serverDB, ctx.userId, wsId),
      knowledgeRepo: new KnowledgeRepo(ctx.serverDB, ctx.userId, wsId),
    },
  });
});

export const fileRouter = router({
  checkFileHash: fileProcedure
    .use(withScopedPermission('file:upload'))
    .use(checkFileStorageUsage)
    .input(z.object({ hash: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Only reuse bytes the caller already stored, and answer with the
      // caller's own copy. Answering for another user's hash would reveal that
      // someone uploaded this exact file and hand out their storage key; the
      // caller just uploads its own copy instead.
      const ownFile = await ctx.fileModel.findOwnFileByHash(input.hash);
      if (!ownFile?.url) return { isExist: false };

      const isStorageAvailable = await isStoredObjectAvailable(ctx.fileService, ownFile.url);
      if (!isStorageAvailable) return { isExist: false };

      return {
        fileType: ownFile.fileType,
        isExist: true,
        metadata: { ...(ownFile.metadata as Record<string, unknown> | null), path: ownFile.url },
        size: ownFile.size,
        url: ownFile.url,
      };
    }),

  createFile: fileProcedure
    .use(withScopedPermission('file:upload'))
    .use(checkFileStorageUsage)
    .input(
      UploadFileSchema.omit({ url: true }).extend({
        parentId: z.string().optional(),
        url: z.string(),
        visibility: z.enum(['private', 'public']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existingFile = await ctx.fileModel.checkHash(input.hash!);
      const { isExist } = existingFile;

      // Resolve parentId if it's a slug
      let resolvedParentId = input.parentId;
      let parentVisibility: 'private' | 'public' | undefined;
      if (input.parentId) {
        const docBySlug = await ctx.documentModel.findBySlug(input.parentId);
        if (docBySlug) {
          resolvedParentId = docBySlug.id;
          parentVisibility = docBySlug.visibility;
        } else {
          const docById = await ctx.documentModel.findById(input.parentId);
          if (!docById) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Parent folder not found' });
          }
          parentVisibility = docById.visibility;
        }
      }

      let knowledgeBaseVisibility: 'private' | 'public' | undefined;
      if (input.knowledgeBaseId) {
        // Checked in personal mode too, so a caller cannot add a file to
        // another user's library by id.
        const knowledgeBase = await ctx.knowledgeBaseModel.findById(input.knowledgeBaseId);
        if (!knowledgeBase) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge base not found' });
        }
        if (ctx.workspaceId) knowledgeBaseVisibility = knowledgeBase.visibility;
      }

      // Visibility precedence (workspace mode only — personal mode ignores the
      // column entirely):
      //   1. A library upload always uses the knowledge base visibility.
      //   2. Otherwise an explicit caller value wins.
      //   3. Otherwise inherit the parent document's visibility so a file
      //      uploaded inside a private folder stays private.
      //   4. Otherwise default top-level uploads to 'private' so new content
      //      starts in the creator's private space (mirrors the Pages spec).
      const resolvedVisibility: 'private' | 'public' | undefined = ctx.workspaceId
        ? (knowledgeBaseVisibility ?? input.visibility ?? parentVisibility ?? 'private')
        : undefined;

      // The storage key comes from the client. Only accept a key this caller
      // already uses, or a fresh object nobody has claimed yet; otherwise a
      // caller could point a new row at another user's object and then read
      // it through the file proxy or delete it via removeFile.
      const storageKeyClaim = await ctx.fileModel.getStorageKeyClaim(input.url);
      if (storageKeyClaim === 'foreign') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'File URL belongs to another file' });
      }

      let actualSize = input.size;
      let objectMetadata: Awaited<ReturnType<FileService['getFileMetadata']>> | undefined;
      try {
        objectMetadata = await ctx.fileService.getFileMetadata(input.url);
        if (objectMetadata.contentLength >= 1) {
          actualSize = objectMetadata.contentLength;
        }
      } catch {
        // If metadata fetch fails, use original size from input
      }

      if (storageKeyClaim === 'unreferenced') {
        if (!objectMetadata) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Uploaded file not found' });
        }
        const lastModified = objectMetadata.lastModified?.getTime();
        if (lastModified && Date.now() - lastModified > UNCLAIMED_UPLOAD_MAX_AGE_MS) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'File URL is not a recent upload' });
        }
      }

      if (actualSize < 0) {
        await businessFileUploadCheck({
          actualSize,
          clientIp: ctx.clientIp ?? undefined,
          inputSize: input.size,
          url: input.url,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        });
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'File size cannot be negative' });
      }

      const { id } = await ctx.serverDB.transaction(async (trx) => {
        await businessFileUploadCheck({
          actualSize,
          clientIp: ctx.clientIp ?? undefined,
          inputSize: input.size,
          transaction: trx,
          url: input.url,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        });

        let shouldRefreshGlobalFile = false;
        // Only repoint the shared hash row for the caller's own bytes (or a
        // hash no file row uses any more), so one user cannot swap the object
        // that other users' dedup lookups resolve to.
        const mayRefreshGlobalFile =
          isExist &&
          ((await ctx.fileModel.hasOwnFileWithHash(input.hash!, trx)) ||
            !(await ctx.fileModel.hasAnyFileWithHash(input.hash!, trx)));
        if (mayRefreshGlobalFile && existingFile.url && existingFile.url !== input.url) {
          shouldRefreshGlobalFile = !(await isStoredObjectAvailable(
            ctx.fileService,
            existingFile.url,
          ));
        }

        if (shouldRefreshGlobalFile) {
          // A user may re-upload the same bytes after the old object key was
          // removed. Keep the global hash pointer on the newly uploaded object so
          // future dedup checks do not resolve back to the stale key.
          await ctx.fileModel.updateGlobalFile(
            input.hash!,
            {
              metadata: input.metadata,
              url: input.url,
            },
            trx,
          );
        }

        return ctx.fileModel.create(
          {
            fileHash: input.hash,
            fileType: input.fileType,
            knowledgeBaseId: input.knowledgeBaseId,
            metadata: input.metadata,
            name: input.name,
            parentId: resolvedParentId,
            size: actualSize,
            // Attribution the caller supplied (e.g. a page-editor paste). The
            // wire type is a loose string for older clients, so unknown values
            // are dropped rather than persisted — `source` drives the resource
            // library's origin filter and its hidden-source exclusion.
            source: toFileSource(input.source),
            url: input.url,
            ...(resolvedVisibility ? { visibility: resolvedVisibility } : {}),
          },
          // if the file is not exist in global file, create a new one
          !isExist,
          trx,
        );
      });

      return { id, url: await ctx.fileService.getFileAccessUrl({ id, url: input.url }) };
    }),
  findById: fileProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const item = await ctx.fileModel.findById(input.id);
      if (!item) throw new TRPCError({ code: 'BAD_REQUEST', message: 'File not found' });

      await assertFileNotInRestrictedKnowledgeBase(ctx, input.id);

      return {
        chunkTaskId: item.chunkTaskId,
        clientId: item.clientId,
        createdAt: item.createdAt,
        embeddingTaskId: item.embeddingTaskId,
        fileHash: item.fileHash,
        fileType: item.fileType,
        id: item.id,
        metadata: item.metadata,
        name: item.name,
        parentId: item.parentId,
        size: item.size,
        source: item.source,
        updatedAt: item.updatedAt,
        url: await ctx.fileService.getFileAccessUrl(item),
        userId: item.userId,
      };
    }),

  getFileItemById: fileProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .query(async ({ ctx, input }): Promise<FileListItem | undefined> => {
      const item = await ctx.fileModel.findById(input.id);

      if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'File not found' });

      await assertFileNotInRestrictedKnowledgeBase(ctx, input.id);

      const statusMap = await getKnowledgeItemStatusMap(ctx, [item]);
      const status = statusMap.get(item.id)!;

      return {
        createdAt: item.createdAt,
        chunkCount: status.chunkCount ?? null,
        chunkingError: status.chunkingError,
        chunkingStatus: status.chunkingStatus,
        embeddingError: status.embeddingError,
        embeddingStatus: status.embeddingStatus,
        fileType: item.fileType,
        finishEmbedding: status.finishEmbedding ?? false,
        id: item.id,
        metadata: item.metadata as Record<string, any> | null | undefined,
        name: item.name,
        size: item.size,
        sourceType: 'file' as const,
        updatedAt: item.updatedAt,
        url: await ctx.fileService.getFileAccessUrl(item),
        userId: item.userId,
        visibility: item.visibility,
      };
    }),

  getFiles: fileProcedure.input(QueryFileListSchema).query(async ({ ctx, input }) => {
    if (input.knowledgeBaseId) await assertKnowledgeBaseBrowsable(ctx, input.knowledgeBaseId);
    const excludeKnowledgeBaseIds =
      !input.knowledgeBaseId && input.showFilesInKnowledgeBase
        ? await getRestrictedKnowledgeBaseIds(ctx)
        : undefined;

    const fileList = await ctx.fileModel.query({ ...input, excludeKnowledgeBaseIds });
    const statusMap = await getKnowledgeItemStatusMap(ctx, fileList);

    const resultFiles = [] as any[];
    for (const item of fileList as any[]) {
      const status = statusMap.get(item.id)!;
      const fileItem = {
        ...item,
        sourceType: 'file' as const,
        url: await ctx.fileService.getFileAccessUrl(item),
        ...status,
      } as FileListItem;
      resultFiles.push(fileItem);
    }

    return resultFiles;
  }),

  getKnowledgeItemStatusesByIds: fileProcedure
    .input(
      z.object({
        ids: z.array(z.string()),
      }),
    )
    .query(async ({ ctx, input }): Promise<KnowledgeItemStatus[]> => {
      const ids = [...new Set(input.ids)];
      if (ids.length === 0) return [];

      const fileItems = await ctx.fileModel.findByIds(ids);
      const statusMap = await getKnowledgeItemStatusMap(ctx, fileItems);

      return ids.flatMap((id) => {
        const status = statusMap.get(id);
        return status ? [status] : [];
      });
    }),

  getKnowledgeItems: fileProcedure.input(QueryFileListSchema).query(async ({ ctx, input }) => {
    if (input.knowledgeBaseId) await assertKnowledgeBaseBrowsable(ctx, input.knowledgeBaseId);
    const excludeKnowledgeBaseIds = input.knowledgeBaseId
      ? undefined
      : await getRestrictedKnowledgeBaseIds(ctx);

    // Request one more item than limit to check if there are more items
    const limit = input.limit ?? 50;
    const knowledgeItems = await ctx.knowledgeRepo.query({
      ...input,
      excludeKnowledgeBaseIds,
      limit: limit + 1,
    });

    // Check if there are more items
    const hasMore = knowledgeItems.length > limit;

    // Take only the requested number of items
    const itemsToProcess = hasMore ? knowledgeItems.slice(0, limit) : knowledgeItems;

    // Filter out folders from Documents category when in Inbox (no knowledgeBaseId)
    const filteredItems = filterKnowledgeItems(itemsToProcess, input.knowledgeBaseId);

    // Process files (add chunk info and async task status)
    const fileItems = filteredItems.filter((item) => item.sourceType === 'file');
    const statusMap = await getKnowledgeItemStatusMap(ctx, fileItems);

    // Resolve file access URLs in parallel: in local dev each call goes through
    // Redis + a possible S3 presign, so a serial loop stacks up N RTTs on
    // larger result sets (visible when switching from Private to Workspace).
    const resultItems = await Promise.all(
      filteredItems.map(async (item) => {
        if (item.sourceType === 'file') {
          const status = statusMap.get(item.id)!;
          return {
            ...item,
            editorData: null,
            url: await ctx.fileService.getFileAccessUrl(item),
            ...status,
          } as FileListItem;
        }
        return {
          ...item,
          chunkCount: null,
          chunkingError: null,
          chunkingStatus: null,
          embeddingError: null,
          embeddingStatus: null,
          finishEmbedding: false,
        } as FileListItem;
      }),
    );

    return {
      hasMore,
      items: resultItems,
    };
  }),

  resolveKnowledgeItemIds: fileProcedure
    .input(QueryFileListSchema)
    .query(async ({ ctx, input }): Promise<{ ids: string[]; total: number }> => {
      if (input.knowledgeBaseId) await assertKnowledgeBaseBrowsable(ctx, input.knowledgeBaseId);
      const excludeKnowledgeBaseIds = input.knowledgeBaseId
        ? undefined
        : await getRestrictedKnowledgeBaseIds(ctx);

      const ids: string[] = [];
      const batchSize = 500;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const knowledgeItems = await ctx.knowledgeRepo.query({
          ...input,
          creatorUserId: isWorkspaceNonOwner(ctx) ? ctx.userId : undefined,
          excludeKnowledgeBaseIds,
          limit: batchSize + 1,
          offset,
        });

        const currentHasMore = knowledgeItems.length > batchSize;
        const itemsToProcess = currentHasMore ? knowledgeItems.slice(0, batchSize) : knowledgeItems;
        const filteredItems = filterKnowledgeItems(itemsToProcess, input.knowledgeBaseId);

        ids.push(...filteredItems.map((item) => item.id));

        offset += itemsToProcess.length;
        hasMore = currentHasMore;
      }

      return { ids, total: ids.length };
    }),

  deleteKnowledgeItemsByQuery: fileProcedure
    .use(withScopedPermission('file:delete'))
    .input(deleteKnowledgeItemsByQuerySchema)
    .mutation(async ({ ctx, input }): Promise<{ count: number }> => {
      // Members can sweep only rows they created. Workspace owners may clear
      // the entire query scope, including rows uploaded by other members.
      const restrictToCreator = isWorkspaceNonOwner(ctx);
      const { excludedIds = [], ...query } = input;
      const excludedIdSet = new Set(excludedIds);

      const fileIds: string[] = [];
      const documentIds: string[] = [];
      const batchSize = 500;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const knowledgeItems = await ctx.knowledgeRepo.query({
          ...query,
          creatorUserId: restrictToCreator ? ctx.userId : undefined,
          limit: batchSize + 1,
          offset,
        });

        const currentHasMore = knowledgeItems.length > batchSize;
        const itemsToProcess = currentHasMore ? knowledgeItems.slice(0, batchSize) : knowledgeItems;
        const filteredItems = filterKnowledgeItems(itemsToProcess, query.knowledgeBaseId).filter(
          (item) => !excludedIdSet.has(item.id),
        );

        for (const item of filteredItems) {
          if (item.sourceType === DERIVED_DOCUMENT_SOURCE_TYPE) {
            documentIds.push(item.documentId ?? item.id);
            continue;
          }

          if (item.documentId) {
            documentIds.push(item.documentId);
            continue;
          }

          fileIds.push(item.fileId ?? item.id);
        }

        offset += itemsToProcess.length;
        hasMore = currentHasMore;
      }

      if (documentIds.length > 0) {
        // Per-document delete guard, mirroring `document.deleteDocuments` — a
        // query-driven sweep must not delete shared docs the member can't delete.
        if (ctx.workspaceId) {
          await Promise.all(
            documentIds.map((id) =>
              assertCanPerformResourceAction({
                action: 'delete',
                db: ctx.serverDB,
                resourceId: id,
                resourceType: 'document',
                userId: ctx.userId,
                workspaceId: ctx.workspaceId!,
              }),
            ),
          );
        }
        await ctx.documentService.deleteDocuments(documentIds, { restrictToCreator });
      }

      if (fileIds.length > 0) {
        const needToRemoveFileList = await ctx.fileModel.deleteMany(
          fileIds,
          serverDBEnv.REMOVE_GLOBAL_FILE,
          { restrictToCreator },
        );

        if (needToRemoveFileList && needToRemoveFileList.length > 0) {
          await ctx.fileService.deleteStorageForRemovedFiles(needToRemoveFileList);
        }
      }

      return { count: fileIds.length + documentIds.length };
    }),

  recentFiles: fileProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 12;
      // Files only (pages are excluded in SQL, so `limit` can't be eaten by
      // page rows that are then filtered out).
      const fileItems = await ctx.knowledgeRepo.queryRecent(limit, 'file');

      if (fileItems.length === 0) return [];

      // Get file IDs for batch processing
      const fileIds = fileItems.map((item) => item.id);
      const chunksArray = await ctx.chunkModel.countByFileIds(fileIds);
      const chunks: Record<string, number> = {};
      for (const item of chunksArray) {
        if (item.id) chunks[item.id] = item.count;
      }

      const chunkTaskIds = fileItems.map((item) => item.chunkTaskId).filter(Boolean) as string[];
      const embeddingTaskIds = fileItems
        .map((item) => item.embeddingTaskId)
        .filter(Boolean) as string[];

      const [chunkTasks, embeddingTasks] = await Promise.all([
        chunkTaskIds.length > 0
          ? ctx.asyncTaskModel.findByIds(chunkTaskIds, AsyncTaskType.Chunking)
          : Promise.resolve([]),
        embeddingTaskIds.length > 0
          ? ctx.asyncTaskModel.findByIds(embeddingTaskIds, AsyncTaskType.Embedding)
          : Promise.resolve([]),
      ]);

      // Build result with task status
      const resultFiles: FileListItem[] = [];
      for (const item of fileItems) {
        const chunkTask = item.chunkTaskId
          ? chunkTasks.find((task) => task.id === item.chunkTaskId)
          : null;
        const embeddingTask = item.embeddingTaskId
          ? embeddingTasks.find((task) => task.id === item.embeddingTaskId)
          : null;

        resultFiles.push({
          ...item,
          chunkCount: chunks[item.id] ?? 0,
          chunkingError: chunkTask?.error ?? null,
          chunkingStatus: chunkTask?.status as AsyncTaskStatus,
          embeddingError: embeddingTask?.error ?? null,
          embeddingStatus: embeddingTask?.status as AsyncTaskStatus,
          finishEmbedding: embeddingTask?.status === AsyncTaskStatus.Success,
          sourceType: 'file' as const,
          url: await ctx.fileService.getFileAccessUrl(item),
        } as FileListItem);
      }

      return resultFiles;
    }),

  recentPages: fileProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 12;
      // Pages only (folders and files are excluded in SQL, so `limit` can't be
      // eaten by rows that are then filtered out).
      return ctx.knowledgeRepo.queryRecent(limit, 'page');
    }),

  removeFile: fileProcedure
    .use(withScopedPermission('file:delete'))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await ctx.fileModel.findById(input.id);
      if (!existing) return;
      assertWorkspaceRowManageable(ctx, existing.userId, 'file');

      const file = await ctx.fileModel.delete(input.id, serverDBEnv.REMOVE_GLOBAL_FILE);

      if (!file) return;

      // delete the file from S3 if no other row (any user) still uses it
      await ctx.fileService.deleteStorageForRemovedFiles([file]);
    }),

  removeUnreferencedFile: fileProcedure
    .use(withScopedPermission('file:delete'))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await ctx.fileModel.findById(input.id);
      if (!existing) return;
      assertWorkspaceRowManageable(ctx, existing.userId, 'file');

      const file = await ctx.fileModel.deleteUnreferenced(input.id, serverDBEnv.REMOVE_GLOBAL_FILE);
      if (!file) return;

      await ctx.fileService.deleteStorageForRemovedFiles([file]);
    }),

  removeFileAsyncTask: fileProcedure
    .use(withScopedPermission('file:update'))
    .input(
      z.object({
        id: z.string(),
        type: z.enum(['embedding', 'chunk']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const file = await ctx.fileModel.findById(input.id);

      if (!file) return;
      assertWorkspaceRowManageable(ctx, file.userId, 'file');

      const taskId = input.type === 'embedding' ? file.embeddingTaskId : file.chunkTaskId;

      if (!taskId) return;

      await ctx.asyncTaskModel.delete(taskId);
    }),

  removeFiles: fileProcedure
    .use(withScopedPermission('file:delete'))
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const targets = await ctx.fileModel.findByIds(input.ids);
      for (const target of targets) {
        assertWorkspaceRowManageable(ctx, target.userId, 'file');
      }

      const needToRemoveFileList = await ctx.fileModel.deleteMany(
        input.ids,
        serverDBEnv.REMOVE_GLOBAL_FILE,
      );

      if (!needToRemoveFileList || needToRemoveFileList.length === 0) return;

      // remove from S3
      await ctx.fileService.deleteStorageForRemovedFiles(needToRemoveFileList);
    }),

  updateFile: fileProcedure
    .use(withScopedPermission('file:update'))
    .input(
      z.object({
        id: z.string(),
        metadata: z.record(z.string(), z.any()).optional(),
        name: z.string().optional(),
        parentId: z.string().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, metadata, name, parentId } = input;

      const existing = await ctx.fileModel.findById(id);
      if (!existing) return { success: true };
      assertWorkspaceRowManageable(ctx, existing.userId, 'file');

      // Resolve parentId if it's a slug (otherwise use as-is)
      let resolvedParentId: string | null | undefined = parentId;
      if (parentId) {
        const docBySlug = await ctx.documentModel.findBySlug(parentId);
        if (docBySlug) {
          resolvedParentId = docBySlug.id;
        }
        await assertValidParentDocument(ctx.documentModel, resolvedParentId);
      }

      const updates: Parameters<typeof ctx.fileModel.update>[1] = {};

      if (metadata !== undefined) {
        updates.metadata = metadata;
      }

      if (name !== undefined) {
        updates.name = name;
      }

      if (parentId !== undefined) {
        updates.parentId = resolvedParentId;
      }

      if (Object.keys(updates).length > 0) {
        await ctx.fileModel.update(id, updates);
      }

      return { success: true };
    }),

  publishFileToWorkspace: fileProcedure
    .use(withScopedPermission('file:update'))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Personal mode has no notion of workspace visibility — publish is only
      // meaningful inside a team workspace.
      if (!ctx.workspaceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot publish a file outside of a workspace',
        });
      }

      const file = await ctx.fileModel.findById(input.id);
      if (!file) throw new TRPCError({ code: 'NOT_FOUND', message: 'File not found' });

      if (file.userId !== ctx.userId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the creator can publish a private file to the workspace',
        });
      }

      if (file.visibility === 'public') return { success: true };

      await ctx.fileModel.publishToWorkspace(input.id);
      return { success: true };
    }),

  /**
   * Toggle a file's workspace visibility. Creator-only. Personal mode has no
   * workspace visibility concept, so the call is rejected there.
   */
  setFileVisibility: fileProcedure
    .use(withScopedPermission('file:update'))
    .input(
      z.object({
        id: z.string(),
        visibility: z.enum(['private', 'public']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.workspaceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'File visibility only applies inside a workspace',
        });
      }

      const file = await ctx.fileModel.findById(input.id);
      if (!file) throw new TRPCError({ code: 'NOT_FOUND', message: 'File not found' });

      if (file.userId !== ctx.userId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the creator can change a file’s visibility',
        });
      }

      if (file.visibility === input.visibility) return { success: true };

      await ctx.fileModel.setVisibility(input.id, input.visibility);
      return { success: true };
    }),

  transferEntity: fileProcedure
    .use(withScopedPermission('file:upload'))
    .input(
      z.object({
        entityType: fileTransferEntityTypeSchema,
        id: z.string(),
        targetVisibility: z.enum(['private', 'public']).optional(),
        targetWorkspaceId: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.targetWorkspaceId === (ctx.workspaceId ?? null)) {
        throw new TRPCError({
          cause: { data: { code: TransferErrorCode.SameWorkspace } },
          code: 'BAD_REQUEST',
          message: 'Cannot transfer to the same workspace',
        });
      }

      if (input.targetWorkspaceId) {
        const canWriteTarget = await hasWorkspaceScopedPermission({
          action: 'FILE_UPLOAD',
          db: ctx.serverDB,
          userId: ctx.userId,
          workspaceId: input.targetWorkspaceId,
        });
        if (!canWriteTarget) {
          throw new TRPCError({
            cause: { data: { code: TransferErrorCode.TargetNoWriteAccess } },
            code: 'FORBIDDEN',
            message: 'No write access to target workspace',
          });
        }
      }

      if (input.entityType === 'folder' || input.entityType === 'document') {
        const document = await ctx.documentModel.findById(input.id);
        if (!document) {
          throw new TRPCError({
            cause: { data: { code: TransferErrorCode.ResourceNotFound } },
            code: 'NOT_FOUND',
            message: input.entityType === 'folder' ? 'Folder not found' : 'Document not found',
          });
        }
        // Transfer stays creator-only, mirroring `document.transferDocument`.
        if (ctx.workspaceId) {
          await assertCanPerformResourceAction({
            action: 'transfer',
            db: ctx.serverDB,
            resourceId: input.id,
            resourceType: 'document',
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
          });
        }
        // The transfer rehomes the entire subtree — a non-owner member must
        // not move teammates' documents/files along with their own folder.
        if (isWorkspaceNonOwner(ctx) && (await ctx.documentModel.subtreeHasForeignRows(input.id))) {
          throw new TRPCError({
            cause: { data: { code: TransferErrorCode.OwnerOnly } },
            code: 'FORBIDDEN',
            message: "Only workspace owners can transfer a folder containing others' content",
          });
        }
        const additionalSize = await ctx.documentModel.countFileUsageInSubtree(input.id);
        await businessFileTransferStorageCheck({
          additionalSize,
          targetUserId: ctx.userId,
          targetWorkspaceId: input.targetWorkspaceId,
        });
        return ctx.documentModel.transferTo(
          input.id,
          input.targetWorkspaceId,
          ctx.userId,
          input.targetVisibility,
        );
      }

      const file = await ctx.fileModel.findById(input.id);
      if (!file)
        throw new TRPCError({
          cause: { data: { code: TransferErrorCode.ResourceNotFound } },
          code: 'NOT_FOUND',
          message: 'File not found',
        });
      assertWorkspaceRowManageable(ctx, file.userId, 'file');
      await businessFileTransferStorageCheck({
        additionalSize: file.size,
        targetUserId: ctx.userId,
        targetWorkspaceId: input.targetWorkspaceId,
      });
      return ctx.fileModel.transferTo(
        input.id,
        input.targetWorkspaceId,
        ctx.userId,
        input.targetVisibility,
      );
    }),

  copyEntityToWorkspace: fileProcedure
    .use(withScopedPermission('file:upload'))
    .input(
      z.object({
        entityType: fileTransferEntityTypeSchema,
        id: z.string(),
        targetVisibility: z.enum(['private', 'public']).optional(),
        targetWorkspaceId: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.targetWorkspaceId) {
        const canWriteTarget = await hasWorkspaceScopedPermission({
          action: 'FILE_UPLOAD',
          db: ctx.serverDB,
          userId: ctx.userId,
          workspaceId: input.targetWorkspaceId,
        });
        if (!canWriteTarget) {
          throw new TRPCError({
            cause: { data: { code: TransferErrorCode.TargetNoWriteAccess } },
            code: 'FORBIDDEN',
            message: 'No write access to target workspace',
          });
        }
      }

      if (input.entityType === 'folder' || input.entityType === 'document') {
        const document = await ctx.documentModel.findById(input.id);
        if (!document) {
          throw new TRPCError({
            cause: { data: { code: TransferErrorCode.ResourceNotFound } },
            code: 'NOT_FOUND',
            message: input.entityType === 'folder' ? 'Folder not found' : 'Document not found',
          });
        }
        const additionalSize = await ctx.documentModel.countFileUsageInSubtree(input.id);
        await businessFileTransferStorageCheck({
          additionalSize,
          targetUserId: ctx.userId,
          targetWorkspaceId: input.targetWorkspaceId,
        });
        return ctx.documentModel.copyToWorkspace(
          input.id,
          input.targetWorkspaceId,
          ctx.userId,
          input.targetVisibility,
        );
      }

      const file = await ctx.fileModel.findById(input.id);
      if (!file)
        throw new TRPCError({
          cause: { data: { code: TransferErrorCode.ResourceNotFound } },
          code: 'NOT_FOUND',
          message: 'File not found',
        });
      await businessFileTransferStorageCheck({
        additionalSize: file.size,
        targetUserId: ctx.userId,
        targetWorkspaceId: input.targetWorkspaceId,
      });
      return ctx.fileModel.copyToWorkspace(
        input.id,
        input.targetWorkspaceId,
        ctx.userId,
        input.targetVisibility,
      );
    }),
});

export type FileRouter = typeof fileRouter;
