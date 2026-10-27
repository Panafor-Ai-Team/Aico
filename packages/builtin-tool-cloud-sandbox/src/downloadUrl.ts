/**
 * `/f/:id` is the app's file proxy. With `?download` it redirects to a
 * presigned GET that carries `Content-Disposition: attachment`, so following
 * the link saves the file instead of opening it.
 */
const FILE_PROXY_PATH = /^\/f\/[^/]+\/?$/;

export const FILE_DOWNLOAD_QUERY_PARAM = 'download';

export const isFileProxyUrl = (url: string): boolean => {
  try {
    return FILE_PROXY_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/**
 * Turn a file proxy URL into its direct-download form. Any other URL (e.g. a
 * raw presigned storage URL in local dev) is returned unchanged: an extra query
 * param would break its signature.
 */
export const toFileDownloadUrl = (url: string): string => {
  if (!isFileProxyUrl(url)) return url;

  const parsed = new URL(url);
  if (parsed.searchParams.has(FILE_DOWNLOAD_QUERY_PARAM)) return url;

  parsed.searchParams.set(FILE_DOWNLOAD_QUERY_PARAM, '1');
  return parsed.toString();
};
