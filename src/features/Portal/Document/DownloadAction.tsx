'use client';

import { DESKTOP_HEADER_ICON_SMALL_SIZE, isDesktop } from '@lobechat/const';
import { exportFile } from '@lobechat/utils/client';
import { ActionIcon } from '@lobehub/ui';
import { toast } from '@lobehub/ui/base-ui';
import { DownloadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useClientDataSWR } from '@/libs/swr';
import { portalKeys } from '@/libs/swr/keys';
import { documentService } from '@/services/document';
import { useDocumentStore } from '@/store/document';

import { getDocumentDownload } from './documentDownload';
import { useResolvedDocumentId } from './documentViewContext';

/**
 * Downloads the open document in its original format (see `getDocumentDownload`).
 *
 * Live Markdown comes from the document store, not `useEditor()`: that hook
 * creates a new, empty editor per component, not the body's editor.
 */
const DownloadAction = () => {
  const { t } = useTranslation(['common', 'file']);
  const documentId = useResolvedDocumentId();
  const [downloading, setDownloading] = useState(false);

  const { data: document } = useClientDataSWR(
    documentId ? portalKeys.documentHeader(documentId) : null,
    () => documentService.getDocumentById(documentId!),
  );

  if (!documentId || !document) return null;

  const handleDownload = async () => {
    const { content, extension, filename, mimeType } = getDocumentDownload(
      document,
      useDocumentStore.getState().documents[documentId]?.content,
    );

    setDownloading(true);
    try {
      if (isDesktop) {
        const { desktopExportService } = await import('@/services/electron/desktopExportService');
        await desktopExportService.exportMarkdown({
          content,
          fileName: filename,
          filters: [{ extensions: [extension], name: extension.toUpperCase() }],
        });
      } else {
        exportFile(content, filename, mimeType);
      }
    } catch (error) {
      console.error('[DocumentDownload] failed:', error);
      toast.error(t('pageEditor.exportError', { ns: 'file' }));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <ActionIcon
      icon={DownloadIcon}
      loading={downloading}
      size={DESKTOP_HEADER_ICON_SMALL_SIZE}
      title={t('download')}
      onClick={handleDownload}
    />
  );
};

export default DownloadAction;
