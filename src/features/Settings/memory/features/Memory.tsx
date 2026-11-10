'use client';

import { type UserMemoryEffort } from '@lobechat/types';
import { type FormGroupItemType } from '@lobehub/ui';
import { Form, Skeleton, Tooltip } from '@lobehub/ui';
import { Switch, type SwitchProps } from '@lobehub/ui/base-ui';
import isEqual from 'fast-deep-equal';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AutoSaveHint from '@/components/Editor/AutoSaveHint';
import { FORM_STYLE } from '@/const/layoutTokens';
import LevelSlider from '@/features/ModelSwitchPanel/components/ControlsForm/LevelSlider';
import { usePermission } from '@/hooks/usePermission';
import { useSaveState } from '@/hooks/useSaveState';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';

const MEMORY_EFFORT_LEVELS: readonly UserMemoryEffort[] = ['low', 'medium', 'high'];

// Form.Item injects checked/onChange into its direct child. Tooltip returns its child
// untouched when there is no title, which drops those props, so the switch is the child here.
const GuardedSwitch = ({ reason, ...props }: SwitchProps & { reason?: string }) => (
  <Tooltip title={reason}>
    <Switch {...props} />
  </Tooltip>
);

const MemorySetting = memo(() => {
  const { t } = useTranslation('setting');
  const { allowed: canManageMemory, reason } = usePermission('manage_settings');
  const [form] = Form.useForm();
  const memory = useUserStore(settingsSelectors.currentMemorySettings, isEqual);
  const memoryEnabled = useUserStore(settingsSelectors.memoryEnabled);
  const [setSettings, isUserStateInit] = useUserStore((s) => [s.setSettings, s.isUserStateInit]);
  const { status: saveStatus, lastSavedAt, save, retry } = useSaveState();

  if (!isUserStateInit) return <Skeleton active paragraph={{ rows: 3 }} title={false} />;

  const memorySettings: FormGroupItemType = {
    children: [
      {
        children: <GuardedSwitch disabled={!canManageMemory} reason={reason} />,
        desc: t('memory.enabled.desc'),
        label: t('memory.enabled.title'),
        layout: 'horizontal',
        minWidth: undefined,
        name: 'enabled',
        tooltip: reason,
        valuePropName: 'checked',
      },
      {
        children: (
          <GuardedSwitch disabled={!canManageMemory || memory?.enabled === false} reason={reason} />
        ),
        desc: t('memory.autoExtract.desc'),
        label: t('memory.autoExtract.title'),
        layout: 'horizontal',
        minWidth: undefined,
        name: 'autoExtract',
        valuePropName: 'checked',
      },
      {
        children: (
          <Tooltip title={reason}>
            <LevelSlider<UserMemoryEffort>
              defaultValue="medium"
              disabled={!canManageMemory}
              levels={MEMORY_EFFORT_LEVELS}
              style={{ minWidth: 160 }}
              value={memory.effort}
              marks={{
                0: t('memory.effort.level.low'),
                1: t('memory.effort.level.medium'),
                2: t('memory.effort.level.high'),
              }}
              onChange={(value) => {
                if (!canManageMemory) return;

                save(() => setSettings({ memory: { effort: value } }));
              }}
            />
          </Tooltip>
        ),
        desc: t('memory.effort.desc'),
        label: t('memory.effort.title'),
        layout: 'horizontal',
        minWidth: undefined,
      },
    ],
    extra: <AutoSaveHint lastUpdatedTime={lastSavedAt} saveStatus={saveStatus} onRetry={retry} />,
    title: t('memory.title'),
  };

  return (
    <Form
      collapsible={false}
      form={form}
      initialValues={{ ...memory, enabled: memoryEnabled }}
      items={[memorySettings]}
      itemsType={'group'}
      variant={'filled'}
      onValuesChange={(values) => {
        if (!canManageMemory) return;

        save(() => setSettings({ memory: values }));
      }}
      {...FORM_STYLE}
    />
  );
});

export default MemorySetting;
