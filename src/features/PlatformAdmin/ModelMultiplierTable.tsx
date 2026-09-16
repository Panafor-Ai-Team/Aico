'use client';

/**
 * The catalog table: which models the site offers, and what each one costs.
 *
 * Availability is the `enabled` flag on the catalog row — the single thing
 * deciding whether a model appears in the site's picker. It survives catalog
 * syncs, so a choice made here is not undone by the next refresh.
 *
 * Per-model coefficient overrides (AICO-187) below.
 *
 * Upstream publishes a cost coefficient for every model, but does not always
 * charge it: measured against CheapVibeCode, `deepseek-v4.1-flash` billed x0.433
 * against an advertised x0.3 and `mimo-v2.5` x0.072 against x0.05, while
 * `glm-5.3-flash` matched exactly. Nothing in the models endpoint says which.
 *
 * An override corrects the price shown in the model picker and the per-message
 * cost estimate. It does NOT move the wallet debit, which is derived from the
 * upstream key's balance delta and is aggregate rather than per-model — so an
 * override makes what we display agree with what is actually charged.
 */

import { Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Switch, toast } from '@lobehub/ui/base-ui';
import { InputNumber, Table } from 'antd';
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
  note: string | null;
  overrideBp: number | null;
  publishedBp: number | null;
}

const formatCoefficient = (bp: number | null | undefined) =>
  typeof bp === 'number'
    ? `x${(bp / BP_SCALE).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`
    : '—';

export const ModelMultiplierTable = () => {
  const { t } = useTranslation('aico');
  const [drafts, setDrafts] = useState<Record<string, number | null>>({});
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const { data, mutate } = useClientDataSWR(MODEL_MULTIPLIERS_SWR_KEY, () =>
    controlPlaneClient.platformAdmin.listModelMultipliers.query(),
  );

  const rows: ModelRow[] = useMemo(() => data?.models ?? [], [data?.models]);

  /**
   * The value in the input: an unsaved edit if there is one, else the current
   * effective coefficient (override, falling back to published, falling back to
   * 1.00x for providers that publish no coefficient at all).
   */
  const draftFor = (row: ModelRow): number => {
    const draft = drafts[row.modelId];
    if (typeof draft === 'number') return draft;
    return (row.overrideBp ?? row.publishedBp ?? BP_SCALE) / BP_SCALE;
  };

  const save = async (row: ModelRow) => {
    const value = draftFor(row);
    if (!Number.isFinite(value) || value <= 0) return;
    setBusyModelId(row.modelId);
    try {
      await controlPlaneClient.platformAdmin.setModelMultiplier.mutate({
        modelId: row.modelId,
        multiplierBp: Math.round(value * BP_SCALE),
      });
      toast.success(t('platform.modelMultiplierSaved'));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.modelId];
        return next;
      });
      await mutate();
    } catch (err) {
      toastAicoError(err, t, 'platform.modelMultiplierFailed');
    } finally {
      setBusyModelId(null);
    }
  };

  const reset = async (row: ModelRow) => {
    setBusyModelId(row.modelId);
    try {
      await controlPlaneClient.platformAdmin.clearModelMultiplier.mutate({ modelId: row.modelId });
      toast.success(t('platform.modelMultiplierReset'));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.modelId];
        return next;
      });
      await mutate();
    } catch (err) {
      toastAicoError(err, t, 'platform.modelMultiplierFailed');
    } finally {
      setBusyModelId(null);
    }
  };

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
    {
      key: 'effective',
      render: (_: unknown, row: ModelRow) =>
        row.overrideBp == null ? (
          <Text type="secondary">{t('platform.modelMultiplierNoOverride')}</Text>
        ) : (
          <Tag color="warning">{formatCoefficient(row.overrideBp)}</Tag>
        ),
      title: t('platform.modelMultiplierEffective'),
      width: 150,
    },
    {
      key: 'edit',
      render: (_: unknown, row: ModelRow) => (
        <Flexbox horizontal align="center" gap={8}>
          <InputNumber
            aria-label={t('platform.modelMultiplierLabel')}
            max={10}
            min={0.1}
            step={0.01}
            style={{ width: 110 }}
            value={draftFor(row)}
            onChange={(value) =>
              setDrafts((prev) => ({
                ...prev,
                [row.modelId]: value == null ? null : Number(value),
              }))
            }
          />
          <Button
            loading={busyModelId === row.modelId}
            size="small"
            type="primary"
            onClick={() => save(row)}
          >
            {t('platform.modelMultiplierSave')}
          </Button>
          {row.overrideBp != null && (
            <Button loading={busyModelId === row.modelId} size="small" onClick={() => reset(row)}>
              {t('platform.modelMultiplierResetAction')}
            </Button>
          )}
        </Flexbox>
      ),
      title: t('platform.modelMultiplierEdit'),
      width: 320,
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
