import { ArtifactType } from '@lobechat/types';
import { exportFile } from '@lobechat/utils/client';
import { ActionIcon, Flexbox, Icon, Text } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { ConfigProvider } from 'antd';
import { cx } from 'antd-style';
import { ArrowLeft, CodeIcon, DownloadIcon, EyeIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ArtifactDeploymentActions from '@/business/client/features/ArtifactDeploymentActions';
import { useChatStore } from '@/store/chat';
import { chatPortalSelectors } from '@/store/chat/selectors';
import { ArtifactDisplayMode } from '@/store/chat/slices/portal/initialState';
import { oneLineEllipsis } from '@/styles';

// file extension per artifact type; anything else is HTML
const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  'application/lobe.artifacts.mermaid': 'mmd',
  [ArtifactType.Code]: 'txt',
  [ArtifactType.Python]: 'py',
  [ArtifactType.React]: 'tsx',
  'image/svg+xml': 'svg',
  'text/markdown': 'md',
};

const Title = () => {
  const { t } = useTranslation('portal');

  const [
    messageId,
    artifactIdentifier,
    topicId,
    displayMode,
    artifactType,
    artifactTitle,
    isArtifactTagClosed,
    closeArtifact,
  ] = useChatStore((s) => {
    const messageId = chatPortalSelectors.artifactMessageId(s) || '';
    const identifier = chatPortalSelectors.artifactIdentifier(s);

    return [
      messageId,
      identifier,
      s.activeTopicId,
      s.portalArtifactDisplayMode,
      chatPortalSelectors.artifactType(s),
      chatPortalSelectors.artifactTitle(s),
      chatPortalSelectors.isArtifactTagClosed(messageId, identifier)(s),
      s.closeArtifact,
    ];
  });

  // show switch only when artifact is closed and the type is not code
  const showSwitch = isArtifactTagClosed && artifactType !== ArtifactType.Code;

  const downloadArtifact = () => {
    const content = chatPortalSelectors.artifactCode(
      messageId,
      artifactIdentifier,
    )(useChatStore.getState());
    const extension = (artifactType && DOWNLOAD_EXTENSIONS[artifactType]) || 'html';

    exportFile(content, `${artifactIdentifier || 'artifact'}.${extension}`);
  };

  return (
    <Flexbox horizontal align={'center'} flex={1} gap={12} justify={'space-between'} width={'100%'}>
      <Flexbox horizontal align={'center'} gap={4}>
        <ActionIcon icon={ArrowLeft} size={'small'} onClick={() => closeArtifact()} />
        <Text className={cx(oneLineEllipsis)} type={'secondary'}>
          {artifactTitle}
        </Text>
      </Flexbox>
      <ConfigProvider
        theme={{
          token: {
            borderRadiusSM: 16,
            borderRadiusXS: 16,
            fontSize: 12,
          },
        }}
      >
        <Flexbox horizontal align={'center'} gap={4}>
          <ArtifactDeploymentActions
            artifactIdentifier={artifactIdentifier}
            artifactTitle={artifactTitle}
            artifactType={artifactType}
            displayMode={displayMode}
            isArtifactTagClosed={isArtifactTagClosed}
            messageId={messageId}
            topicId={topicId}
          />
          {isArtifactTagClosed && (
            <ActionIcon
              icon={DownloadIcon}
              size={'small'}
              title={t('download', { ns: 'common' })}
              onClick={downloadArtifact}
            />
          )}
          {showSwitch && (
            <Tabs
              activeKey={displayMode}
              size={'small'}
              items={[
                {
                  icon: <Icon icon={EyeIcon} />,
                  key: ArtifactDisplayMode.Preview,
                  label: t('artifacts.display.preview'),
                },
                {
                  icon: <Icon icon={CodeIcon} />,
                  key: ArtifactDisplayMode.Code,
                  label: t('artifacts.display.code'),
                },
              ]}
              onChange={(key) => {
                useChatStore.setState({ portalArtifactDisplayMode: key as ArtifactDisplayMode });
              }}
            />
          )}
        </Flexbox>
      </ConfigProvider>
    </Flexbox>
  );
};

export default Title;
