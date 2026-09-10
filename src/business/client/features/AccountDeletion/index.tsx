'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { Input } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { lambdaClient } from '@/libs/trpc/client';

export default function AccountDeletion() {
  const { t } = useTranslation('setting');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const confirmEmail = email.trim();

  const handleDelete = async () => {
    setBusy(true);
    try {
      await lambdaClient.accountDeletion.requestDeletion.mutate({ confirmEmail });
      toast.success(t('accountDeletion.deleted'));
      window.location.href = '/signin';
    } catch (err) {
      // The server rejects a confirmation that doesn't match the stored email with
      // EMAIL_MISMATCH — surface that as guidance rather than the raw TRPC message.
      const message = err instanceof Error ? err.message : '';
      toast.error(
        message.includes('EMAIL_MISMATCH')
          ? t('accountDeletion.emailMismatch')
          : t('accountDeletion.requestFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flexbox gap={12} style={{ maxWidth: 420 }}>
      <Text strong>{t('accountDeletion.title')}</Text>
      <Text type="secondary">
        Deleting your account blocks reusing the same phone/email for another free trial.
      </Text>
      <Input
        placeholder={t('accountDeletion.emailPlaceholder')}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Button
        danger
        disabled={!confirmEmail}
        loading={busy}
        onClick={() =>
          confirmModal({
            // Deliberately NOT `accountDeletion.confirmContent` — that copy promises a
            // 72-hour cooling-off period this procedure doesn't implement; it deletes now.
            content: t('accountDeletion.immediateConfirmContent'),
            okButtonProps: { danger: true },
            okText: t('accountDeletion.confirmOk'),
            onOk: handleDelete,
            title: t('accountDeletion.confirmTitle'),
          })
        }
      >
        {t('accountDeletion.confirmOk')}
      </Button>
    </Flexbox>
  );
}
