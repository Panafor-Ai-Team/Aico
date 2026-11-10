'use client';

import { ProviderIcon } from '@lobehub/icons';
import { type ComponentProps, memo } from 'react';

import { ProductLogo } from '@/components/Branding/ProductLogo';
import { isCustomBranding } from '@/const/version';

import { isBrandedOpenRouterProvider } from './brandedModelId';

type BrandedProviderIconProps = ComponentProps<typeof ProviderIcon> & {
  provider?: string;
  size?: number;
};

/**
 * Provider avatar that swaps managed (`openrouter`/`aico`) and legacy
 * `lobehub` ids to the product logo when custom branding is on.
 * Every other provider keeps its own vendor logo — the OpenRouter mark is
 * never rendered.
 */
export const BrandedProviderIcon = memo<BrandedProviderIconProps>(
  ({ provider, size = 24, type, shape, ...rest }) => {
    const branded =
      isBrandedOpenRouterProvider(provider) ||
      Boolean(isCustomBranding && provider && provider.trim().toLowerCase() === 'lobehub');

    if (branded) {
      return <ProductLogo size={size} type={type === 'mono' ? 'mono' : 'flat'} {...rest} />;
    }

    return <ProviderIcon provider={provider} shape={shape} size={size} type={type} {...rest} />;
  },
);

BrandedProviderIcon.displayName = 'BrandedProviderIcon';
