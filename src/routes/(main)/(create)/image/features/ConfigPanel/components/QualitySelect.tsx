import { Select } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useGenerationConfigParam } from '@/store/image/slices/generationConfig/hooks';

import { qualityLabelKey } from './qualityLabelKey';

const QualitySelect = memo(() => {
  const { t } = useTranslation('image');
  const { value, setValue, enumValues } = useGenerationConfigParam('quality');

  const options = useMemo(
    () =>
      enumValues?.map((quality) => {
        const key = qualityLabelKey(quality);
        return {
          label: key ? t(key, { defaultValue: quality }) : quality,
          value: quality,
        };
      }) ?? [],
    [enumValues, t],
  );

  return <Select options={options} style={{ width: '100%' }} value={value} onChange={setValue} />;
});

export default QualitySelect;
