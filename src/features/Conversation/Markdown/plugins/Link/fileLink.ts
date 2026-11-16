export interface FileProxyLinkReference {
  fileId: string;
}

const FILE_PROXY_PATH = /^\/f\/([^/]+)\/?$/;

/**
 * Parse a link to this deployment's file proxy (`/f/:id`).
 *
 * Only same-origin links (root-relative, or absolute on `currentOrigin`) count:
 * the id must belong to this deployment's file table. `?download` links stay
 * plain links, because the author asked for a download.
 */
export const parseFileProxyLink = (
  href: string | undefined,
  currentOrigin?: string,
): FileProxyLinkReference | null => {
  if (!href) return null;

  const isRootRelative = href.startsWith('/') && !href.startsWith('//');
  if (!isRootRelative && !currentOrigin) return null;

  let url: URL;
  try {
    url = new URL(href, currentOrigin || 'http://localhost');
    if (!isRootRelative && url.origin !== new URL(currentOrigin!).origin) return null;
  } catch {
    return null;
  }

  if (url.searchParams.has('download')) return null;

  const match = url.pathname.match(FILE_PROXY_PATH);
  if (!match) return null;

  try {
    const fileId = decodeURIComponent(match[1]);
    return fileId ? { fileId } : null;
  } catch {
    return null;
  }
};
