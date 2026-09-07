import { BRANDING_NAME } from '@lobechat/business-const';
import { uniqBy } from 'es-toolkit/compat';
import { LayoutPanelTopIcon } from 'lucide-react';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { BrandedProviderIcon } from '@/components/Branding/BrandedProviderIcon';
import { isCustomBranding } from '@/const/version';

const isBrandedCategoryProvider = (id: string) =>
  isCustomBranding &&
  (id === 'openrouter' || id === 'aico' || id.trim().toLowerCase() === 'lobehub');

export const useCategory = () => {
  const { t } = useTranslation('discover');

  const items = useMemo(
    () =>
      uniqBy(DEFAULT_MODEL_PROVIDER_LIST, (item) => item.id).map((item) => {
        return {
          icon: <BrandedProviderIcon provider={item.id} size={18} type={'mono'} />,
          key: item.id,
          label: isBrandedCategoryProvider(item.id) ? BRANDING_NAME : item.name,
        };
      }),
    [],
  );

  return useMemo(
    () => [
      {
        icon: LayoutPanelTopIcon,
        key: 'all',
        label: t('mcp.categories.all.name'),
      },
      ...items,
    ],
    [t, items],
  );
};

export const useCategoryItem = (key?: string) => {
  const items = useCategory();
  if (!key) return;
  return items.find((item) => item.key === key);
};
