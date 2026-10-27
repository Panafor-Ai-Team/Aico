import { isFileProxyUrl, toFileDownloadUrl } from '../../../downloadUrl';

const clickAnchor = (href: string, filename: string) => {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
};

/**
 * Save an exported sandbox file without leaving the page.
 *
 * File proxy URLs (`/f/:id`) get `?download`, which the server answers with
 * `Content-Disposition: attachment`; the browser downloads the response and
 * stays on the current page, with no cross-origin fetch involved.
 * Other URLs (raw presigned storage URLs in local dev) keep the blob path,
 * falling back to a new tab when the storage host blocks the fetch.
 */
export const triggerFileDownload = async (url: string, filename: string): Promise<void> => {
  if (isFileProxyUrl(url)) {
    clickAnchor(toFileDownloadUrl(url), filename);
    return;
  }

  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    clickAnchor(blobUrl, filename);
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, '_blank');
  }
};
