'use client';

import { Flexbox } from '@lobehub/ui';
import { Skeleton } from 'antd';
import { createStaticStyles } from 'antd-style';
import dayjs from 'dayjs';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import FileIcon from '@/components/FileIcon';
import { formatTaskItemDate } from '@/features/AgentTasks/features/formatTaskItemDate';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useClientDataSWR } from '@/libs/swr';
import { resourceKeys } from '@/libs/swr/keys';
import { fileService } from '@/services/file';
import { FilesTabs } from '@/types/files';

import SectionTitle from './SectionTitle';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    cursor: pointer;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    padding: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    text-align: start;

    background: ${cssVar.colorBgContainer};

    transition: all 0.2s ${cssVar.motionEaseInOut};

    &:hover {
      border-color: ${cssVar.colorBorder};
      box-shadow: ${cssVar.boxShadowTertiary};
    }
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextQuaternary};
  `,
  name: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  preview: css`
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 16 / 10;
    width: 100%;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorFillQuaternary};
  `,
  thumbnail: css`
    width: 100%;
    height: 100%;
    object-fit: cover;
  `,
}));

const RECENT_FILES_LIMIT = 8;

const RecentFiles = memo(() => {
  const { t, i18n } = useTranslation(['file', 'common']);
  // Past a week, match the Works cards above: a localized "MMM D" date
  // instead of a bare ISO date next to relative ones.
  const formatTime = (date: Date | string) =>
    dayjs().diff(dayjs(date), 'd') < 7
      ? dayjs(date).fromNow()
      : formatTaskItemDate(date, {
          formatOtherYear: t('time.formatOtherYear', { ns: 'common' }),
          formatThisYear: t('time.formatThisYear', { ns: 'common' }),
          locale: i18n.language,
        });
  const navigate = useWorkspaceAwareNavigate();

  const { data, error, isLoading, mutate } = useClientDataSWR(
    resourceKeys.recentFiles(RECENT_FILES_LIMIT),
    () => fileService.getRecentFiles(RECENT_FILES_LIMIT),
  );

  // A failed load used to hide the section as if there were no files.
  if (error && !data) {
    return (
      <Flexbox gap={12}>
        <SectionTitle
          title={t('home.recentFiles', { ns: 'file' })}
          viewAllUrl={`/resource/${FilesTabs.All}`}
        />
        <AsyncError error={error} variant={'inline'} onRetry={() => void mutate()} />
      </Flexbox>
    );
  }

  if (!isLoading && !data?.length) return null;

  return (
    <Flexbox gap={12}>
      <SectionTitle
        title={t('home.recentFiles', { ns: 'file' })}
        viewAllUrl={`/resource/${FilesTabs.All}`}
      />
      {isLoading ? (
        <div className={styles.grid}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton.Node active key={index} style={{ height: 160, width: '100%' }} />
          ))}
        </div>
      ) : (
        <div className={styles.grid}>
          {data!.map((item) => {
            const isImage = item.fileType?.startsWith('image');
            return (
              <button
                className={styles.card}
                key={item.id}
                type={'button'}
                onClick={() => navigate(`/resource?file=${item.id}`)}
              >
                <div className={styles.preview}>
                  {isImage && item.url ? (
                    <img alt={item.name} className={styles.thumbnail} src={item.url} />
                  ) : (
                    <FileIcon fileName={item.name} fileType={item.fileType} size={40} />
                  )}
                </div>
                <Flexbox gap={4} padding={12}>
                  <span className={styles.name}>{item.name}</span>
                  {/* The list is ordered by last update; show that date, not upload time. */}
                  <span className={styles.meta}>
                    {formatTime(item.updatedAt ?? item.createdAt)}
                  </span>
                </Flexbox>
              </button>
            );
          })}
        </div>
      )}
    </Flexbox>
  );
});

RecentFiles.displayName = 'RecentFiles';

export default RecentFiles;
