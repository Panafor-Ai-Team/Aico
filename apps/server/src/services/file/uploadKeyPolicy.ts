import { TRPCError } from '@trpc/server';

import { fileEnv } from '@/envs/file';

/**
 * Storage keys a client may ask the server to sign for upload.
 *
 * Clients build keys themselves (`src/services/upload.ts` →
 * `generateFilePathMetadata`, `src/services/import`, the CLI's
 * `uploadLocalFile`, and the desktop agents' `fileStoreImageUploader`), and
 * older desktop / CLI builds ship that code, so the server cannot simply pick
 * the key. Instead it only signs keys with the exact shapes those clients
 * produce:
 *
 *   <root>/<0-3 plain segments>/<uuid v4>.<extension>     (web, import)
 *   <root>/<0-3 plain segments>/<sha256 hex>[.<extension>] (CLI, desktop agents)
 *
 * where `<root>` is one of the upload directories the app uses. This keeps
 * uploads out of arbitrary prefixes (server-generated assets, other users'
 * folders) and, together with {@link assertUploadKeyIsFree}, stops a caller
 * from overwriting an object whose key it learned elsewhere.
 */
const UUID_FILENAME =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.(?<extension>.*)$/i;
// The CLI and desktop agents name an upload after the sha256 of its bytes; the
// CLI drops the dot when the local file has no extension.
const SHA256_FILENAME = /^[\da-f]{64}(?:\.(?<extension>.*))?$/i;
const PLAIN_SEGMENT = /^[\w-]{1,64}$/;
// The extension is `originalName.split('.').at(-1)`, so it can be anything
// except a path separator or a control character.
// eslint-disable-next-line no-control-regex
const EXTENSION = /^[^/\\\u0000-\u001F\u007F]{0,128}$/;
const MAX_KEY_LENGTH = 512;
const MAX_MIDDLE_SEGMENTS = 3;

// `files` is listed even when NEXT_PUBLIC_S3_FILE_PATH names another folder:
// the CLI and desktop agents hard-code it.
const STATIC_UPLOAD_ROOTS = ['files', 'skills', 'ragEval', 'eval-datasets', 'import_config'];

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

  const match = UUID_FILENAME.exec(filename) ?? SHA256_FILENAME.exec(filename);
  if (!match) return false;
  return EXTENSION.test(match.groups?.extension ?? '');
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
