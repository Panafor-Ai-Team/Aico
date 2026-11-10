'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar, useResponsive } from 'antd-style';
import { DotIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { BrandedModelIcon } from '@/components/Branding/BrandedModelIcon';
import { formatBrandedModelId } from '@/components/Branding/brandedModelId';
import { ModelInfoTags } from '@/components/ModelSelect';
import PublishedTime from '@/components/PublishedTime';
import ModelTypeIcon from '@/routes/(main)/community/(list)/model/features/List/ModelTypeIcon';

import { useDetailContext } from './DetailProvider';

const styles = createStaticStyles(({ css, cssVar }) => {
  return {
    desc: css`
      color: ${cssVar.colorTextSecondary};
    `,
    time: css`
      font-size: 12px;
      color: ${cssVar.colorTextDescription};
    `,
    version: css`
      font-family: ${cssVar.fontFamilyCode};
      font-size: 13px;
    `,
  };
});

const Header = memo<{ mobile?: boolean }>(({ mobile: isMobile }) => {
  const { description, identifier, releasedAt, displayName, type, abilities, contextWindowTokens } =
    useDetailContext();
  const { mobile = isMobile } = useResponsive();
  // `identifier` is optional on the detail context but always present for a
  // rendered model page; fall back to an empty id rather than passing undefined
  // into helpers that require a string.
  const modelId = identifier ?? '';
  const { t } = useTranslation('models');

  return (
    <Flexbox gap={12}>
      <Flexbox horizontal align={'flex-start'} gap={16} width={'100%'}>
        <BrandedModelIcon model={modelId} size={mobile ? 48 : 64} />
        <Flexbox
          flex={1}
          gap={4}
          style={{
            overflow: 'hidden',
          }}
        >
          <Flexbox
            horizontal
            align={'center'}
            gap={8}
            justify={'space-between'}
            style={{
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <Flexbox
              horizontal
              align={'center'}
              flex={1}
              gap={12}
              style={{
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <Text
                as={'h1'}
                ellipsis={{ rows: 1 }}
                style={{ fontSize: mobile ? 18 : 24, margin: 0 }}
                title={modelId}
              >
                {displayName || formatBrandedModelId(modelId)}
              </Text>
            </Flexbox>
            <Flexbox horizontal align={'center'} gap={6}>
              {type && <ModelTypeIcon type={type} />}
            </Flexbox>
          </Flexbox>
          <Flexbox horizontal align={'center'} gap={4}>
            <span>{formatBrandedModelId(modelId)}</span>
            <Icon icon={DotIcon} />
            <ModelInfoTags
              directionReverse
              contextWindowTokens={contextWindowTokens}
              {...abilities}
            />
            <Icon icon={DotIcon} />
            <PublishedTime className={styles.time} date={releasedAt as string} />
          </Flexbox>
        </Flexbox>
      </Flexbox>
      <div
        style={{
          color: cssVar.colorTextSecondary,
        }}
      >
        {t(`${identifier}.description`, { defaultValue: description })}
      </div>
    </Flexbox>
  );
});

export default Header;
