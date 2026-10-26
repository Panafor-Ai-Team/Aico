'use client';

import { Flexbox, Skeleton } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';

import WideScreenContainer from '../../WideScreenContainer';
import SkeletonList from './SkeletonList';

const styles = createStaticStyles(({ css }) => ({
  composer: css`
    overflow: hidden;

    height: 106px;
    border: 1px solid ${cssVar.colorFill};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgElevated};
    box-shadow: 0 4px 4px color-mix(in srgb, #000 4%, transparent);
  `,
}));

/**
 * Same-shape stand-in for a conversation while its route chunk loads: the
 * message skeleton above a composer-sized box. A branded spinner here made the
 * chat box feel like it loaded in two steps; this keeps the final layout in place.
 */
const ConversationLayoutSkeleton = memo(() => (
  <Flexbox aria-busy flex={1} height={'100%'} style={{ minHeight: 0, overflow: 'hidden' }}>
    <SkeletonList />
    <WideScreenContainer flex={'none'} paddingBlock={'0 8px'} paddingInline={16}>
      <Flexbox className={styles.composer} data-testid={'conversation-composer-skeleton'}>
        <Flexbox flex={1} paddingBlock={'12px 8px'} paddingInline={12}>
          <Skeleton.Button active size="small" style={{ height: 14, minWidth: 0, width: '38%' }} />
        </Flexbox>
        <Flexbox
          horizontal
          align={'center'}
          height={40}
          justify={'space-between'}
          paddingInline={8}
        >
          <Flexbox horizontal gap={6}>
            <Skeleton.Button active shape="circle" size="small" style={{ height: 28, width: 28 }} />
            <Skeleton.Button active shape="circle" size="small" style={{ height: 28, width: 28 }} />
          </Flexbox>
          <Skeleton.Button
            active
            shape="round"
            size="small"
            style={{ height: 32, minWidth: 64, width: 64 }}
          />
        </Flexbox>
      </Flexbox>
    </WideScreenContainer>
  </Flexbox>
));

ConversationLayoutSkeleton.displayName = 'ConversationLayoutSkeleton';

export default ConversationLayoutSkeleton;
