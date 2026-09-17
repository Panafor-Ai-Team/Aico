'use client';

import { OPENROUTER_AUTO_MODEL_ID } from '@lobechat/business-const';
import { Flexbox, SearchBar, Text } from '@lobehub/ui';
import { Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import { BrandedModelIcon } from '@/components/Branding/BrandedModelIcon';
import { formatBrandedModelId } from '@/components/Branding/brandedModelId';
import { lambdaClient } from '@/libs/trpc/client';

export type TeamCatalogModel = { displayName?: string | null; id: string; type?: string | null };
type Team = { id: string; modelIds: string[]; name: string };

const TYPE_ORDER = ['chat', 'image', 'video'];

const styles = createStaticStyles(({ css }) => ({
  empty: css`
    padding-block: 24px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
  `,
  groupTitle: css`
    margin-block: 12px 4px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  list: css`
    overflow: auto;
    max-height: min(60vh, 520px);
  `,
  row: css`
    gap: 12px;
    align-items: center;

    padding-block: 8px;
    padding-inline: 8px;
    border-radius: ${cssVar.borderRadius}px;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
}));

/**
 * One switch per catalog model for the chosen team, saved on flip — the same
 * interaction as the site's model switches. On means the team may use the
 * model on the org wallet; off means it may not. Auto is always on.
 */
export const TeamModelsForm = ({
  models,
  onSaved,
  orgId,
  readOnly,
  teams,
}: {
  models: TeamCatalogModel[];
  onSaved: () => Promise<unknown>;
  orgId: string;
  readOnly: boolean;
  teams: Team[];
}) => {
  const { t } = useTranslation('aico');
  const [teamId, setTeamId] = useState<string | undefined>(teams[0]?.id);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(() => new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [keyword, setKeyword] = useState('');

  const team = teams.find((item) => item.id === teamId);

  useEffect(() => {
    if (!teamId && teams[0]) setTeamId(teams[0].id);
  }, [teamId, teams]);

  // Follow the server whenever the team or its saved rules change.
  useEffect(() => {
    setEnabledIds(new Set(team?.modelIds ?? []));
  }, [team?.id, team?.modelIds]);

  const groups = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const visible = models.filter((model) => {
      if (!q) return true;
      return [model.displayName || '', model.id, formatBrandedModelId(model.id)].some((value) =>
        value.toLowerCase().includes(q),
      );
    });
    const byType = new Map<string, TeamCatalogModel[]>();
    for (const model of visible) {
      const type = model.type || 'chat';
      byType.set(type, [...(byType.get(type) ?? []), model]);
    }
    return [...byType.entries()].sort(
      ([a], [b]) =>
        (TYPE_ORDER.indexOf(a) + 1 || TYPE_ORDER.length + 1) -
        (TYPE_ORDER.indexOf(b) + 1 || TYPE_ORDER.length + 1),
    );
  }, [keyword, models]);

  const toggle = async (modelId: string, enabled: boolean) => {
    if (!teamId) return;
    const update = (on: boolean) =>
      setEnabledIds((prev) => {
        const next = new Set(prev);
        if (on) next.add(modelId);
        else next.delete(modelId);
        return next;
      });

    update(enabled);
    setPendingIds((prev) => new Set(prev).add(modelId));
    try {
      await lambdaClient.organization.setTeamModelEnabled.mutate({
        enabled,
        modelId,
        orgId,
        teamId,
      });
      await onSaved();
    } catch (err) {
      update(!enabled);
      toastAicoError(err, t, 'org.teamModelFailed');
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  };

  return (
    <Flexbox gap={12}>
      <Flexbox gap={4}>
        <Text strong>{t('org.team')}</Text>
        <Select
          options={teams.map((item) => ({ label: item.name, value: item.id }))}
          style={{ width: '100%' }}
          value={teamId}
          onChange={(value) => setTeamId(value as string)}
        />
      </Flexbox>
      <Text type="secondary">{t('org.teamModelsHint')}</Text>
      <SearchBar
        allowClear
        placeholder={t('org.teamModelsSearch')}
        value={keyword}
        variant="filled"
        onChange={(e) => setKeyword(e.target.value)}
      />
      <Flexbox className={styles.list}>
        {groups.length === 0 ? (
          <div className={styles.empty}>{t('org.teamModelsEmpty')}</div>
        ) : (
          groups.map(([type, items]) => (
            <Flexbox key={type}>
              <div className={styles.groupTitle}>{t(`org.teamModelsType.${type}`, type)}</div>
              {items.map((model) => {
                const isAuto = model.id === OPENROUTER_AUTO_MODEL_ID;
                return (
                  <Flexbox horizontal className={styles.row} justify="space-between" key={model.id}>
                    <Flexbox horizontal align="center" gap={10} style={{ minWidth: 0 }}>
                      <BrandedModelIcon model={model.id} size={24} />
                      <Flexbox style={{ minWidth: 0 }}>
                        <Text ellipsis>{model.displayName || model.id}</Text>
                        <Text ellipsis fontSize={12} type="secondary">
                          {isAuto ? t('org.teamModelAutoAlwaysOn') : formatBrandedModelId(model.id)}
                        </Text>
                      </Flexbox>
                    </Flexbox>
                    <Switch
                      checked={isAuto || enabledIds.has(model.id)}
                      disabled={readOnly || isAuto || !teamId}
                      loading={pendingIds.has(model.id)}
                      size="small"
                      onChange={(checked) => void toggle(model.id, checked)}
                    />
                  </Flexbox>
                );
              })}
            </Flexbox>
          ))
        )}
      </Flexbox>
    </Flexbox>
  );
};
