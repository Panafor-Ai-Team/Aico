'use client';

/**
 * Per-model coefficient overrides (AICO-187).
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
import { Button, toast } from '@lobehub/ui/base-ui';
import { InputNumber, Table } from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import { AICO_TABLE_SCROLL, aicoPanelStyles } from '@/features/AicoPanels';
import { useClientDataSWR } from '@/libs/swr';
import { controlPlaneClient } from '@/libs/trpc/client/controlPlane';

const BP_SCALE = 10_000;

interface ModelRow {
  displayName: string | null;
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

  const { data, mutate } = useClientDataSWR('aico-model-multipliers', () =>
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

  const columns = [
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
        <Table
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          rowKey="modelId"
          scroll={AICO_TABLE_SCROLL}
          size="small"
        />
      </Flexbox>
    </Block>
  );
};

export default ModelMultiplierTable;
