'use client';

/**
 * Platform admin UI — control-plane SPA only (`SPA_TARGET=control-plane`).
 * Talks to `@aico/control-plane` via `controlPlaneClient` (not the product lambda).
 */

import { uuid } from '@lobechat/utils';
import { Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Select, Switch, Tabs, toast } from '@lobehub/ui/base-ui';
import { Form, Input, InputNumber, Table } from 'antd';
import { Building2Icon, RefreshCwIcon, ShieldIcon, WalletIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import StatisticCard from '@/components/StatisticCard';
import {
  type FxTopupChargeField,
  FxTopupFields,
  type FxTopupFormValues,
  resolveFxTopupPayload,
} from '@/features/AicoBilling/FxTopupFields';
import { groupedNumberInputProps } from '@/features/AicoBilling/groupedNumberInput';
import { AICO_TABLE_SCROLL, aicoPanelStyles } from '@/features/AicoPanels';
import { createBudgetSweepModal } from '@/features/OrgAdmin/BudgetSweepModal';
import { useClientDataSWR } from '@/libs/swr';
import { controlPlaneClient } from '@/libs/trpc/client/controlPlane';

const usd = (n: number | string | undefined | null) => `$${Number(n ?? 0).toFixed(2)}`;

/**
 * Row shape for the audit-log table. Declared once because the columns array
 * infers its record type from the first column that annotates one — annotating
 * two columns with different partial shapes made them conflict.
 */
interface AuditRow {
  orgId?: string | null;
  userId?: string | null;
}

export const PlatformAdminPanel = () => {
  const { t } = useTranslation('aico');
  const [tab, setTab] = useState('overview');
  const [createForm] = Form.useForm<{ managerEmail: string; name: string }>();
  // Extra fields are optional so this stays assignable to
  // `FormInstance<FxTopupFormValues>` for <FxTopupFields> — FormInstance is
  // invariant, so a required extra field makes the whole instance incompatible
  // even though the child only touches the shared amount fields. Matches
  // userCreditForm below. `orgId` is enforced by the Form.Item rule and the
  // guard in onFinish.
  const [creditForm] = Form.useForm<FxTopupFormValues & { description?: string; orgId?: string }>();
  const [creditChargeField, setCreditChargeField] = useState<FxTopupChargeField>('toman');
  /**
   * FIN-013: one key per in-flight credit attempt, held until the credit is
   * known to have landed. A retry after a failure reuses it, so the second
   * attempt resolves to the same transaction instead of crediting again.
   */
  const creditIdempotencyKeyRef = useRef<string | null>(null);
  const [userCreditForm] = Form.useForm<
    FxTopupFormValues & { description?: string; email?: string; userId?: string }
  >();
  const [userCreditChargeField, setUserCreditChargeField] = useState<FxTopupChargeField>('toman');
  const userCreditIdempotencyKeyRef = useRef<string | null>(null);
  const [assignForm] = Form.useForm<{
    managerEmail: string;
    orgId: string;
    role: 'owner' | 'admin';
  }>();
  const [trialForm] = Form.useForm<{
    allowedModelIds: string;
    durationDays: number;
    enabled: boolean;
    maxRequests?: number | null;
    trialBudgetUsd?: number;
  }>();
  const [deactivateForm] = Form.useForm<{ reason: string; userId: string }>();
  const [fxForm] = Form.useForm<{ tomanPerUsd: number }>();
  const [multiplierForm] = Form.useForm<{ multiplier: number }>();
  const [busy, setBusy] = useState(false);

  const { data, error, isLoading, mutate } = useClientDataSWR('aico-platform-orgs', () =>
    controlPlaneClient.platformAdmin.listOrganizations.query({ page: 1, pageSize: 50 }),
  );

  const { data: financials, mutate: mutateFinancials } = useClientDataSWR(
    'aico-platform-financials',
    () => controlPlaneClient.platformAdmin.getPlatformFinancials.query(),
  );
  const { data: fx, mutate: mutateFx } = useClientDataSWR('aico-fx', () =>
    controlPlaneClient.platformAdmin.getFxRate.query(),
  );
  const { data: usageMultiplier, mutate: mutateUsageMultiplier } = useClientDataSWR(
    'aico-usage-multiplier',
    () => controlPlaneClient.platformAdmin.getUsageMultiplier.query(),
  );
  const { data: master } = useClientDataSWR('aico-platform-master', () =>
    controlPlaneClient.platformAdmin.getMasterAccountStatus.query(),
  );
  const { data: trialConfig, mutate: mutateTrial } = useClientDataSWR('aico-trial-config', () =>
    controlPlaneClient.platformAdmin.getTrialConfig.query(),
  );
  const { data: userWallets, mutate: mutateUserWallets } = useClientDataSWR(
    'aico-user-wallets',
    () => controlPlaneClient.platformAdmin.listUserWallets.query(),
  );
  const { data: modelSync, mutate: mutateModelSync } = useClientDataSWR(
    'aico-openrouter-model-sync',
    () => controlPlaneClient.platformAdmin.getOpenRouterModelSyncStatus.query(),
  );
  const { data: modelSyncHistory, mutate: mutateModelSyncHistory } = useClientDataSWR(
    'aico-openrouter-model-sync-history',
    () => controlPlaneClient.platformAdmin.listOpenRouterModelSyncHistory.query({ limit: 15 }),
  );

  useEffect(() => {
    if (trialConfig) {
      trialForm.setFieldsValue({
        allowedModelIds: (trialConfig.allowedModelIds || []).join(', '),
        durationDays: trialConfig.durationDays,
        enabled: trialConfig.enabled,
        maxRequests: trialConfig.maxRequests,
        // The server carries USD as a decimal *string* (microUsdToDecimalString)
        // while the control is an InputNumber, so convert at the boundary.
        trialBudgetUsd:
          trialConfig.trialBudgetUsd === undefined ? undefined : Number(trialConfig.trialBudgetUsd),
      });
    }
  }, [trialConfig, trialForm]);

  useEffect(() => {
    if (fx?.tomanPerUsd != null) {
      fxForm.setFieldsValue({ tomanPerUsd: fx.tomanPerUsd });
    }
  }, [fx?.tomanPerUsd, fxForm]);

  useEffect(() => {
    if (usageMultiplier?.multiplierBp != null) {
      multiplierForm.setFieldsValue({ multiplier: usageMultiplier.multiplierBp / 10_000 });
    }
  }, [usageMultiplier?.multiplierBp, multiplierForm]);

  if (error) {
    const code = (error as { data?: { code?: string } })?.data?.code;
    // Auth / non-admin should never reach this panel — gate handles those.
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      return null;
    }
    return (
      <Flexbox className={aicoPanelStyles.page} gap={8}>
        <Block className={aicoPanelStyles.section} variant="outlined">
          <Flexbox gap={8}>
            <Text strong>{t('platform.loadErrorTitle')}</Text>
            <Text type="secondary">
              {t('platform.loadErrorDesc', {
                message: (error as Error)?.message || code || 'unknown',
              })}
            </Text>
          </Flexbox>
        </Block>
      </Flexbox>
    );
  }

  return (
    <Flexbox className={aicoPanelStyles.page} gap={20}>
      <Flexbox gap={4}>
        <Flexbox horizontal align="center" gap={8} wrap="wrap">
          <ShieldIcon size={20} />
          <Text strong as="h1" style={{ fontSize: 22, margin: 0 }}>
            {t('platform.title')}
          </Text>
        </Flexbox>
        <Text type="secondary">{t('platform.subtitle')}</Text>
      </Flexbox>

      <div className={aicoPanelStyles.grid}>
        <StatisticCard
          title={t('platform.revenue')}
          statistic={{
            prefix: <WalletIcon size={16} />,
            value: Number(financials?.totalRevenueToman ?? 0).toLocaleString(),
          }}
        />
        <StatisticCard
          title={t('platform.usdCredited')}
          statistic={{
            value: usd(financials?.totalUsdCredited),
          }}
        />
        <StatisticCard
          title={t('platform.b2cWallets')}
          statistic={{
            value: `${financials?.b2cWalletCount ?? 0} / ${usd(financials?.b2cBalanceUsd)}`,
          }}
        />
        <StatisticCard
          title={t('platform.openRouterUsage')}
          statistic={{
            value: usd(financials?.totalOpenRouterCostUsd ?? master?.totalObservedUsageUsd),
          }}
        />
        <StatisticCard
          title={t('platform.multiplierCard')}
          statistic={{
            value: `${((usageMultiplier?.multiplierBp ?? 12_000) / 10_000).toFixed(2)}x`,
          }}
        />
        <StatisticCard
          title={t('platform.fxCard')}
          statistic={{
            value: Number(fx?.tomanPerUsd ?? 0).toLocaleString(),
          }}
        />
      </div>

      <div className={aicoPanelStyles.tabs}>
        <Tabs
          activeKey={tab}
          items={[
            { key: 'overview', label: t('platform.tabs.overview') },
            { key: 'orgs', label: t('platform.tabs.orgs') },
            { key: 'models', label: t('platform.tabs.models') },
            { key: 'trial', label: t('platform.tabs.trial') },
            { key: 'wallets', label: t('platform.tabs.wallets') },
            { key: 'credits', label: t('platform.tabs.credits') },
          ]}
          onChange={setTab}
        />
      </div>

      {tab === 'overview' && (
        <Block className={aicoPanelStyles.section} variant="outlined">
          <Flexbox gap={12}>
            <Text strong>{t('platform.fxTitle')}</Text>
            <Text type="secondary">{t('platform.fxHint', { source: fx?.source ?? '—' })}</Text>
            <Form
              form={fxForm}
              layout="inline"
              onFinish={async (values) => {
                setBusy(true);
                try {
                  await controlPlaneClient.platformAdmin.updateFxRate.mutate({
                    tomanPerUsd: values.tomanPerUsd,
                  });
                  toast.success(t('platform.fxSaved'));
                  await Promise.all([mutateFx(), mutateFinancials()]);
                } catch (err) {
                  toastAicoError(err, t, 'platform.fxFailed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Form.Item
                label={t('platform.fxLabel')}
                name="tomanPerUsd"
                rules={[{ required: true, type: 'number', min: 1 }]}
              >
                <InputNumber
                  {...groupedNumberInputProps}
                  max={10_000_000}
                  min={1}
                  style={{ minWidth: 180 }}
                />
              </Form.Item>
              <Form.Item>
                <Button htmlType="submit" loading={busy} type="primary">
                  {t('platform.fxSave')}
                </Button>
              </Form.Item>
            </Form>
          </Flexbox>
        </Block>
      )}

      {tab === 'overview' && (
        <Block className={aicoPanelStyles.section} variant="outlined">
          <Flexbox gap={12}>
            <Text strong>{t('platform.multiplierTitle')}</Text>
            <Text type="secondary">{t('platform.multiplierHint')}</Text>
            <Form
              form={multiplierForm}
              layout="inline"
              onFinish={async (values) => {
                setBusy(true);
                try {
                  await controlPlaneClient.platformAdmin.updateUsageMultiplier.mutate({
                    multiplierBp: Math.round(values.multiplier * 10_000),
                  });
                  toast.success(t('platform.multiplierSaved'));
                  await mutateUsageMultiplier();
                } catch (err) {
                  toastAicoError(err, t, 'platform.multiplierFailed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Form.Item
                label={t('platform.multiplierLabel')}
                name="multiplier"
                rules={[{ required: true, type: 'number', min: 1, max: 3 }]}
              >
                <InputNumber max={3} min={1} step={0.05} style={{ minWidth: 180 }} />
              </Form.Item>
              <Form.Item>
                <Button htmlType="submit" loading={busy} type="primary">
                  {t('platform.multiplierSave')}
                </Button>
              </Form.Item>
            </Form>
            <Text type="secondary">
              {t('platform.multiplierPreview', {
                value: ((usageMultiplier?.multiplierBp ?? 12_000) / 10_000).toFixed(2),
              })}
            </Text>
          </Flexbox>
        </Block>
      )}

      {tab === 'overview' && (
        <Block className={aicoPanelStyles.section} variant="outlined">
          <Flexbox gap={12}>
            <Text strong>{t('platform.recentTx')}</Text>
            <div className={aicoPanelStyles.tableScroll}>
              <Table
                dataSource={financials?.recentTransactions || []}
                pagination={{ pageSize: 15 }}
                rowKey="id"
                scroll={AICO_TABLE_SCROLL}
                size="middle"
                columns={[
                  { dataIndex: 'type', title: t('wallet.columns.type') },
                  {
                    dataIndex: 'amountUsd',
                    title: t('wallet.columns.usd'),
                    render: (v) => (v == null ? '—' : Number(v).toFixed(4)),
                  },
                  {
                    dataIndex: 'amountToman',
                    title: t('wallet.columns.toman'),
                    render: (v: number) => v?.toLocaleString?.() ?? v,
                  },
                  {
                    dataIndex: 'actorEmail',
                    ellipsis: true,
                    title: t('platform.columns.actor'),
                    render: (v: string | null) => v || '—',
                  },
                  {
                    dataIndex: 'orgName',
                    ellipsis: true,
                    title: t('platform.columns.org'),
                    render: (v: string | null, row: AuditRow) =>
                      v || (row.orgId ? row.orgId.slice(0, 12) : '—'),
                  },
                  {
                    dataIndex: 'userEmail',
                    ellipsis: true,
                    title: t('platform.columns.userId'),
                    render: (v: string | null, row: AuditRow) =>
                      v || (row.userId ? row.userId.slice(0, 12) : '—'),
                  },
                  {
                    dataIndex: 'description',
                    ellipsis: true,
                    title: t('platform.columns.description'),
                    render: (v: string | null) => v || '—',
                  },
                  {
                    dataIndex: 'createdAt',
                    title: t('wallet.columns.date'),
                    render: (v: string | Date) => new Date(v).toLocaleString(),
                  },
                ]}
              />
            </div>
          </Flexbox>
        </Block>
      )}

      {tab === 'orgs' && (
        <Flexbox gap={16}>
          <Block className={aicoPanelStyles.section} variant="outlined">
            <Flexbox gap={16}>
              <Flexbox horizontal align="center" gap={8}>
                <Building2Icon size={18} />
                <Text strong>{t('platform.createOrg')}</Text>
              </Flexbox>
              <Form
                form={createForm}
                layout="vertical"
                onFinish={async (values) => {
                  setBusy(true);
                  try {
                    await controlPlaneClient.platformAdmin.createOrganization.mutate(values);
                    toast.success(t('platform.created'));
                    createForm.resetFields();
                    await mutate();
                  } catch (err) {
                    toastAicoError(err, t, 'platform.createFailed');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <div className={aicoPanelStyles.formRow}>
                  <Form.Item
                    label={t('platform.orgName')}
                    name="name"
                    rules={[{ required: true }]}
                    style={{ flex: 1, minWidth: 200 }}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    label={t('platform.managerEmail')}
                    name="managerEmail"
                    rules={[{ required: true, type: 'email' }]}
                    style={{ flex: 1, minWidth: 220 }}
                  >
                    <Input />
                  </Form.Item>
                </div>
                <Button htmlType="submit" loading={busy} type="primary">
                  {t('platform.createSubmit')}
                </Button>
              </Form>
            </Flexbox>
          </Block>

          <Block className={aicoPanelStyles.section} variant="outlined">
            <Flexbox gap={16}>
              <Text strong>{t('platform.assignManager')}</Text>
              <Form
                form={assignForm}
                initialValues={{ role: 'admin' }}
                layout="vertical"
                onFinish={async (values) => {
                  setBusy(true);
                  try {
                    await controlPlaneClient.platformAdmin.assignManager.mutate(values);
                    toast.success(t('platform.assigned'));
                    await mutate();
                  } catch (err) {
                    toastAicoError(err, t, 'platform.assignFailed');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <div className={aicoPanelStyles.formRow}>
                  <Form.Item
                    label={t('platform.orgId')}
                    name="orgId"
                    rules={[{ required: true }]}
                    style={{ minWidth: 200 }}
                  >
                    <Select
                      style={{ width: '100%' }}
                      options={(data?.items || []).map((o) => ({
                        label: `${o.name}${o.publicCode ? ` · ${o.publicCode}` : ''}`,
                        value: o.id,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item
                    label={t('platform.managerEmail')}
                    name="managerEmail"
                    rules={[{ required: true, type: 'email' }]}
                    style={{ minWidth: 220 }}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    label={t('platform.managerRole')}
                    name="role"
                    style={{ minWidth: 140 }}
                  >
                    <Select
                      options={[
                        { label: 'owner', value: 'owner' },
                        { label: 'admin', value: 'admin' },
                      ]}
                    />
                  </Form.Item>
                </div>
                <Button htmlType="submit" loading={busy} type="primary">
                  {t('platform.assignSubmit')}
                </Button>
              </Form>
            </Flexbox>
          </Block>

          <Block className={aicoPanelStyles.section} variant="outlined">
            <Flexbox gap={12}>
              <Text strong>{t('platform.orgsTitle')}</Text>
              <div className={aicoPanelStyles.tableScroll}>
                <Table
                  dataSource={data?.items || []}
                  loading={isLoading}
                  pagination={false}
                  rowKey="id"
                  scroll={AICO_TABLE_SCROLL}
                  columns={[
                    {
                      dataIndex: 'publicCode',
                      title: t('platform.columns.publicId'),
                      render: (v: string) => (v ? <Tag>{v}</Tag> : '—'),
                    },
                    { dataIndex: 'name', ellipsis: true, title: t('platform.columns.name') },
                    {
                      dataIndex: 'status',
                      title: t('platform.columns.status'),
                      render: (v: string) => (
                        <Tag color={v === 'active' ? 'success' : 'warning'}>{v}</Tag>
                      ),
                    },
                    { dataIndex: 'memberCount', title: t('platform.columns.members') },
                    {
                      dataIndex: 'walletBalanceUsd',
                      title: t('platform.columns.walletUsd'),
                      render: (v) => usd(v),
                    },
                    {
                      key: 'actions',
                      title: t('platform.columns.actions'),
                      render: (_, row) => (
                        <Flexbox horizontal gap={8} wrap="wrap">
                          {row.status === 'active' ? (
                            <Button
                              size="small"
                              onClick={async () => {
                                await controlPlaneClient.platformAdmin.suspendOrganization.mutate({
                                  orgId: row.id,
                                });
                                await mutate();
                              }}
                            >
                              {t('platform.suspend')}
                            </Button>
                          ) : (
                            <Button
                              size="small"
                              onClick={async () => {
                                await controlPlaneClient.platformAdmin.activateOrganization.mutate({
                                  orgId: row.id,
                                });
                                await mutate();
                              }}
                            >
                              {t('platform.activate')}
                            </Button>
                          )}
                          <Button
                            danger
                            size="small"
                            onClick={() =>
                              createBudgetSweepModal({
                                executeSweep: (batchId) =>
                                  controlPlaneClient.platformAdmin.sweepOrgMemberBudgets.mutate({
                                    confirm: true,
                                    idempotencyKey: batchId,
                                    orgId: row.id,
                                  }),
                                loadPreview: () =>
                                  controlPlaneClient.platformAdmin.previewOrgBudgetSweep.query({
                                    orgId: row.id,
                                  }),
                                onCompleted: () => void mutate(),
                                orgName: row.name,
                              })
                            }
                          >
                            {t('org.sweep.open')}
                          </Button>
                        </Flexbox>
                      ),
                    },
                  ]}
                />
              </div>
            </Flexbox>
          </Block>
        </Flexbox>
      )}

      {tab === 'models' && (
        <Block className={aicoPanelStyles.section} variant="outlined">
          <Flexbox gap={16}>
            <Flexbox horizontal align="center" gap={8}>
              <RefreshCwIcon size={18} />
              <Text strong>{t('platform.modelsTitle')}</Text>
            </Flexbox>
            <Text type="secondary">{t('platform.modelsHint')}</Text>
            <div className={aicoPanelStyles.grid}>
              <StatisticCard
                statistic={{ value: modelSync?.modelCount ?? 0 }}
                title={t('platform.modelsCount')}
              />
              <StatisticCard
                title={t('platform.modelsLastSync')}
                statistic={{
                  value: modelSync?.lastSyncedAt
                    ? new Date(modelSync.lastSyncedAt).toLocaleString()
                    : t('platform.modelsNeverSynced'),
                }}
              />
              <StatisticCard
                title={t('platform.modelsStatus')}
                statistic={{
                  value: modelSync?.lastStatus ?? 'never',
                }}
              />
            </div>
            {modelSync?.lastError ? (
              <Text type="danger">
                {t('platform.modelsLastError', { message: modelSync.lastError })}
              </Text>
            ) : null}
            <Button
              loading={busy}
              type="primary"
              onClick={async () => {
                setBusy(true);
                try {
                  await controlPlaneClient.platformAdmin.syncOpenRouterModels.mutate();
                  toast.success(t('platform.modelsSynced'));
                  await Promise.all([mutateModelSync(), mutateModelSyncHistory()]);
                } catch (err) {
                  toastAicoError(err, t, 'platform.modelsSyncFailed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('platform.modelsFetchNow')}
            </Button>
            <Flexbox gap={8}>
              <Text strong>{t('platform.modelsHistory')}</Text>
              {(modelSyncHistory || []).length === 0 ? (
                <Text type="secondary">{t('platform.modelsHistoryEmpty')}</Text>
              ) : (
                (modelSyncHistory || []).map((run) => (
                  <Block className={aicoPanelStyles.section} key={run.id} variant="outlined">
                    <Flexbox gap={8}>
                      <Flexbox
                        horizontal
                        align="center"
                        gap={8}
                        justify="space-between"
                        wrap="wrap"
                      >
                        <Text>
                          {new Date(run.syncedAt).toLocaleString()} · {run.status}
                          {run.triggeredBy ? ` · ${run.triggeredBy}` : ''}
                        </Text>
                        <Text type="secondary">{run.modelCount}</Text>
                      </Flexbox>
                      {run.error ? <Text type="danger">{run.error}</Text> : null}
                      {run.addedModelIds.length === 0 && run.removedModelIds.length === 0 ? (
                        <Text type="secondary">{t('platform.modelsNoDiff')}</Text>
                      ) : (
                        <Flexbox gap={8}>
                          {run.addedModelIds.length > 0 ? (
                            <Flexbox gap={4}>
                              <Text strong>
                                {t('platform.modelsAdded', { count: run.addedModelIds.length })}
                              </Text>
                              <Flexbox horizontal gap={4} wrap="wrap">
                                {run.addedModelIds.slice(0, 40).map((id) => (
                                  <Tag color="success" key={`a-${run.id}-${id}`}>
                                    {id}
                                  </Tag>
                                ))}
                              </Flexbox>
                            </Flexbox>
                          ) : null}
                          {run.removedModelIds.length > 0 ? (
                            <Flexbox gap={4}>
                              <Text strong>
                                {t('platform.modelsRemoved', { count: run.removedModelIds.length })}
                              </Text>
                              <Flexbox horizontal gap={4} wrap="wrap">
                                {run.removedModelIds.slice(0, 40).map((id) => (
                                  <Tag color="warning" key={`r-${run.id}-${id}`}>
                                    {id}
                                  </Tag>
                                ))}
                              </Flexbox>
                            </Flexbox>
                          ) : null}
                        </Flexbox>
                      )}
                    </Flexbox>
                  </Block>
                ))
              )}
            </Flexbox>
          </Flexbox>
        </Block>
      )}

      {tab === 'trial' && (
        <Block className={aicoPanelStyles.section} variant="outlined">
          <Flexbox gap={16}>
            <Text strong>{t('platform.trialTitle')}</Text>
            <Form
              form={trialForm}
              layout="vertical"
              onFinish={async (values) => {
                setBusy(true);
                try {
                  const allowedModelIds = (values.allowedModelIds || '')
                    .split(/[,\n]/)
                    .map((s: string) => s.trim())
                    .filter(Boolean);
                  await controlPlaneClient.platformAdmin.updateTrialConfig.mutate({
                    allowedModelIds,
                    durationDays: values.durationDays,
                    enabled: values.enabled,
                    maxRequests: values.maxRequests ?? null,
                    // updateTrialConfig takes `z.string().optional()` — sending the
                    // raw InputNumber value failed zod validation at runtime.
                    trialBudgetUsd:
                      values.trialBudgetUsd === undefined
                        ? undefined
                        : String(values.trialBudgetUsd),
                  });
                  toast.success(t('platform.trialSaved'));
                  await mutateTrial();
                } catch (err) {
                  toastAicoError(err, t, 'platform.trialFailed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Form.Item label={t('platform.trialEnabled')} name="enabled" valuePropName="checked">
                <Switch />
              </Form.Item>
              <div className={aicoPanelStyles.formRow}>
                <Form.Item
                  label={t('platform.trialDays')}
                  name="durationDays"
                  rules={[{ required: true }]}
                  style={{ minWidth: 160 }}
                >
                  <InputNumber max={90} min={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  label={t('platform.trialMaxRequests')}
                  name="maxRequests"
                  style={{ minWidth: 160 }}
                >
                  <InputNumber {...groupedNumberInputProps} min={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  label={t('platform.trialBudgetUsd')}
                  name="trialBudgetUsd"
                  style={{ minWidth: 160 }}
                >
                  <InputNumber
                    {...groupedNumberInputProps}
                    min={0.01}
                    step={0.1}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </div>
              <Form.Item label={t('platform.trialModels')} name="allowedModelIds">
                <Input.TextArea placeholder="openai/gpt-4o-mini (empty = all)" rows={2} />
              </Form.Item>
              <Button htmlType="submit" loading={busy} type="primary">
                {t('platform.trialSave')}
              </Button>
            </Form>
          </Flexbox>
        </Block>
      )}

      {tab === 'wallets' && (
        <Block className={aicoPanelStyles.section} variant="outlined">
          <Flexbox gap={12}>
            <Text strong>{t('platform.b2cTitle')}</Text>
            <div className={aicoPanelStyles.tableScroll}>
              <Table
                dataSource={userWallets || []}
                pagination={{ pageSize: 20 }}
                rowKey="userId"
                scroll={AICO_TABLE_SCROLL}
                columns={[
                  {
                    dataIndex: 'publicCode',
                    title: t('platform.columns.publicId'),
                    render: (v: string | null) => (v ? <Tag>{v}</Tag> : '—'),
                  },
                  {
                    dataIndex: 'email',
                    ellipsis: true,
                    title: t('platform.columns.email'),
                    render: (v: string | null) => v || '—',
                  },
                  {
                    dataIndex: 'username',
                    ellipsis: true,
                    title: t('platform.columns.username'),
                    render: (v: string | null) => v || '—',
                  },
                  {
                    dataIndex: 'userId',
                    ellipsis: true,
                    title: t('platform.columns.userId'),
                    render: (v: string) => v.slice(0, 14),
                  },
                  {
                    dataIndex: 'balanceUsd',
                    title: t('platform.columns.walletUsd'),
                    render: (v: number) => usd(v),
                  },
                  {
                    dataIndex: 'hasManagedKey',
                    title: t('platform.columns.key'),
                    render: (v: boolean) => (v ? '✓' : '—'),
                  },
                  {
                    dataIndex: 'banned',
                    title: t('platform.columns.status'),
                    render: (banned: boolean, row) =>
                      banned ? (
                        <Tag color="error" title={row.banReason || undefined}>
                          {t('platform.userBanned')}
                        </Tag>
                      ) : (
                        <Tag>{t('platform.userActive')}</Tag>
                      ),
                  },
                  {
                    key: 'actions',
                    title: t('platform.columns.actions'),
                    render: (_, row) => (
                      <Flexbox horizontal gap={4}>
                        <Button
                          size="small"
                          onClick={() => {
                            userCreditForm.setFieldsValue({
                              email: undefined,
                              userId: row.userId,
                            });
                            setTab('credits');
                          }}
                        >
                          {t('platform.creditUserAction')}
                        </Button>
                        {row.banned ? (
                          <Button
                            size="small"
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await controlPlaneClient.platformAdmin.reactivateUser.mutate({
                                  userId: row.userId,
                                });
                                toast.success(t('platform.reactivateSuccess'));
                                await mutateUserWallets();
                              } catch (err) {
                                toastAicoError(err, t, 'platform.reactivateSuccess');
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            {t('platform.reactivateUser')}
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            onClick={() => {
                              deactivateForm.setFieldsValue({ reason: '', userId: row.userId });
                              setTab('credits');
                            }}
                          >
                            {t('platform.deactivateUser')}
                          </Button>
                        )}
                      </Flexbox>
                    ),
                  },
                ]}
              />
            </div>
          </Flexbox>
        </Block>
      )}

      {tab === 'credits' && (
        <Flexbox gap={16}>
          <Block className={aicoPanelStyles.section} variant="outlined">
            <Flexbox gap={16}>
              <Text strong>{t('platform.deactivateUser')}</Text>
              <Form
                form={deactivateForm}
                layout="vertical"
                onFinish={async (values) => {
                  if (!window.confirm(t('platform.deactivateConfirm'))) return;
                  setBusy(true);
                  try {
                    await controlPlaneClient.platformAdmin.deactivateUser.mutate({
                      reason: values.reason,
                      userId: values.userId,
                    });
                    toast.success(t('platform.deactivateSuccess'));
                    deactivateForm.resetFields();
                    await mutateUserWallets();
                  } catch (err) {
                    toastAicoError(err, t, 'platform.deactivateConfirm');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Form.Item
                  label={t('platform.columns.userId')}
                  name="userId"
                  rules={[{ required: true }]}
                >
                  <Select
                    allowClear
                    showSearch
                    style={{ width: '100%' }}
                    options={(userWallets || []).map((w) => ({
                      label: `${w.email || w.username || w.userId}${w.banned ? ` (${t('platform.userBanned')})` : ''}`,
                      value: w.userId,
                    }))}
                  />
                </Form.Item>
                <Form.Item
                  label={t('platform.deactivateReason')}
                  name="reason"
                  rules={[{ message: t('platform.deactivateReasonRequired'), required: true }]}
                >
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Button danger htmlType="submit" loading={busy}>
                  {t('platform.deactivateUser')}
                </Button>
              </Form>
            </Flexbox>
          </Block>

          <Block className={aicoPanelStyles.section} variant="outlined">
            <Flexbox gap={16}>
              <Text strong>{t('platform.manualCredit')}</Text>
              <Text type="secondary">{t('platform.manualCreditHint')}</Text>
              <Form
                form={creditForm}
                layout="vertical"
                onFinish={async (values) => {
                  const payload = resolveFxTopupPayload(values, creditChargeField);
                  if (!payload || !values.orgId) return;
                  creditIdempotencyKeyRef.current ??= uuid();
                  setBusy(true);
                  try {
                    await controlPlaneClient.platformAdmin.addManualCredit.mutate({
                      ...payload,
                      description: values.description,
                      idempotencyKey: creditIdempotencyKeyRef.current,
                      orgId: values.orgId,
                    });
                    toast.success(t('platform.credited'));
                    creditIdempotencyKeyRef.current = null;
                    creditForm.resetFields(['amountToman', 'amountUsd', 'description']);
                    await Promise.all([mutate(), mutateFinancials()]);
                  } catch (err) {
                    toastAicoError(err, t, 'platform.creditFailed');
                  } finally {
                    setBusy(false);
                  }
                }}
                // Editing the form starts a new logical credit, so the held key
                // cannot make the next submit resolve to the previous amount.
                onValuesChange={() => {
                  creditIdempotencyKeyRef.current = null;
                }}
              >
                <Form.Item label={t('platform.orgId')} name="orgId" rules={[{ required: true }]}>
                  <Select
                    style={{ width: '100%' }}
                    options={(data?.items || []).map((o) => ({
                      label: `${o.name}${o.publicCode ? ` · ${o.publicCode}` : ''}`,
                      value: o.id,
                    }))}
                  />
                </Form.Item>
                <FxTopupFields
                  chargeField={creditChargeField}
                  form={creditForm}
                  fxRate={fx?.tomanPerUsd}
                  fxSource={fx?.source}
                  tomanLabelKey="platform.amountToman"
                  tomanMin={1}
                  usdLabelKey="platform.amountUsd"
                  onChargeFieldChange={setCreditChargeField}
                />
                <Form.Item label={t('platform.description')} name="description">
                  <Input />
                </Form.Item>
                <Button htmlType="submit" loading={busy} type="primary">
                  {t('platform.creditSubmit')}
                </Button>
              </Form>
            </Flexbox>
          </Block>

          <Block className={aicoPanelStyles.section} variant="outlined">
            <Flexbox gap={16}>
              <Text strong>{t('platform.manualUserCredit')}</Text>
              <Text type="secondary">{t('platform.manualUserCreditHint')}</Text>
              <Form
                form={userCreditForm}
                layout="vertical"
                onFinish={async (values) => {
                  if (!values.email && !values.userId) {
                    toast.error(t('platform.userCreditTargetRequired'));
                    return;
                  }
                  const payload = resolveFxTopupPayload(values, userCreditChargeField);
                  if (!payload) return;
                  userCreditIdempotencyKeyRef.current ??= uuid();
                  setBusy(true);
                  try {
                    await controlPlaneClient.platformAdmin.addManualUserCredit.mutate({
                      ...payload,
                      description: values.description,
                      email: values.email || undefined,
                      idempotencyKey: userCreditIdempotencyKeyRef.current,
                      userId: values.userId || undefined,
                    });
                    toast.success(t('platform.userCredited'));
                    userCreditIdempotencyKeyRef.current = null;
                    userCreditForm.resetFields(['amountToman', 'amountUsd', 'description']);
                    await Promise.all([mutateUserWallets(), mutateFinancials()]);
                  } catch (err) {
                    toastAicoError(err, t, 'platform.userCreditFailed');
                  } finally {
                    setBusy(false);
                  }
                }}
                onValuesChange={() => {
                  userCreditIdempotencyKeyRef.current = null;
                }}
              >
                <div className={aicoPanelStyles.formRow}>
                  <Form.Item
                    label={t('platform.userEmail')}
                    name="email"
                    rules={[{ type: 'email' }]}
                    style={{ flex: 1, minWidth: 220 }}
                  >
                    <Input placeholder={t('platform.userEmailPlaceholder')} />
                  </Form.Item>
                  <Form.Item
                    label={t('platform.userId')}
                    name="userId"
                    style={{ flex: 1, minWidth: 200 }}
                  >
                    <Select
                      allowClear
                      showSearch
                      placeholder={t('platform.userIdPlaceholder')}
                      style={{ width: '100%' }}
                      options={(userWallets || []).map((w) => ({
                        label: `${w.email || w.username || (w.publicCode ? `${w.publicCode} · ` : '') + w.userId.slice(0, 14)} · ${usd(w.balanceUsd)}`,
                        value: w.userId,
                      }))}
                    />
                  </Form.Item>
                </div>
                <FxTopupFields
                  chargeField={userCreditChargeField}
                  form={userCreditForm}
                  fxRate={fx?.tomanPerUsd}
                  fxSource={fx?.source}
                  tomanLabelKey="platform.amountToman"
                  tomanMin={1}
                  usdLabelKey="platform.amountUsd"
                  onChargeFieldChange={setUserCreditChargeField}
                />
                <Form.Item label={t('platform.description')} name="description">
                  <Input />
                </Form.Item>
                <Button htmlType="submit" loading={busy} type="primary">
                  {t('platform.userCreditSubmit')}
                </Button>
              </Form>
            </Flexbox>
          </Block>
        </Flexbox>
      )}
    </Flexbox>
  );
};

export default PlatformAdminPanel;
