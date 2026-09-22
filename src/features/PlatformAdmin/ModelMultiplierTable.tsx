'use client';

/**
 * The catalog table: which models the site offers, and what each one costs.
 *
 * Availability is the `enabled` flag on the catalog row — the single thing
 * deciding whether a model appears in the site's picker. It survives catalog
 * syncs, so a choice made here is not undone by the next refresh.
 *
 * The coefficient column is read-only: it is the multiplier upstream publishes,
 * refreshed by the catalog sync every 6h. The platform markup is the only
 * multiplier an admin sets (Overview tab); there are no per-model overrides.
 */

import { Block, Flexbox, Text } from '@lobehub/ui';
import { Button, Switch, toast } from '@lobehub/ui/base-ui';
import { Table } from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import { AICO_TABLE_SCROLL, aicoPanelStyles } from '@/features/AicoPanels';
import { useClientDataSWR } from '@/libs/swr';
import { controlPlaneClient } from '@/libs/trpc/client/controlPlane';

const BP_SCALE = 10_000;

/** Exported so a sync elsewhere in the panel can refresh this table. */
export const MODEL_MULTIPLIERS_SWR_KEY = 'aico-model-multipliers';

interface ModelRow {
  displayName: string | null;
  enabled: boolean;
  modelId: string;
  publishedBp: number | null;
}

const formatCoefficient = (bp: number | null | undefined) =>
  typeof bp === 'number'
    ? `x${(bp / BP_SCALE).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`
    : '—';

export const ModelMultiplierTable = () => {
  const { t } = useTranslation('aico');
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const { data, mutate } = useClientDataSWR(MODEL_MULTIPLIERS_SWR_KEY, () =>
    controlPlaneClient.platformAdmin.listModelMultipliers.query(),
  );

  const rows: ModelRow[] = useMemo(() => data?.models ?? [], [data?.models]);

  /** Turn a single model on or off; the site's picker follows this flag. */
  const setEnabled = async (row: ModelRow, enabled: boolean) => {
    setBusyModelId(row.modelId);
    try {
      await controlPlaneClient.platformAdmin.setModelsEnabled.mutate({
        enabled,
        modelIds: [row.modelId],
      });
      toast.success(t('platform.modelEnabledSaved'));
      await mutate();
    } catch (err) {
      toastAicoError(err, t, 'platform.modelEnabledFailed');
    } finally {
      setBusyModelId(null);
    }
  };

  const setManyEnabled = async (enabled: boolean) => {
    if (selectedModelIds.length === 0) return;
    setBulkBusy(true);
    try {
      await controlPlaneClient.platformAdmin.setModelsEnabled.mutate({
        enabled,
        modelIds: selectedModelIds,
      });
      toast.success(t('platform.modelEnabledSaved'));
      setSelectedModelIds([]);
      await mutate();
    } catch (err) {
      toastAicoError(err, t, 'platform.modelEnabledFailed');
    } finally {
      setBulkBusy(false);
    }
  };

  const columns = [
    {
      key: 'enabled',
      render: (_: unknown, row: ModelRow) => (
        <Switch
          checked={row.enabled}
          disabled={bulkBusy}
          loading={busyModelId === row.modelId}
          title={t('platform.modelEnabledColumn')}
          onChange={(checked) => setEnabled(row, checked)}
        />
      ),
      title: t('platform.modelEnabledColumn'),
      width: 110,
    },
    {
      key: 'model',
      render: (_: unknown, row: ModelRow) => (
        <Flexbox gap={2}>
          <Text strong>{row.displayName || row.modelId}</Text>
          {row.displayName ? <Text type="secondary">{row.modelId}</Text> : null}
        </Flexbox>
      ),
      title: t('platform.modelMultiplierModel'),
    },
    {
      key: 'published',
      render: (_: unknown, row: ModelRow) => <Text>{formatCoefficient(row.publishedBp)}</Text>,
      title: t('platform.modelMultiplierPublished'),
      width: 130,
    },
  ];

  return (
    <Block className={aicoPanelStyles.section} variant="outlined">
      <Flexbox gap={12}>
        <Text strong>{t('platform.modelMultiplierTitle')}</Text>
        <Text type="secondary">{t('platform.modelMultiplierHint')}</Text>
        <Text type="secondary">{t('platform.modelEnabledHint')}</Text>
        {selectedModelIds.length > 0 && (
          <Flexbox horizontal align="center" gap={8}>
            <Text type="secondary">
              {t('platform.modelEnabledSelected', { count: selectedModelIds.length })}
            </Text>
            <Button
              loading={bulkBusy}
              size="small"
              type="primary"
              onClick={() => setManyEnabled(true)}
            >
              {t('platform.modelEnabledBulkOn')}
            </Button>
            <Button loading={bulkBusy} size="small" onClick={() => setManyEnabled(false)}>
              {t('platform.modelEnabledBulkOff')}
            </Button>
          </Flexbox>
        )}
        <Table
          columns={columns}
          dataSource={rows}
          loading={!data}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          rowKey="modelId"
          scroll={AICO_TABLE_SCROLL}
          size="small"
          rowSelection={{
            onChange: (keys) => setSelectedModelIds(keys as string[]),
            selectedRowKeys: selectedModelIds,
          }}
        />
      </Flexbox>
    </Block>
  );
};

export default ModelMultiplierTable;
