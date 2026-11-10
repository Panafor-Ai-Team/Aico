'use client';

import { ActionIcon, Flexbox, Tooltip } from '@lobehub/ui';
import { Popover } from 'antd';
import { createStaticStyles, useTheme } from 'antd-style';
import { PlusIcon, SmilePlus } from 'lucide-react';
import { type FC, lazy, memo, type ReactNode, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import { useGlobalStore } from '@/store/global';
import { globalGeneralSelectors } from '@/store/global/selectors';

import { useConversationResourceAccess } from '../../hooks/useConversationResourceAccess';
import { useConversationStore } from '../../store';

const QUICK_REACTIONS = ['👍', '👎', '❤️', '😄', '😂', '😅', '🎉', '😢', '🤔', '🚀'];

// The emoji-mart dataset is ~4.6 MB raw. It must NOT be in the entry bundle —
// load it only when the user opens the full picker (rare), not on every chat render.
const LazyEmojiPicker = lazy(() =>
  Promise.all([import('@emoji-mart/data'), import('@emoji-mart/react')]).then(
    ([{ default: data }, { default: Picker }]) => ({
      default: ({
        locale,
        theme,
        onSelect,
      }: {
        locale: string;
        theme: 'dark' | 'light';
        onSelect: (emoji: any) => void;
      }) => (
        <Picker
          data={data}
          locale={locale}
          previewPosition="none"
          skinTonePosition="none"
          theme={theme}
          onEmojiSelect={onSelect}
        />
      ),
    }),
  ),
);

const styles = createStaticStyles(({ css, cssVar }) => ({
  emojiButton: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: center;

    width: 32px;
    height: 32px;
    border-radius: ${cssVar.borderRadius};

    font-size: 18px;

    transition: all 0.2s;

    &:hover {
      transform: scale(1.1);
      background: ${cssVar.colorFillSecondary};
    }
  `,
  moreButton: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: center;

    width: 32px;
    height: 32px;
    border-radius: ${cssVar.borderRadius};

    color: ${cssVar.colorTextTertiary};

    transition: all 0.2s;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }
  `,
  pickerContainer: css`
    padding: 4px;
  `,
}));

interface ReactionPickerProps {
  messageId: string;
  trigger?: ReactNode;
}

const ReactionPicker: FC<ReactionPickerProps> = memo(({ messageId, trigger }) => {
  const { t } = useTranslation('chat');
  const theme = useTheme();
  const { allowed: canEdit } = usePermission('edit_own_content');
  const { canUseResource } = useConversationResourceAccess();
  const locale = useGlobalStore(globalGeneralSelectors.currentLanguage);
  const addReaction = useConversationStore((s) => s.addReaction);
  const [open, setOpen] = useState(false);
  const [showFullPicker, setShowFullPicker] = useState(false);

  // Reactions write to the shared conversation — view-only members don't get
  // the affordance (same absent-when-not-applicable rule as message actions).
  if (!canEdit || !canUseResource) return null;

  const handleSelect = (emoji: string) => {
    addReaction(messageId, emoji);
    setOpen(false);
    setShowFullPicker(false);
  };

  const handleOpenChange = (visible: boolean) => {
    setOpen(visible);
    if (!visible) setShowFullPicker(false);
  };

  const content = showFullPicker ? (
    <Suspense fallback={null}>
      <LazyEmojiPicker
        locale={locale?.split('-')[0] || 'en'}
        theme={theme.appearance === 'dark' ? 'dark' : 'light'}
        onSelect={(emoji: any) => handleSelect(emoji.native)}
      />
    </Suspense>
  ) : (
    <Flexbox horizontal className={styles.pickerContainer} gap={4} wrap="wrap">
      {QUICK_REACTIONS.map((emoji) => (
        <div className={styles.emojiButton} key={emoji} onClick={() => handleSelect(emoji)}>
          {emoji}
        </div>
      ))}
      <div className={styles.moreButton} onClick={() => setShowFullPicker(true)}>
        <PlusIcon size={16} />
      </div>
    </Flexbox>
  );

  return (
    <Popover
      arrow={false}
      content={content}
      open={open}
      overlayInnerStyle={{ padding: 0 }}
      placement="top"
      trigger="click"
      onOpenChange={handleOpenChange}
    >
      {trigger || (
        <span {...(open ? { 'data-popup-open': '' } : {})}>
          <Tooltip title={t('messageAction.reaction')}>
            <ActionIcon icon={SmilePlus} size="small" />
          </Tooltip>
        </span>
      )}
    </Popover>
  );
});

ReactionPicker.displayName = 'ReactionPicker';

export default ReactionPicker;
