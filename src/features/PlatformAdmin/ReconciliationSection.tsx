'use client';

/**
 * Books-balance monitor: the latest reconciliation run (cron every 15 minutes
 * or "Run now"), the CVC float against what live keys can still spend, and
 * each check's findings.
 */
import { Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { Table } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import { AICO_TABLE_SCROLL, aicoPanelStyles } from '@/features/AicoPanels';
import { useClientDataSWR } from '@/libs/swr';
import { controlPlaneClient } from '@/libs/trpc/client/controlPlane';

export const RECONCILIATION_SWR_KEY = 'aico-reconciliation-status';

type Status = 'critical' | 'error' | 'ok' | 'warn';

const STATUS_COLOR: Record<Status, string> = {
  critical: 'red',
  error: 'volcano',
  ok: 'green',
  warn: 'gold',
};

const styles = createStaticStyles(({ css }) => ({
  bar: css`
    position: relative;

    overflow: hidden;

    height: 10px;
    border-radius: 5px;

    background: ${cssVar.colorFillSecondary};
  `,
  details: css`
    margin: 0;
    padding-inline-start: 18px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  fill: css`
    height: 100%;
    border-radius: 5px;
  `,
  // The 80% danger line.
  marker: css`
    position: absolute;
    inset-block: 0;
    inset-inline-start: 80%;

    width: 2px;

    background: ${cssVar.colorWarning};
  `,
}));

const fillColor = (status: Status) =>
  status === 'critical' || status === 'error'
    ? cssVar.colorError
    : status === 'warn'
      ? cssVar.colorWarning
      : cssVar.colorSuccess;

const usdFromMicro = (v: unknown) =>
  typeof v === 'number' ? `$${(v / 1_000_000).toFixed(2)}` : '—';

interface CheckRow {
  details: string[];
  id: string;
  status: Status;
  values: Record<string, number | string | null>;
}

export const ReconciliationSection = () => {
  const { t } = useTranslation('aico');
  const [running, setRunning] = useState(false);
  const { data, mutate } = useClientDataSWR(RECONCILIATION_SWR_KEY, () =>
    controlPlaneClient.platformAdmin.getReconciliationStatus.query(),
  );

  const latest = data?.latest ?? null;
  const checks = (latest?.checks ?? []) as CheckRow[];
  const float = checks.find((c) => c.id === 'float_liability');
  const ratio = Number(float?.values.ratioPercent ?? 0);

  const runNow = async () => {
    setRunning(true);
    try {
      await controlPlaneClient.platformAdmin.runReconciliation.mutate();
      await mutate();
      toast.success(t('platform.reconciliation.ran'));
    } catch (err) {
      toastAicoError(err, t, 'platform.reconciliation.runFailed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Block className={aicoPanelStyles.section} variant="outlined">
      <Flexbox gap={12}>
        <Flexbox horizontal align="center" gap={8} justify="space-between" wrap="wrap">
          <Flexbox horizontal align="center" gap={8}>
            <Text strong>{t('platform.reconciliation.title')}</Text>
            {latest && (
              <Tag color={STATUS_COLOR[latest.status as Status]}>
                {t(`platform.reconciliation.status.${latest.status as Status}`)}
              </Tag>
            )}
          </Flexbox>
          <Button icon={<RefreshCwIcon size={14} />} loading={running} onClick={runNow}>
            {t('platform.reconciliation.runNow')}
          </Button>
        </Flexbox>
        <Text type="secondary">
          {latest
            ? t('platform.reconciliation.lastRun', {
                time: new Date(latest.startedAt).toLocaleString(),
                trigger: t(
                  `platform.reconciliation.trigger.${latest.trigger as 'cron' | 'manual'}`,
                ),
              })
            : t('platform.reconciliation.never')}
        </Text>
        {latest?.error && <Text type="danger">{latest.error}</Text>}

        {float && float.values.floatRawMicroUsd != null && (
          <Flexbox gap={6}>
            <Text>
              {t('platform.reconciliation.floatSummary', {
                exposure: usdFromMicro(float.values.exposureRawMicroUsd),
                float: usdFromMicro(float.values.floatRawMicroUsd),
                percent: float.values.ratioPercent ?? '∞',
              })}
            </Text>
            <div className={styles.bar}>
              <div
                className={styles.fill}
                style={{
                  background: fillColor(float.status),
                  width: `${Math.min(100, Math.max(0, ratio))}%`,
                }}
              />
              <div className={styles.marker} />
            </div>
            <Text style={{ fontSize: 12 }} type="secondary">
              {t('platform.reconciliation.floatHint', {
                promised: usdFromMicro(float.values.promisedBilledMicroUsd),
              })}
            </Text>
          </Flexbox>
        )}

        <div className={aicoPanelStyles.tableScroll}>
          <Table<CheckRow>
            dataSource={checks}
            pagination={false}
            rowKey="id"
            scroll={AICO_TABLE_SCROLL}
            size="small"
            columns={[
              {
                dataIndex: 'id',
                title: t('platform.reconciliation.columns.check'),
                render: (id: string) => t(`platform.reconciliation.checks.${id}` as never, id),
              },
              {
                dataIndex: 'status',
                title: t('platform.reconciliation.columns.status'),
                render: (s: Status) => (
                  <Tag color={STATUS_COLOR[s]}>{t(`platform.reconciliation.status.${s}`)}</Tag>
                ),
              },
              {
                dataIndex: 'values',
                title: t('platform.reconciliation.columns.issues'),
                render: (v: CheckRow['values']) => v.issues ?? 0,
              },
            ]}
            expandable={{
              expandedRowRender: (row) => (
                <ul className={styles.details}>
                  {row.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              ),
              rowExpandable: (row) => row.details.length > 0,
            }}
          />
        </div>
      </Flexbox>
    </Block>
  );
};
