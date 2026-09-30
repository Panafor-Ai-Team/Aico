import { describe, expect, it } from 'vitest';

import { MODEL_SWITCH_PANEL_DEFAULTS } from './defaults';

describe('MODEL_SWITCH_PANEL_DEFAULTS', () => {
  it('opens on click and places the panel below the trigger', () => {
    expect(MODEL_SWITCH_PANEL_DEFAULTS.openOnHover).toBe(false);
    expect(MODEL_SWITCH_PANEL_DEFAULTS.placement).toBe('bottomLeft');
  });
});
