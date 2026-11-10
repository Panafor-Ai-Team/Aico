'use client';

import { Flexbox } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';

const styles = createStaticStyles(({ css, cssVar }) => ({
  label: css`
    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
  `,
  select: css`
    width: 100%;
  `,
}));

export interface GenerationSettingOption {
  label: string;
  value: string;
}

interface GenerationSettingFieldProps {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  options: GenerationSettingOption[];
  value: string;
}

/** One labelled choice (quality, size, duration…) on a generation confirm card. */
const GenerationSettingField = memo<GenerationSettingFieldProps>(
  ({ disabled, label, onChange, options, value }) => (
    <Flexbox flex={1} gap={4} style={{ minWidth: 120 }}>
      <div className={styles.label}>{label}</div>
      <Select
        className={styles.select}
        disabled={disabled}
        options={options}
        size={'small'}
        value={value}
        variant={'filled'}
        onChange={(next: unknown) => {
          if (typeof next === 'string') onChange(next);
        }}
      />
    </Flexbox>
  ),
);

GenerationSettingField.displayName = 'GenerationSettingField';

export default GenerationSettingField;
