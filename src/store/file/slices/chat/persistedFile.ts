/**
 * The agent config returns raw `files` rows, whose mime column is `fileType`; the
 * `FileItem.type` typing does not hold there. Read the mime from either field and
 * never return undefined, so consumers can call string methods on it safely.
 */
export const resolvePersistedFileMime = (file: {
  fileType?: string | null;
  type?: string | null;
}): string => file.type || file.fileType || '';
