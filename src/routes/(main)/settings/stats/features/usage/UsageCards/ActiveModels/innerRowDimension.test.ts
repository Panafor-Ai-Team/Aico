import { describe, expect, it } from 'vitest';

import { GroupBy } from '../../../../types';
import { isInnerRowProvider } from './innerRowDimension';

describe('isInnerRowProvider', () => {
  // ModelTable's `innerKey` groups sub-rows by `log.provider` when grouped by
  // Model, and by `log.model` otherwise (Provider/User) — this must agree,
  // since it drives which icon (BrandedProviderIcon vs. BrandedModelIcon) and
  // label formatter the sub-rows render with.
  it('is true when grouped by Model (sub-rows are providers)', () => {
    expect(isInnerRowProvider(GroupBy.Model)).toBe(true);
  });

  it('is false when grouped by Provider (sub-rows are models)', () => {
    expect(isInnerRowProvider(GroupBy.Provider)).toBe(false);
  });

  it('is false when grouped by User (sub-rows are models)', () => {
    expect(isInnerRowProvider(GroupBy.User)).toBe(false);
  });
});
