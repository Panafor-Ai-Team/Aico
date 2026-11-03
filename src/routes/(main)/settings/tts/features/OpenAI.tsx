'use client';

import { type FormGroupItemType } from '@lobehub/ui';
import { Form, Icon, Skeleton, Tooltip } from '@lobehub/ui';
import { Select, type SelectProps } from '@lobehub/ui/base-ui';
import isEqual from 'fast-deep-equal';
import { Loader2Icon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FORM_STYLE } from '@/const/layoutTokens';
import { serviceModelFormStyles } from '@/features/ServiceModel/styles';
import { SettingsSearchAnchor } from '@/features/SettingsSearch/anchor';
import { usePermission } from '@/hooks/usePermission';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';

import { opeanaiTTSOptions } from './const';

// Form.Item injects value/onChange into its direct child. Tooltip returns its child
// untouched when there is no title, which drops those props, so the select is the child here.
const GuardedSelect = ({ reason, ...props }: SelectProps & { reason?: string }) => (
  <Tooltip title={reason}>
    <Select {...props} />
  </Tooltip>
);

const OpenAI = memo(() => {
  const { t } = useTranslation('setting');
  const { allowed: canManageServiceModel, reason } = usePermission('manage_settings');
  const [form] = Form.useForm();
  const { tts } = useUserStore(settingsSelectors.currentSettings, isEqual);
  const [setSettings, isUserStateInit] = useUserStore((s) => [s.setSettings, s.isUserStateInit]);
  const [loading, setLoading] = useState(false);

  if (!isUserStateInit) return <Skeleton active paragraph={{ rows: 5 }} title={false} />;

  const openai: FormGroupItemType = {
    children: [
      {
        className: serviceModelFormStyles.centeredLabel,
        children: (
          <GuardedSelect
            disabled={!canManageServiceModel}
            options={opeanaiTTSOptions}
            reason={reason}
            style={{ width: 'min(100%, 448px)' }}
          />
        ),
        label: (
          <SettingsSearchAnchor id={'service-model-tts'}>
            {t('settingTTS.openai.ttsModel')}
          </SettingsSearchAnchor>
        ),
        name: ['openAI', 'ttsModel'],
      },
    ],
    extra: loading && <Icon spin icon={Loader2Icon} size={16} style={{ opacity: 0.5 }} />,
    title: t('settingTTS.openai.title'),
  };

  return (
    <Form
      collapsible={false}
      form={form}
      initialValues={tts}
      items={[openai]}
      itemsType={'group'}
      variant={'filled'}
      onValuesChange={async (values) => {
        if (!canManageServiceModel) return;

        setLoading(true);
        await setSettings({
          tts: values,
        });
        setLoading(false);
      }}
      {...FORM_STYLE}
      itemMinWidth={undefined}
    />
  );
});

export default OpenAI;
