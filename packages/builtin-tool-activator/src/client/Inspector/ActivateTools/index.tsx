'use client';

import { type BuiltinInspectorProps } from '@lobechat/types';
import { Avatar, Flexbox, Icon, Tooltip } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { AlertTriangle } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { inspectorTextStyles, shinyTextStyles } from '@/styles';

import type { ActivateToolsParams, ActivateToolsState } from '../../../types';
import { getActivateToolsDisplay } from './display';

const styles = createStaticStyles(({ css }) => ({
  notFoundHint: css`
    flex-shrink: 0;
    max-width: 100%;
    font-size: 12px;
    color: ${cssVar.colorWarning};
  `,
  tool: css`
    overflow: hidden;
    display: inline-flex;
    flex-shrink: 1;
    gap: 6px;
    align-items: center;

    min-width: 0;
    padding-block: 2px;
    padding-inline: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    font-size: 12px;
    color: ${cssVar.colorText};

    background: ${cssVar.colorFillTertiary};
  `,
  toolName: css`
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tools: css`
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;

    margin-inline-start: 4px;
  `,
}));

export const ActivateToolsInspector = memo<
  BuiltinInspectorProps<ActivateToolsParams, ActivateToolsState>
>(({ args, partialArgs, isArgumentsStreaming, isLoading, pluginState }) => {
  const { t } = useTranslation('plugin');

  const identifiers = args?.identifiers || partialArgs?.identifiers;
  const { notFoundNames, requestedTools, visibleTools } = getActivateToolsDisplay(
    identifiers,
    pluginState,
    t,
  );

  // Streaming / Loading: show the tools requested in the arguments
  if (isArgumentsStreaming || isLoading) {
    return (
      <div className={cx(inspectorTextStyles.root, shinyTextStyles.shinyText)}>
        <span>{t('builtins.lobe-activator.apiName.activateTools')}</span>
        {requestedTools.length > 0 && (
          <span className={styles.tools}>
            {requestedTools.map((tool) => (
              <span className={styles.tool} key={tool.identifier}>
                <span className={styles.toolName}>{tool.name}</span>
              </span>
            ))}
          </span>
        )}
      </div>
    );
  }

  // Finished: show activated tool names with avatars; surface notFound in the title row
  const hasNotFound = notFoundNames.length > 0;
  const notFoundTitle = notFoundNames.join(', ');

  return (
    <Flexbox
      allowShrink
      horizontal
      className={inspectorTextStyles.root}
      gap={8}
      style={{ flexWrap: 'wrap' }}
    >
      <span>{t('builtins.lobe-activator.apiName.activateTools')}</span>
      {hasNotFound && (
        <Tooltip title={notFoundTitle}>
          <Flexbox horizontal className={styles.notFoundHint} gap={4}>
            <Icon color={cssVar.colorWarning} icon={AlertTriangle} />
            <span>
              {t('builtins.lobe-activator.inspector.activateTools.notFoundCount', {
                count: notFoundNames.length,
              })}
            </span>
          </Flexbox>
        </Tooltip>
      )}
      {visibleTools.length > 0 && (
        <span className={styles.tools}>
          {visibleTools.map((tool) => (
            <span className={styles.tool} key={tool.identifier}>
              {tool.avatar && <Avatar avatar={tool.avatar} size={14} title={tool.name} />}
              <span className={styles.toolName}>{tool.name}</span>
            </span>
          ))}
        </span>
      )}
    </Flexbox>
  );
});

ActivateToolsInspector.displayName = 'ActivateToolsInspector';
