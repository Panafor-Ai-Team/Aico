import type { LobeChatDatabase } from '@lobechat/database';
import { resolveMimeTypeFromBytes } from '@lobechat/utils';
import debug from 'debug';
import { and, eq } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { files } from '@/database/schemas';
import { AicoManagedPolicy } from '@/server/services/aico/managedPolicy';
import type { FileService } from '@/server/services/file';

const log = debug('lobe-video:inline-image');

/**
 * Video runtimes that take a base64 data URL wherever they take an image URL:
 * CheapVibeCode (xAI `image.url`) and OpenRouter (`image_url.url`).
 */
const DATA_URL_IMAGE_RUNTIMES = new Set(['cheapvibecode', 'openrouter']);

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

export interface InlineImageContext {
  db: LobeChatDatabase;
  fileService: Pick<FileService, 'getFileByteArray' | 'getKeyFromFullUrl'>;
  userId: string;
  workspaceId?: string;
}

export const acceptsInlineVideoImages = (provider: string) =>
  DATA_URL_IMAGE_RUNTIMES.has(AicoManagedPolicy.resolveRuntimeProvider(provider));

/** Storage key of an uploaded file the caller owns, from a `/f/{id}` proxy or storage URL. */
const findOwnedFileKey = async (url: string, ctx: InlineImageContext) => {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return;
  }

  if (pathname.startsWith('/f/')) {
    const file = await new FileModel(ctx.db, ctx.userId, ctx.workspaceId).findById(
      pathname.slice(3),
    );
    return file?.url;
  }

  const key = await ctx.fileService.getKeyFromFullUrl(url);
  if (!key) return;

  const file = await ctx.db.query.files.findFirst({
    where: and(eq(files.url, key), eq(files.userId, ctx.userId)),
  });
  return file?.url;
};

/**
 * The caller's uploaded image as a data URL, read straight from storage.
 * Providers fetch image URLs from their own network, where the app / S3 host
 * may be unreachable (xAI: `image_download_error=image_fetch_failed`).
 * Returns `undefined` to keep the URL for anything not owned, not an image or too large.
 */
export const inlineOwnedImage = async (
  url: string,
  ctx: InlineImageContext,
): Promise<string | undefined> => {
  if (url.startsWith('data:')) return;

  try {
    const key = await findOwnedFileKey(url, ctx);
    if (!key) return;

    const bytes = await ctx.fileService.getFileByteArray(key);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) return;

    const mimeType = await resolveMimeTypeFromBytes(undefined, bytes);
    if (!mimeType.startsWith('image/')) return;

    return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch (error) {
    log('Keeping image URL, inlining failed for %s: %O', url, error);
    return;
  }
};
