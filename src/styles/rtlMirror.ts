import { createStaticStyles } from 'antd-style';

/**
 * Mirrors a directional icon (e.g. lucide `PanelLeftClose` / `PanelRightOpen`)
 * horizontally when the element sits in an RTL document, so the panel bar and
 * arrowhead follow the reading direction instead of the LTR artwork.
 *
 * Apply the class to the element that wraps the `<svg>` (e.g. `ActionIcon`).
 */
export const rtlMirrorStyles = createStaticStyles(({ css }) => ({
  icon: css`
    &:dir(rtl) svg {
      transform: scaleX(-1);
    }
  `,
}));
