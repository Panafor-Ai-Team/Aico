import { type EmojiPickerProps } from '@lobehub/ui';
import { lazy, memo, Suspense } from 'react';

import { useGlobalStore } from '@/store/global';
import { globalGeneralSelectors } from '@/store/global/selectors';

// The emoji-mart dataset (~4.6 MB raw) ships inside @lobehub/ui's EmojiPicker.
// Lazy-load the whole picker so it never enters the entry bundle — it loads
// on demand the first time a user opens an emoji popover.
const LobeEmojiPicker = lazy(() =>
  import('@lobehub/ui/es/EmojiPicker/EmojiPicker').then((mod) => ({ default: mod.default })),
);

export const EmojiPicker = memo<EmojiPickerProps>(({ shape = 'square', ...rest }) => {
  const locale = useGlobalStore(globalGeneralSelectors.currentLanguage);

  return (
    <Suspense fallback={null}>
      <LobeEmojiPicker shape={shape} {...rest} defaultAvatar={null as any} locale={locale} />
    </Suspense>
  );
});

export default EmojiPicker;
