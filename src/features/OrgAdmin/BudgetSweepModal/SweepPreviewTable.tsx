'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Table } from 'antd';
import { type FC } from 'react';
import { useTranslation } from 'react-i18next';

import { AICO_TABLE_SCROLL, aicoPanelStyles } from '@/features/AicoPanels';

import type { SweepPreview, SweepPreviewRow } from './types';

const usd = (value: string | number | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`;

const periodLabelKey = (period: string) =>
  period === 'daily' || period === 'weekly' || period === 'monthly'
    ? (`org.period.${period}` as const)
    : ('org.period.total' as const);

export interface SweepPreviewTableProps {
  preview: SweepPreview;
}

/**
 * Read-only breakdown of what a sweep would reclaim, member by member.
 * Shared by the org-manager panel and the control plane so both show the
 * operator the same numbers before they commit.
 */
export const SweepPreviewTable: FC<SweepPreviewTableProps> = ({ preview }) => {
  const { t } = useTranslation('aico');

  return (
    <Flexbox gap={12} width={'100%'}>
      <div className={aicoPanelStyles.tableScroll}>
        <Table<SweepPreviewRow>
          dataSource={preview.rows}
          pagination={preview.rows.length > 20 ? { pageSize: 20 } : false}
          rowKey="memberId"
          scroll={AICO_TABLE_SCROLL}
          size="small"
          columns={[
            {
              dataIndex: 'publicCode',
              title: t('org.sweep.columns.member'),
              render: (publicCode: string | null, row) => (
                <Flexbox gap={2}>
                  <Text>{row.email || row.username || '—'}</Text>
                  {publicCode && (
                    <Text style={{ fontSize: 12 }} type="secondary">
                      {publicCode}
                    </Text>
                  )}
                </Flexbox>
              ),
            },
            {
              dataIndex: 'period',
              title: t('org.sweep.columns.period'),
              render: (period: string) => t(periodLabelKey(period)),
            },
            {
              align: 'end',
              dataIndex: 'periodAmountUsd',
              title: t('org.sweep.columns.limit'),
              render: (value: string) => usd(value),
            },
            {
              align: 'end',
              dataIndex: 'settledUsageUsd',
              title: t('org.sweep.columns.used'),
              render: (value: string) => usd(value),
            },
            {
              align: 'end',
              dataIndex: 'reclaimUsd',
              title: t('org.sweep.columns.toReclaim'),
              render: (value: string) => <Text strong>{usd(value)}</Text>,
            },
            {
              dataIndex: 'estimateSource',
              title: t('org.sweep.columns.note'),
              render: (source: SweepPreviewRow['estimateSource'], row) => {
                if (row.skipReason)
                  return <Tag>{t(`org.sweep.skipReason.${row.skipReason}` as const)}</Tag>;
                if (source === 'wallet-fallback')
                  return <Tag color="warning">{t('org.sweep.source.walletFallback')}</Tag>;
                if (source === 'wallet-only') return <Tag>{t('org.sweep.source.walletOnly')}</Tag>;
                return null;
              },
            },
          ]}
        />
      </div>

      <Flexbox gap={4}>
        <Text>
          {t('org.sweep.totalToReclaim')}: <Text strong>{usd(preview.totalReclaimUsd)}</Text>
        </Text>
        <Text type="secondary">
          {t('org.sweep.balanceChange', {
            after: usd(preview.projectedOrgBalanceUsd),
            before: usd(preview.currentOrgBalanceUsd),
          })}
        </Text>
      </Flexbox>
    </Flexbox>
  );
};
