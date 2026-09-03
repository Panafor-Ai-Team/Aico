'use client';

import { Button, Select, toast } from '@lobehub/ui/base-ui';
import { Form, Input } from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import { lambdaClient } from '@/libs/trpc/client';

import { filterModelOptionsKeepingSelected } from './filterModelOptionsKeepingSelected';

type ModelOption = { label: string; value: string };
type Team = { id: string; modelIds: string[]; name: string };

export const TeamModelsForm = ({
  modelOptions,
  onSaved,
  orgId,
  readOnly,
  teams,
}: {
  modelOptions: ModelOption[];
  onSaved: () => Promise<unknown>;
  orgId: string;
  readOnly: boolean;
  teams: Team[];
}) => {
  const { t } = useTranslation('aico');
  const [form] = Form.useForm<{ teamId: string }>();
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const visibleOptions = useMemo(
    () => filterModelOptionsKeepingSelected(modelOptions, query, selectedModelIds),
    [modelOptions, query, selectedModelIds],
  );

  return (
    <Form
      disabled={readOnly}
      form={form}
      layout="vertical"
      onFinish={async (values) => {
        if (readOnly) return;
        setBusy(true);
        try {
          await lambdaClient.organization.setTeamModels.mutate({
            modelIds: selectedModelIds,
            orgId,
            teamId: values.teamId,
          });
          toast.success(t('org.modelsSaved'));
          await onSaved();
        } catch (err) {
          toastAicoError(err, t, 'org.modelsFailed');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Form.Item label={t('org.team')} name="teamId" rules={[{ required: true }]}>
        <Select
          options={teams.map((team) => ({ label: team.name, value: team.id }))}
          style={{ width: '100%' }}
          onChange={(teamId) => {
            const team = teams.find((item) => item.id === teamId);
            setSelectedModelIds(team?.modelIds || []);
            setQuery('');
          }}
        />
      </Form.Item>
      <Form.Item label={t('org.modelIds')}>
        <Input
          allowClear
          placeholder={t('org.modelIdsPlaceholder')}
          style={{ marginBottom: 8 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          allowClear
          mode="multiple"
          options={visibleOptions}
          style={{ width: '100%' }}
          value={selectedModelIds}
          onChange={(value) => setSelectedModelIds((value as string[] | null) || [])}
        />
      </Form.Item>
      <Button disabled={readOnly} htmlType="submit" loading={busy}>
        {t('org.saveModels')}
      </Button>
    </Form>
  );
};
