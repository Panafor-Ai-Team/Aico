'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Select, toast } from '@lobehub/ui/base-ui';
import { Form } from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import { lambdaClient } from '@/libs/trpc/client';

import { excludeSelectedModelOptions } from './excludeSelectedModelOptions';

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
  const [busy, setBusy] = useState(false);

  const labelFor = (modelId: string) =>
    modelOptions.find((option) => option.value === modelId)?.label ?? modelId;

  const addableOptions = useMemo(
    () => excludeSelectedModelOptions(modelOptions, selectedModelIds),
    [modelOptions, selectedModelIds],
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
          }}
        />
      </Form.Item>
      <Form.Item label={t('org.modelIds')}>
        <Flexbox gap={8}>
          <Flexbox horizontal gap={4} wrap="wrap">
            {selectedModelIds.length === 0 ? (
              <Text type="secondary">{t('org.noModelsGranted')}</Text>
            ) : (
              selectedModelIds.map((modelId) => (
                <Tag
                  closable={!readOnly}
                  key={modelId}
                  onClose={(e) => {
                    e.preventDefault();
                    setSelectedModelIds((prev) => prev.filter((id) => id !== modelId));
                  }}
                >
                  {labelFor(modelId)}
                </Tag>
              ))
            )}
          </Flexbox>
          <Select
            allowClear
            showSearch
            options={addableOptions}
            placeholder={t('org.modelIdsPlaceholder')}
            style={{ width: '100%' }}
            value={undefined}
            onChange={(value) => {
              if (!value) return;
              setSelectedModelIds((prev) =>
                prev.includes(value as string) ? prev : [...prev, value as string],
              );
            }}
          />
        </Flexbox>
      </Form.Item>
      <Button disabled={readOnly} htmlType="submit" loading={busy}>
        {t('org.saveModels')}
      </Button>
    </Form>
  );
};
