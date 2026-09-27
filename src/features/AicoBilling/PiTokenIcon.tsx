import type { CSSProperties } from 'react';
import { memo } from 'react';

import { formatPiAmount } from './piToken';

export const PI_TOKEN_ICON_SRC = '/images/aico/pi-token.webp';

interface PiTokenIconProps {
  className?: string;
  size?: number;
  style?: CSSProperties;
}

export const PiTokenIcon = memo<PiTokenIconProps>(({ className, size = 14, style }) => (
  <img
    alt="π"
    className={className}
    draggable={false}
    height={size}
    src={PI_TOKEN_ICON_SRC}
    width={size}
    style={{
      display: 'inline-block',
      flexShrink: 0,
      objectFit: 'contain',
      verticalAlign: 'middle',
      ...style,
    }}
  />
));

PiTokenIcon.displayName = 'PiTokenIcon';

interface PiAmountProps {
  className?: string;
  iconSize?: number;
  style?: CSSProperties;
  value: number | string | null | undefined;
}

export const PiAmount = memo<PiAmountProps>(({ className, iconSize, style, value }) => (
  <span
    className={className}
    style={{
      alignItems: 'center',
      display: 'inline-flex',
      fontVariantNumeric: 'tabular-nums',
      gap: 4,
      ...style,
    }}
  >
    {formatPiAmount(value)}
    <PiTokenIcon size={iconSize} />
  </span>
));

PiAmount.displayName = 'PiAmount';
