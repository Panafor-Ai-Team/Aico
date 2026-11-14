import { createStaticStyles, cx } from 'antd-style';
import type { ReactNode, RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

import { useFileStore } from '@/store/file';

import { styles } from './styles';
import { useExplorerDropZone } from './useExplorerDropZone';

interface ListViewDropZoneProps {
  children: ReactNode;
  currentFolderId: string | null;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}

const localStyles = createStaticStyles(({ css }) => ({
  container: css`
    position: relative;
    overflow: hidden;
  `,
}));

const ListViewDropZone = ({ children, currentFolderId, virtuosoRef }: ListViewDropZoneProps) => {
  const { containerRef, handleDragLeave, handleDragOver, handleDrop, isDropZoneActive } =
    useExplorerDropZone(virtuosoRef);
  // Dragged rows record their folder by the slug the explorer queries with;
  // expose it too so the drop handler can tell a drop on the same folder.
  const currentFolderSlug = useFileStore((s) => s.queryParams?.parentId ?? undefined);

  return (
    <div
      data-drop-target-id={currentFolderId || undefined}
      data-drop-target-slug={currentFolderSlug || undefined}
      data-is-folder="true"
      ref={containerRef}
      className={cx(
        localStyles.container,
        'list-view-drop-zone',
        styles.dropZone,
        isDropZoneActive && styles.dropZoneActive,
      )}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
};

export default ListViewDropZone;
