import { TRPCError } from '@trpc/server';

import { fileEnv } from '@/envs/file';

/**
 * Storage keys a client may ask the server to sign for upload.
 *
 * Clients build keys themselves (`src/services/upload.ts` →
 * `generateFilePathMetadata`, and `src/services/import`), and older desktop
 * builds ship that code, so the server cannot simply pick the key. Instead it
 * only signs keys with the exact shape those clients produce:
 *
 *   <root>/<0-3 plain segments>/<uuid v4>.<extension>
 *
 * where `<root>` is one of the upload directories the app uses. This keeps
 * uploads out of arbitrary prefixes (server-generated assets, other users'
 * folders) and, together with {@link assertUploadKeyIsFree}, stops a caller
 * from overwriting an object whose key it learned elsewhere.
 */
const UUID_PREFIX = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\./i;
const PLAIN_SEGMENT = /^[\w-]{1,64}$/;
// The extension is `originalName.split('.').at(-1)`, so it can be anything
// except a path separator or a control character.
// eslint-disable-next-line no-control-regex
const EXTENSION = /^[^/\\\u0000-\u001F\u007F]{0,128}$/;
const MAX_KEY_LENGTH = 512;
const MAX_MIDDLE_SEGMENTS = 3;

const STATIC_UPLOAD_ROOTS = ['skills', 'ragEval', 'eval-datasets', 'import_config'];

const getUploadRoots = (): string[] => {
  const roots = new Set(STATIC_UPLOAD_ROOTS);
  const filePath = fileEnv.NEXT_PUBLIC_S3_FILE_PATH?.replaceAll(/^\/+|\/+$/g, '');
  if (filePath) roots.add(filePath);
  return [...roots];
};

export const isSafeUploadKey = (key: string): boolean => {
  if (!key || key.length > MAX_KEY_LENGTH) return false;
  if (key.includes('\\') || key.includes('//') || key.startsWith('/')) return false;

  const root = getUploadRoots().find((item) => key.startsWith(`${item}/`));
  if (!root) return false;

  const segments = key.slice(root.length + 1).split('/');
  const filename = segments.pop();
  if (!filename || segments.length > MAX_MIDDLE_SEGMENTS) return false;
  if (!segments.every((segment) => PLAIN_SEGMENT.test(segment))) return false;

  if (!UUID_PREFIX.test(filename)) return false;
  return EXTENSION.test(filename.slice(37));
};

export const assertSafeUploadKey = (key: string) => {
  if (!isSafeUploadKey(key)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid upload path' });
  }
};

interface ObjectMetadataReader {
  getFileMetadata: (key: string) => Promise<{ lastModified?: Date }>;
}

/**
 * Refuse to sign an upload onto a key that already holds an object.
 *
 * A successful HEAD means the object exists. Any failure (404, or the 403 some
 * S3 providers return for a missing key without ListBucket) is treated as free:
 * an existing object the server can read always answers HEAD with 200, so this
 * never lets an overwrite through, and a storage hiccup does not block uploads.
 */
export const assertUploadKeyIsFree = async (storage: ObjectMetadataReader, key: string) => {
  const exists = await storage.getFileMetadata(key).then(
    () => true,
    () => false,
  );

  if (exists) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Upload path is already in use' });
  }
};
