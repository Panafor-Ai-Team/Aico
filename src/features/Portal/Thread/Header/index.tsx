import { ActionIcon, Flexbox } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { ArrowLeftRight, XIcon } from 'lucide-react';
import { memo } from 'react';

import NavHeader from '@/features/NavHeader';
import { useChatStore } from '@/store/chat';
import { portalThreadSelectors } from '@/store/chat/selectors';

import Title from './Title';

const Header = memo(() => {
  const [portalThreadId, closeThreadPortal, switchThread] = useChatStore((s) => [
    // Same source the portal renders from — never the free-floating field,
    // which can outlive its view (T-041 lost-message class).
    portalThreadSelectors.currentThreadView(s)?.threadId,
    s.closeThreadPortal,
    s.switchThread,
  ]);

  return (
    <NavHeader
      left={<Title />}
      paddingBlock={6}
      paddingInline={8}
      showTogglePanelButton={false}
      right={
        <Flexbox horizontal gap={4}>
          {!!portalThreadId && (
            <ActionIcon
              icon={ArrowLeftRight}
              size={'small'}
              onClick={() => {
                if (!portalThreadId) return;

                switchThread(portalThreadId);
                closeThreadPortal();
              }}
            />
          )}
          <ActionIcon icon={XIcon} size={'small'} onClick={closeThreadPortal} />
        </Flexbox>
      }
      style={{
        borderBottom: `1px solid ${cssVar.colorBorderSecondary}`,
      }}
    />
  );
});

export default Header;
