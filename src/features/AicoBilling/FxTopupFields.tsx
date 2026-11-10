'use client';

// eslint-disable-next-line no-restricted-imports -- Text/Tag not in base-ui yet
import { Text } from '@lobehub/ui';
import { Form, InputNumber } from 'antd';
import { type FormInstance } from 'antd/es/form';
import { createStaticStyles } from 'antd-style';
import { useTranslation } from 'react-i18next';

import { formatPiTokens } from '@/features/AicoBilling/piToken';
import { type LooseTFunction } from '@/types/looseTranslation';

import { groupedNumberInputProps } from './groupedNumberInput';

export type FxTopupChargeField = 'toman' | 'usd';

export interface FxTopupFormValues {
  amountToman?: number;
  amountUsd?: number;
}

export const resolveFxTopupPayload = (
  values: FxTopupFormValues,
  chargeField: FxTopupChargeField = 'toman',
): { amountToman: number } | { amountUsd: string } | null => {
  if (chargeField === 'usd' && values.amountUsd != null && values.amountUsd > 0) {
    return { amountUsd: Number(values.amountUsd).toFixed(6) };
  }
  if (values.amountToman != null && values.amountToman > 0) {
    return { amountToman: values.amountToman };
  }
  return null;
};

const previewPiFromToman = (
  toman: number | undefined,
  tomanPerUsd: number | undefined,
  piPerUsd: number | undefined,
): string => {
  if (!toman || !tomanPerUsd || !piPerUsd) return '—';
  return formatPiTokens(Math.floor((toman / tomanPerUsd) * piPerUsd));
};

const previewPiFromUsd = (usd: number | undefined, piPerUsd: number | undefined): string => {
  if (!usd || !piPerUsd) return '—';
  return formatPiTokens(Math.floor(usd * piPerUsd));
};

const styles = createStaticStyles(({ css, cssVar }) => ({
  fxBanner: css`
    display: flex;
    gap: 8px;
    align-items: baseline;
    justify-content: space-between;

    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};
  `,
  fxRate: css`
    font-size: 15px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorText};
  `,
  fxSource: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  row: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;

    @media (width <= 520px) {
      grid-template-columns: 1fr;
    }
  `,
}));

interface FxTopupFieldsProps {
  /** When true, show USD field too (platform/org admin credits). Default: toman only. */
  allowUsd?: boolean;
  chargeField?: FxTopupChargeField;
  disabled?: boolean;
  form: FormInstance<FxTopupFormValues>;
  fxRate?: number;
  fxSource?: string;
  onChargeFieldChange?: (field: FxTopupChargeField) => void;
  piPerUsd?: number;
  tomanLabelKey?: string;
  tomanMin?: number;
  usdLabelKey?: string;
  usdMin?: number;
}

export const FxTopupFields = ({
  allowUsd = false,
  chargeField = 'toman',
  disabled = false,
  form,
  fxRate,
  fxSource,
  onChargeFieldChange,
  piPerUsd,
  tomanMin = 1000,
  usdMin = 0.01,
  tomanLabelKey = 'wallet.amountToman',
  usdLabelKey = 'wallet.amountUsd',
}: FxTopupFieldsProps) => {
  const { t } = useTranslation('aico');
  const translate = t as LooseTFunction;
  const amountToman = Form.useWatch('amountToman', form);
  const amountUsd = Form.useWatch('amountUsd', form);

  return (
    <>
      <div className={styles.fxBanner}>
        <span className={styles.fxRate}>
          {t('wallet.fxHintPi', {
            pi: (piPerUsd ?? 0).toLocaleString(),
            rate: fxRate?.toLocaleString() ?? '—',
          })}
        </span>
        {fxSource ? <span className={styles.fxSource}>{fxSource}</span> : null}
      </div>
      {allowUsd ? (
        <div className={styles.row}>
          <Form.Item
            label={translate(tomanLabelKey)}
            name="amountToman"
            style={{ marginBottom: 0 }}
          >
            <InputNumber
              {...groupedNumberInputProps}
              disabled={disabled}
              min={tomanMin}
              step={1000}
              style={{ width: '100%' }}
              onChange={(value) => {
                onChargeFieldChange?.('toman');
                if (value != null && fxRate) {
                  form.setFieldValue('amountUsd', Number((Number(value) / fxRate).toFixed(6)));
                }
              }}
            />
          </Form.Item>
          <Form.Item label={translate(usdLabelKey)} name="amountUsd" style={{ marginBottom: 0 }}>
            <InputNumber
              {...groupedNumberInputProps}
              disabled={disabled}
              min={usdMin}
              step={0.5}
              style={{ width: '100%' }}
              onChange={(value) => {
                onChargeFieldChange?.('usd');
                if (value != null && fxRate) {
                  form.setFieldValue('amountToman', Math.floor(Number(value) * fxRate));
                }
              }}
            />
          </Form.Item>
        </div>
      ) : (
        <Form.Item label={translate(tomanLabelKey)} name="amountToman" style={{ marginBottom: 0 }}>
          <InputNumber
            {...groupedNumberInputProps}
            disabled={disabled}
            min={tomanMin}
            step={1000}
            style={{ width: '100%' }}
          />
        </Form.Item>
      )}
      <Text type="secondary">
        {t('wallet.previewPi', {
          pi:
            allowUsd && chargeField === 'usd'
              ? previewPiFromUsd(amountUsd, piPerUsd)
              : previewPiFromToman(amountToman, fxRate, piPerUsd),
        })}
      </Text>
    </>
  );
};
