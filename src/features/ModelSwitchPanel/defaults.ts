import type { DropdownPlacement } from '@lobehub/ui';

/**
 * Composer-facing defaults for ModelSwitchPanel.
 *
 * Click-to-open avoids the hover/click race (hover opens, click immediately
 * closes). bottomLeft matches thinking-level Select, mode pickers, and the
 * wallet switcher so every composer menu opens downward.
 */
export const MODEL_SWITCH_PANEL_DEFAULTS = {
  openOnHover: false,
  placement: 'bottomLeft' as DropdownPlacement,
} as const;
