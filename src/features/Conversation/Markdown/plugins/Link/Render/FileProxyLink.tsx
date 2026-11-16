'use client';

import { isDesktop } from '@lobechat/const';
import { RENDERER_HANDLED_LINK_ATTR } from '@lobechat/desktop-bridge';
import { Icon } from '@lobehub/ui';
import { FileTextIcon } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { memo, useCallback } from 'react';

import { isMarkdownFile } from '@/features/FileViewer/fileType';
import { useChatStore } from '@/store/chat';
import { useFileStore } from '@/store/file';

import { internalLinkStyles } from './InternalEntityLink';

interface FileProxyLinkProps {
  /** Rendered unchanged when the file is not Markdown or cannot be resolved. */
  fallback: ReactNode;
  fileId: string;
  href: string;
  label: string;
}

/**
 * A `/f/:id` link in a message. The proxy redirects to the raw storage object,
 * which the browser downloads (`application/octet-stream`) or shows as plain
 * text. For Markdown files the link opens the in-app file preview instead,
 * which renders the Markdown. Other file types keep the plain link.
 */
export const FileProxyLink = memo<FileProxyLinkProps>(({ fallback, fileId, href, label }) => {
  const useFetchKnowledgeItem = useFileStore((s) => s.useFetchKnowledgeItem);
  const openFilePreview = useChatStore((s) => s.openFilePreview);
  const { data: file } = useFetchKnowledgeItem(fileId);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0) return;

      // On the web a modifier-click means "open in a new tab": keep the raw link.
      const modifierClick = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (!isDesktop && modifierClick) return;

      event.preventDefault();
      openFilePreview({ fileId });
    },
    [fileId, openFilePreview],
  );

  if (!file || !isMarkdownFile({ fileName: file.name, fileType: file.fileType })) {
    return fallback;
  }

  return (
    <a
      {...{ [RENDERER_HANDLED_LINK_ATTR]: 'true' }}
      className={internalLinkStyles.link}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      onClick={handleClick}
    >
      <Icon icon={FileTextIcon} size={14} />
      {label}
    </a>
  );
});

FileProxyLink.displayName = 'FileProxyLink';
