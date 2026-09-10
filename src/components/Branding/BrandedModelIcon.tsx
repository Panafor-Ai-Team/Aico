'use client';

import { ModelIcon } from '@lobehub/icons';
import { type CSSProperties, memo } from 'react';

import { ProductLogo } from '@/components/Branding/ProductLogo';

import { isBrandedOpenRouterModelId } from './brandedModelId';

type BrandedModelIconProps = {
  model: string;
  size?: number;
  /** Forwarded to the rendered icon — call sites use it for layout/spacing. */
  style?: CSSProperties;
  type?: 'mono' | 'color' | 'avatar';
};

/**
 * Model avatar that swaps OpenRouter-namespace models (`openrouter/...`)
 * to the product favicon when custom branding is on.
 */
export const BrandedModelIcon = memo<BrandedModelIconProps>(({ model, size = 32, style, type }) => {
  if (isBrandedOpenRouterModelId(model)) {
    return (
      <ProductLogo
        size={size}
        style={{ flex: 'none', height: size, width: size, ...style }}
        type={type === 'mono' ? 'mono' : 'flat'}
      />
    );
  }

  return <ModelIcon model={model} size={size} style={style} type={type} />;
});

BrandedModelIcon.displayName = 'BrandedModelIcon';
