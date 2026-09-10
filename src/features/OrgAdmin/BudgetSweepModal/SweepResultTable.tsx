'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Table } from 'antd';
import { type FC } from 'react';
import { useTranslation } from 'react-i18next';

import { AICO_TABLE_SCROLL, aicoPanelStyles } from '@/features/AicoPanels';

import type { SweepResult, SweepResultRow } from './types';

const usd = (value: string | number | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`;

const STATUS_COLOR: Record<SweepResultRow['status'], string | undefined> = {
  deferred: 'warning',
  reclaimed: 'success',
  skipped: undefined,
};

export interface SweepResultTableProps {
  result: SweepResult;
}

export const SweepResultTable: FC<SweepResultTableProps> = ({ result }) => {
  const { t } = useTranslation('aico');

  return (
    <Flexbox gap={12} width={'100%'}>
      <Flexbox gap={4}>
        <Text>
          {t('org.sweep.totalReclaimed')}: <Text strong>{usd(result.totalReclaimedUsd)}</Text>
        </Text>
        <Text type="secondary">
          {t('org.sweep.newOrgBalance', { balance: usd(result.orgBalanceUsd) })}
        </Text>
        {result.deferredCount > 0 && (
          // Deferred members are not lost — the key outbox retries them — but the
          // operator must know the balance above is not yet the final figure.
          <Text type="warning">
            {t('org.sweep.deferredNotice', { count: result.deferredCount })}
          </Text>
        )}
      </Flexbox>

      <div className={aicoPanelStyles.tableScroll}>
        <Table<SweepResultRow>
          dataSource={result.rows}
          pagination={result.rows.length > 20 ? { pageSize: 20 } : false}
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
              dataIndex: 'status',
              title: t('org.sweep.columns.outcome'),
              render: (status: SweepResultRow['status']) => (
                <Tag color={STATUS_COLOR[status]}>{t(`org.sweep.outcome.${status}` as const)}</Tag>
              ),
            },
            {
              align: 'end',
              dataIndex: 'reclaimedUsd',
              title: t('org.sweep.columns.reclaimed'),
              render: (value: string) => usd(value),
            },
            {
              dataIndex: 'error',
              ellipsis: true,
              title: t('org.sweep.columns.note'),
              render: (error: string | undefined) => error || '—',
            },
          ]}
        />
      </div>
    </Flexbox>
  );
};
