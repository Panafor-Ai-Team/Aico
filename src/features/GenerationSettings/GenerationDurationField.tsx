'use client';

import { Flexbox } from '@lobehub/ui';
import { Segmented, Slider } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';

import { resolveDurationControl } from './durationControl';

const styles = createStaticStyles(({ css, cssVar }) => ({
  bound: css`
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
  `,
  label: css`
    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
  `,
  slider: css`
    cursor: pointer;
    flex: 1;

    /* Track + thumb: grab/pointer, never the text I-beam. */
    * {
      cursor: pointer;
    }

    [data-slot='thumb'],
    [role='slider'] {
      cursor: grab;
    }

    &:active [data-slot='thumb'],
    &:active [role='slider'] {
      cursor: grabbing;
    }
  `,
  value: css`
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorText};
  `,
}));

interface GenerationDurationFieldProps {
  disabled?: boolean;
  /** Renders a length for display, e.g. `6` → `6s`. */
  formatValue: (seconds: string) => string;
  label: string;
  onChange: (seconds: string) => void;
  /** Accepted lengths in seconds, ascending. */
  options: string[];
  value: string;
}

/** Video length picker on a generation confirm card. */
const GenerationDurationField = memo<GenerationDurationFieldProps>(
  ({ disabled, formatValue, label, onChange, options, value }) => {
    const control = resolveDurationControl(options.length);
    const index = Math.max(0, options.indexOf(value));

    return (
      <Flexbox gap={6} style={{ flexBasis: '100%' }}>
        <Flexbox horizontal align={'center'} justify={'space-between'}>
          <div className={styles.label}>{label}</div>
          {control !== 'segmented' && <div className={styles.value}>{formatValue(value)}</div>}
        </Flexbox>

        {control === 'segmented' && (
          <Segmented
            block
            disabled={disabled}
            options={options.map((seconds) => ({ label: formatValue(seconds), value: seconds }))}
            size={'small'}
            value={value}
            onChange={onChange}
          />
        )}

        {control === 'slider' && (
          // Base UI Slider pointer math defaults to LTR (no DirectionProvider), but
          // under document dir=rtl the thumb uses inset-inline-start so CSS mirrors
          // it — drag left/right then moves the value the wrong way. Keep the whole
          // row LTR: min on the left, max on the right, drag matches motion.
          <Flexbox horizontal align={'center'} dir={'ltr'} gap={10}>
            <span className={styles.bound}>{formatValue(options[0])}</span>
            <Slider
              className={styles.slider}
              disabled={disabled}
              max={options.length - 1}
              min={0}
              step={1}
              value={index}
              onChange={(next) => {
                const seconds = options[next];
                if (seconds !== undefined) onChange(seconds);
              }}
            />
            <span className={styles.bound}>{formatValue(options.at(-1)!)}</span>
          </Flexbox>
        )}
      </Flexbox>
    );
  },
);

GenerationDurationField.displayName = 'GenerationDurationField';

export default GenerationDurationField;
