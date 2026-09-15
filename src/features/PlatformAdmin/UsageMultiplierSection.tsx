'use client';

/**
 * Per-provider usage multiplier editor (AICO-186).
 *
 * The markup used to be one global value. It is now one row per managed
 * provider, because the gateways have different unit economics: OpenRouter is
 * resold at 1.20x, CheapVibeCode at 1.25x (CVC sells 25M tokens per USD, so a
 * $1 top-up should credit 20M — i.e. buy $0.80 of raw capacity).
 *
 * Only one provider is live at a time (`AICO_MANAGED_PROVIDER`); the dormant
 * one is still editable so a switch does not need a deploy to set its rate.
 */

import { Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { InputNumber } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mutate as globalMutate } from 'swr';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import { aicoPanelStyles } from '@/features/AicoPanels';
import { useClientDataSWR } from '@/libs/swr';
import { controlPlaneClient } from '@/libs/trpc/client/controlPlane';

const BP_SCALE = 10_000;

interface ProviderRow {
  isActive: boolean;
  multiplierBp: number;
  providerId: string;
}

export const UsageMultiplierSection = () => {
  const { t } = useTranslation('aico');
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const { data, mutate } = useClientDataSWR('aico-usage-multipliers', () =>
    controlPlaneClient.platformAdmin.listUsageMultipliers.query(),
  );

  const providers: ProviderRow[] = useMemo(() => data?.providers ?? [], [data?.providers]);

  // Hydrate the inputs from the server, converting bp -> x at the boundary.
  // Keyed by provider so a save on one row never clobbers an unsaved edit on
  // the other.
  useEffect(() => {
    if (!providers.length) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const provider of providers) {
        if (next[provider.providerId] === undefined) {
          next[provider.providerId] = provider.multiplierBp / BP_SCALE;
        }
      }
      return next;
    });
  }, [providers]);

  const save = async (providerId: string) => {
    const value = drafts[providerId];
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    setSavingId(providerId);
    try {
      await controlPlaneClient.platformAdmin.updateUsageMultiplier.mutate({
        multiplierBp: Math.round(value * BP_SCALE),
        providerId: providerId as 'cheapvibecode' | 'openrouter',
      });
      toast.success(t('platform.multiplierSaved'));
      // The overview summary card reads the live provider's rate under its own
      // key; without this it would sit next to the editor showing the old value.
      await Promise.all([mutate(), globalMutate('aico-usage-multiplier')]);
    } catch (err) {
      toastAicoError(err, t, 'platform.multiplierFailed');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Block className={aicoPanelStyles.section} variant="outlined">
      <Flexbox gap={12}>
        <Text strong>{t('platform.multiplierTitle')}</Text>
        <Text type="secondary">{t('platform.multiplierHint')}</Text>

        {providers.map((provider) => (
          <Flexbox horizontal align="center" gap={12} key={provider.providerId} wrap="wrap">
            <Flexbox horizontal align="center" gap={8} style={{ minWidth: 200 }}>
              <Text strong>{t(`platform.provider.${provider.providerId}` as never)}</Text>
              {provider.isActive && <Tag color="success">{t('platform.multiplierActive')}</Tag>}
            </Flexbox>
            <InputNumber
              aria-label={t('platform.multiplierLabel')}
              max={3}
              min={1}
              step={0.05}
              style={{ minWidth: 140 }}
              value={drafts[provider.providerId]}
              onChange={(value) =>
                setDrafts((prev) => ({ ...prev, [provider.providerId]: Number(value) }))
              }
            />
            <Button
              loading={savingId === provider.providerId}
              type="primary"
              onClick={() => save(provider.providerId)}
            >
              {t('platform.multiplierSave')}
            </Button>
            <Text type="secondary">
              {t('platform.multiplierPreview', {
                value: (provider.multiplierBp / BP_SCALE).toFixed(2),
              })}
            </Text>
          </Flexbox>
        ))}
      </Flexbox>
    </Block>
  );
};

export default UsageMultiplierSection;
