'use client';

import { CheckCircleFilled, CloseCircleFilled, DownloadOutlined } from '@ant-design/icons';
import type { BuiltinRenderProps } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ExportFileState } from '../../../types';
import { triggerFileDownload } from './triggerDownload';

const styles = createStaticStyles(({ css }) => ({
  container: css`
    overflow: hidden;
    padding-inline: 8px 0;
  `,
  statusIcon: css`
    font-size: 12px;
  `,
}));

interface ExportFileParams {
  path: string;
}

const ExportFile = memo<BuiltinRenderProps<ExportFileParams, ExportFileState>>(
  ({ args, pluginState }) => {
    const { t } = useTranslation('plugin');
    const isSuccess = pluginState?.success;
    const filename = pluginState?.filename || args.path;

    const handleDownload = useCallback(() => {
      if (!pluginState?.downloadUrl || !pluginState?.filename) return;

      void triggerFileDownload(pluginState.downloadUrl, pluginState.filename);
    }, [pluginState?.downloadUrl, pluginState?.filename]);

    return (
      <Flexbox className={styles.container} gap={8}>
        <Flexbox horizontal align={'center'} gap={8}>
          {pluginState === undefined ? null : isSuccess ? (
            <CheckCircleFilled
              className={styles.statusIcon}
              style={{ color: cssVar.colorSuccess }}
            />
          ) : (
            <CloseCircleFilled className={styles.statusIcon} style={{ color: cssVar.colorError }} />
          )}
          <Text code as={'span'} fontSize={12}>
            {isSuccess
              ? t('builtins.lobe-cloud-sandbox.exportFile.exported', { filename })
              : t('builtins.lobe-cloud-sandbox.exportFile.failed', { path: args.path })}
          </Text>
          {isSuccess && pluginState?.downloadUrl && (
            <Button icon={<DownloadOutlined />} size={'small'} onClick={handleDownload}>
              {t('builtins.lobe-cloud-sandbox.exportFile.download')}
            </Button>
          )}
        </Flexbox>
      </Flexbox>
    );
  },
);

ExportFile.displayName = 'ExportFile';

export default ExportFile;
