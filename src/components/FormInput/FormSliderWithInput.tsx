import { type SliderWithInputProps } from '@lobehub/ui';
import { SliderWithInput } from '@lobehub/ui';
import { memo } from 'react';

import { useClampedSliderValue } from './useClampedSliderValue';

interface FormSliderWithInputProps extends Omit<SliderWithInputProps, 'onChange' | 'value'> {
  onChange?: (value: number) => void;
  value?: number;
}

/**
 * Form-integrated slider with delayed onChange behavior.
 * Only triggers onChange on blur to prevent excessive updates during user interaction.
 * The value stays clamped to [min, max] (see `useClampedSliderValue`).
 */
const FormSliderWithInput = memo<FormSliderWithInputProps>(
  ({ onChange, value: defaultValue, min, max, ...props }) => {
    const [value, setValue] = useClampedSliderValue(defaultValue, min, max);

    return (
      <SliderWithInput
        onBlur={() => {
          onChange?.(value);
        }}
        onChange={(newValue) => {
          if (typeof newValue === 'number') {
            setValue(newValue);
          }
        }}
        {...props}
        max={max}
        min={min}
        value={value}
      />
    );
  },
);

FormSliderWithInput.displayName = 'FormSliderWithInput';

export default FormSliderWithInput;
