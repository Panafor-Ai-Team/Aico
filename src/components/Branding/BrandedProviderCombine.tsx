'use client';

import { ProviderCombine } from '@lobehub/icons';
import { type ComponentProps, memo } from 'react';

import { ProductLogo } from '@/components/Branding/ProductLogo';
import { isCustomBranding } from '@/const/version';

import { isBrandedOpenRouterProvider } from './brandedModelId';

type BrandedProviderCombineProps = ComponentProps<typeof ProviderCombine> & {
  provider?: string;
  size?: number;
};

/**
 * Provider wordmark that swaps managed (`openrouter`/`aico`) and legacy
 * `lobehub` ids to the product logo when custom branding is on.
 * Every other provider keeps its own vendor wordmark.
 */
export const BrandedProviderCombine = memo<BrandedProviderCombineProps>(
  // `type` is pulled out of rest: ProviderCombine accepts 'color', which
  // ProductLogo does not, and forwarding it would also override the 'flat' we
  // deliberately pass below.
  ({ provider, size = 24, type: _type, ...rest }) => {
    const branded =
      isBrandedOpenRouterProvider(provider) ||
      Boolean(isCustomBranding && provider && provider.trim().toLowerCase() === 'lobehub');

    if (branded) {
      return <ProductLogo size={size} type={'flat'} {...rest} />;
    }

    return <ProviderCombine provider={provider} size={size} {...rest} />;
  },
);

BrandedProviderCombine.displayName = 'BrandedProviderCombine';
