'use client';

/**
 * Admin-side reductions: take unspent money back from a personal wallet (a
 * ledgered `manual_debit` that also shrinks the live key), and re-mint managed
 * keys after the provider's secret format changes.
 */
import { uuid } from '@lobechat/utils';
import { Block, Flexbox, Text } from '@lobehub/ui';
import { Button, confirmModal, Select, toast } from '@lobehub/ui/base-ui';
import { Form, Input, InputNumber } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toastAicoError } from '@/business/client/resolveAicoErrorMessage';
import { aicoPanelStyles } from '@/features/AicoPanels';
import { controlPlaneClient } from '@/libs/trpc/client/controlPlane';

interface WalletOption {
  availableUsd: string;
  balanceUsd: string;
  email: string | null;
  userId: string;
  username: string | null;
}

interface UserDebitSectionProps {
  onChanged: () => Promise<unknown>;
  wallets: WalletOption[];
}

const usd = (n: number | string) => `$${Number(n).toFixed(2)}`;

export const UserDebitSection = ({ wallets, onChanged }: UserDebitSectionProps) => {
  const { t } = useTranslation('aico');
  const [form] = Form.useForm<{ amountUsd?: number; description?: string; userId?: string }>();
  const [busy, setBusy] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  // Held across a failed attempt so a retry resolves to the same debit.
  const idempotencyKeyRef = useRef<string | null>(null);
  const selectedId = Form.useWatch('userId', form);
  const selected = wallets.find((w) => w.userId === selectedId);

  const submit = (values: { amountUsd?: number; description?: string; userId?: string }) => {
    if (!values.userId || !values.amountUsd || !selected) return;
    const amountUsd = values.amountUsd.toFixed(6);
    const after = Math.max(0, Number(selected.availableUsd) - values.amountUsd);
    confirmModal({
      content: t('platform.debit.confirm', {
        after: usd(after),
        amount: usd(amountUsd),
        available: usd(selected.availableUsd),
        user: selected.email || selected.username || selected.userId,
      }),
      okButtonProps: { danger: true },
      okText: t('platform.debit.submit'),
      onOk: async () => {
        idempotencyKeyRef.current ??= uuid();
        setBusy(true);
        try {
          const result = await controlPlaneClient.platformAdmin.addManualUserDebit.mutate({
            amountUsd,
            description: values.description!,
            idempotencyKey: idempotencyKeyRef.current,
            userId: values.userId,
          });
          idempotencyKeyRef.current = null;
          toast.success(
            t('platform.debit.done', {
              available: usd(result.wallet.availableUsd),
              key: result.keyStatus,
            }),
          );
          form.resetFields(['amountUsd', 'description']);
          await onChanged();
        } catch (err) {
          toastAicoError(err, t, 'platform.debit.failed');
        } finally {
          setBusy(false);
        }
      },
      title: t('platform.debit.confirmTitle'),
    });
  };

  const reissueAll = () =>
    confirmModal({
      content: t('platform.reissue.confirm'),
      okText: t('platform.reissue.submit'),
      onOk: async () => {
        setReissuing(true);
        try {
          const results = await controlPlaneClient.platformAdmin.reissueManagedKeys.mutate({
            scope: 'all',
          });
          const failed = results.filter((r) => r.status === 'error' || r.status === 'ambiguous');
          const summary = t('platform.reissue.done', {
            failed: failed.length,
            total: results.length,
          });
          if (failed.length > 0) toast.error(summary);
          else toast.success(summary);
          await onChanged();
        } catch (err) {
          toastAicoError(err, t, 'platform.reissue.failed');
        } finally {
          setReissuing(false);
        }
      },
      title: t('platform.reissue.title'),
    });

  return (
    <>
      <Block className={aicoPanelStyles.section} variant="outlined">
        <Flexbox gap={16}>
          <Text strong>{t('platform.debit.title')}</Text>
          <Text type="secondary">{t('platform.debit.hint')}</Text>
          <Form
            form={form}
            layout="vertical"
            onFinish={submit}
            onValuesChange={() => {
              idempotencyKeyRef.current = null;
            }}
          >
            <Form.Item label={t('platform.userId')} name="userId" rules={[{ required: true }]}>
              <Select
                showSearch
                placeholder={t('platform.userIdPlaceholder')}
                style={{ width: '100%' }}
                options={wallets.map((w) => ({
                  label: `${w.email || w.username || w.userId.slice(0, 14)} · ${t('platform.debit.available', { amount: usd(w.availableUsd) })}`,
                  value: w.userId,
                }))}
              />
            </Form.Item>
            <Form.Item
              label={t('platform.amountUsd')}
              name="amountUsd"
              rules={[
                { required: true, type: 'number', min: 0.000_001 },
                {
                  validator: async (_, value?: number) => {
                    if (selected && value && value > Number(selected.availableUsd)) {
                      throw new Error(t('platform.debit.tooMuch'));
                    }
                  },
                },
              ]}
            >
              <InputNumber
                max={1_000_000}
                min={0}
                precision={6}
                step={0.01}
                style={{ width: 200 }}
              />
            </Form.Item>
            <Form.Item
              label={t('platform.description')}
              name="description"
              rules={[{ required: true, whitespace: true }]}
            >
              <Input />
            </Form.Item>
            <Button danger htmlType="submit" loading={busy}>
              {t('platform.debit.submit')}
            </Button>
          </Form>
        </Flexbox>
      </Block>

      <Block className={aicoPanelStyles.section} variant="outlined">
        <Flexbox gap={12}>
          <Text strong>{t('platform.reissue.title')}</Text>
          <Text type="secondary">{t('platform.reissue.hint')}</Text>
          <div>
            <Button loading={reissuing} onClick={reissueAll}>
              {t('platform.reissue.submit')}
            </Button>
          </div>
        </Flexbox>
      </Block>
    </>
  );
};
