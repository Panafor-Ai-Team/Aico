'use client';

import { CaretDownFilled } from '@ant-design/icons';
import { ActionIcon, Flexbox, Icon } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { FolderIcon, FolderOpenIcon } from 'lucide-react';
import * as m from 'motion/react-m';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css, cssVar }) => ({
  folderHeader: css`
    cursor: pointer;

    padding-block: 4px;
    padding-inline: 8px;

    color: ${cssVar.colorTextSecondary};

    transition: background-color 0.2s;

    &:hover {
      background-color: ${cssVar.colorFillTertiary};
    }
  `,
  folderHeaderActive: css`
    color: ${cssVar.colorText};
    background-color: ${cssVar.colorFillSecondary};
  `,
}));

export interface FolderTreeItem {
  children?: FolderTreeItem[];
  id: string;
  name: string;
  slug?: string | null;
}

interface FolderTreeItemProps {
  expandedFolders: Set<string>;
  item: FolderTreeItem;
  level?: number;
  loadedFolders: Set<string>;
  onFolderClick?: (folderId: string, folderSlug?: string | null) => void;
  onLoadFolder: (folderId: string) => Promise<void>;
  onToggleFolder: (folderId: string) => void;
  selectedKey?: string | null;
}

// Recursive component to render folder tree
export const FolderTreeItemComponent = memo<FolderTreeItemProps>(
  ({
    item,
    level = 0,
    expandedFolders,
    loadedFolders,
    onToggleFolder,
    onLoadFolder,
    selectedKey,
    onFolderClick,
  }) => {
    const itemKey = item.slug || item.id;
    // A newly created subfolder expands its parent by id, other paths by slug.
    const isExpanded = expandedFolders.has(itemKey) || expandedFolders.has(item.id);
    const { i18n } = useTranslation();
    // A collapsed caret points along the reading direction (left in RTL).
    const collapsedRotate = i18n.dir() === 'rtl' ? 90 : -90;
    // Compare selectedKey with item.id since selectedKey is always the ID
    const isActive = selectedKey === item.id;

    const handleToggle = useCallback(async () => {
      // Toggle folder expansion
      onToggleFolder(itemKey);

      // Load children if not already loaded
      if (!isExpanded && !loadedFolders.has(itemKey)) {
        await onLoadFolder(itemKey);
      }
    }, [itemKey, isExpanded, loadedFolders, onToggleFolder, onLoadFolder]);

    const handleClick = useCallback(() => {
      if (onFolderClick) {
        // Pass both id and slug so the caller can use the id
        onFolderClick(item.id, item.slug);
      }
    }, [item.id, item.slug, onFolderClick]);

    return (
      <Flexbox gap={2}>
        <Flexbox
          horizontal
          align={'center'}
          className={cx(styles.folderHeader, isActive && styles.folderHeaderActive)}
          style={{ paddingInlineStart: level * 16 + 8 }}
          onClick={handleClick}
        >
          <m.div
            animate={{ rotate: isExpanded ? 0 : collapsedRotate }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
          >
            <ActionIcon
              icon={CaretDownFilled as any}
              size={'small'}
              onClick={(e) => {
                e.stopPropagation();
                handleToggle();
              }}
            />
          </m.div>
          <Flexbox
            horizontal
            align={'center'}
            flex={1}
            gap={8}
            style={{ minHeight: 28, minWidth: 0 }}
          >
            <Icon icon={isExpanded ? FolderOpenIcon : FolderIcon} size={16} />
            <span
              style={{
                flex: 1,
                fontSize: 14,
                lineHeight: '20px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.name}
            </span>
          </Flexbox>
        </Flexbox>

        {isExpanded && item.children && item.children.length > 0 && (
          <m.div
            animate={{ height: 'auto', opacity: 1 }}
            initial={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden' }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
          >
            <Flexbox gap={2}>
              {item.children.map((child) => (
                <FolderTreeItemComponent
                  expandedFolders={expandedFolders}
                  item={child}
                  key={child.id}
                  level={level + 1}
                  loadedFolders={loadedFolders}
                  selectedKey={selectedKey}
                  onFolderClick={onFolderClick}
                  onLoadFolder={onLoadFolder}
                  onToggleFolder={onToggleFolder}
                />
              ))}
            </Flexbox>
          </m.div>
        )}
      </Flexbox>
    );
  },
);

FolderTreeItemComponent.displayName = 'FolderTreeItemComponent';

interface FolderTreeProps {
  expandedFolders: Set<string>;
  items: FolderTreeItem[];
  loadedFolders: Set<string>;
  onFolderClick?: (folderId: string, folderSlug?: string | null) => void;
  onLoadFolder: (folderId: string) => Promise<void>;
  onToggleFolder: (folderId: string) => void;
  selectedKey?: string | null;
}

const FolderTree = memo<FolderTreeProps>(
  ({
    items,
    expandedFolders,
    loadedFolders,
    onToggleFolder,
    onLoadFolder,
    selectedKey,
    onFolderClick,
  }) => {
    return (
      <Flexbox gap={2}>
        {items.map((item) => (
          <FolderTreeItemComponent
            expandedFolders={expandedFolders}
            item={item}
            key={item.id}
            loadedFolders={loadedFolders}
            selectedKey={selectedKey}
            onFolderClick={onFolderClick}
            onLoadFolder={onLoadFolder}
            onToggleFolder={onToggleFolder}
          />
        ))}
      </Flexbox>
    );
  },
);

FolderTree.displayName = 'FolderTree';

export default FolderTree;
