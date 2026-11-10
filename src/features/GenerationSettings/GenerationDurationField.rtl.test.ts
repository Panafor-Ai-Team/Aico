import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regression: under document dir=rtl, Base UI Slider still uses LTR pointer
 * math (no DirectionProvider), while inset-inline-start mirrors the thumb —
 * so drag left/right moves the duration the wrong way unless the row is LTR.
 */
describe('GenerationDurationField RTL slider', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'GenerationDurationField.tsx'),
    'utf8',
  );

  it('keeps the duration slider row LTR so drag matches thumb motion', () => {
    expect(source).toMatch(/dir=\{['"]ltr['"]\}/);
  });
});
