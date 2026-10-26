import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ModelItemRender } from '@/components/ModelSelect';

import { getRowCoefficient } from '../../rowCoefficient';
import { type ModelWithProviders } from '../../types';

interface SingleProviderModelItemProps {
  data: ModelWithProviders;
  newLabel: string;
  proBadgeLabel?: string;
  showInfoTag?: boolean;
}

export const SingleProviderModelItem = memo<SingleProviderModelItemProps>(
  ({ data, newLabel, proBadgeLabel, showInfoTag }) => {
    const { t } = useTranslation('components');
    const coefficient = getRowCoefficient(data.model.pricing, data.providers[0]?.id, data.model.id);

    return (
      <ModelItemRender
        {...data.model}
        {...data.model.abilities}
        coefficientLabel={coefficient?.label}
        newBadgeLabel={newLabel}
        proBadgeLabel={proBadgeLabel}
        showInfoTag={showInfoTag}
        coefficientWarning={
          coefficient?.billedTwice
            ? t('ModelSwitchPanel.detail.pricing.reasoningBilledTwiceHint')
            : undefined
        }
      />
    );
  },
);

SingleProviderModelItem.displayName = 'SingleProviderModelItem';
