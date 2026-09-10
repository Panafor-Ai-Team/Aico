'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, useModalContext } from '@lobehub/ui/base-ui';
import { Input } from 'antd';
import { createStaticStyles } from 'antd-style';
import { type FC, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SweepPreviewTable } from './SweepPreviewTable';
import { SweepResultTable } from './SweepResultTable';
import type { SweepPreview, SweepResult } from './types';

const styles = createStaticStyles(({ css, cssVar }) => ({
  warning: css`
    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorErrorBorder};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorErrorBg};
  `,
}));

const newBatchId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `sweep-${crypto.randomUUID()}`
    : `sweep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export interface BudgetSweepModalContentProps {
  /** Runs the sweep. The batch id doubles as the idempotency key. */
  executeSweep: (batchId: string) => Promise<SweepResult>;
  /** Read-only dry run; must not disable any key. */
  loadPreview: () => Promise<SweepPreview>;
  /** Called once a sweep has completed, so the host panel can refresh balances. */
  onCompleted?: () => void;
  orgName: string;
}

/**
 * Two-step gate for a whole-roster, money-moving action: show exactly what will
 * move, then require the org name to be typed before it runs. Mirrors the
 * existing org-deletion gate so the confirmation feel is consistent.
 */
export const BudgetSweepModalContent: FC<BudgetSweepModalContentProps> = ({
  executeSweep,
  loadPreview,
  onCompleted,
  orgName,
}) => {
  const { t } = useTranslation('aico');
  const { close } = useModalContext();

  const [preview, setPreview] = useState<SweepPreview | null>(null);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  /** Stable across retries so a failed-then-retried sweep is not counted twice. */
  const batchIdRef = useRef<string>(newBatchId());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadPreview()
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await executeSweep(batchIdRef.current));
      onCompleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const nothingToReclaim = preview?.rows.every((row) => Number(row.reclaimUsd) === 0) ?? false;

  if (result) {
    return (
      <Flexbox gap={16} paddingBlock={8} width={'100%'}>
        <SweepResultTable result={result} />
        <Flexbox horizontal gap={8} justify={'flex-end'} width={'100%'}>
          <Button type="primary" onClick={() => close()}>
            {t('org.sweep.done')}
          </Button>
        </Flexbox>
      </Flexbox>
    );
  }

  return (
    <Flexbox gap={16} paddingBlock={8} width={'100%'}>
      <Text type="secondary">{t('org.sweep.description')}</Text>

      {loading && <Text type="secondary">{t('org.sweep.loading')}</Text>}
      {error && <Text type="danger">{error}</Text>}

      {preview && (
        <>
          <SweepPreviewTable preview={preview} />

          {nothingToReclaim ? (
            <Text type="secondary">{t('org.sweep.nothingToReclaim')}</Text>
          ) : (
            <Flexbox className={styles.warning} gap={8}>
              <Text strong>{t('org.sweep.warningTitle')}</Text>
              <Text type="secondary">{t('org.sweep.warningBody')}</Text>
              <Text type="secondary">{t('org.sweep.confirmLabel', { name: orgName })}</Text>
              <Input
                disabled={running}
                placeholder={orgName}
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
              />
            </Flexbox>
          )}

          <Flexbox horizontal gap={8} justify={'flex-end'} width={'100%'}>
            <Button disabled={running} type="default" onClick={() => close()}>
              {t(nothingToReclaim ? 'org.sweep.done' : 'org.sweep.cancel')}
            </Button>
            {/* Hidden rather than disabled when there is nothing to sweep: a
                danger button that can never enable reads as a broken control. */}
            {!nothingToReclaim && (
              <Button
                danger
                disabled={running || confirmName !== orgName}
                loading={running}
                type="primary"
                onClick={() => void handleRun()}
              >
                {t('org.sweep.submit')}
              </Button>
            )}
          </Flexbox>
        </>
      )}
    </Flexbox>
  );
};
