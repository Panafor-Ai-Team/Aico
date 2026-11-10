import { describe, expect, it } from 'vitest';

import * as realBranding from '../../../../../packages/business/const/src/branding';
import * as stub from './index';

describe('desktop business-const stub', () => {
  it('exports every branding constant of @lobechat/business-const', () => {
    // The renderer imports branding from this stub; a missing name (e.g. BRANDING_EMAIL)
    // fails the whole desktop build with MISSING_EXPORT.
    const missing = Object.keys(realBranding).filter((name) => !(name in stub));

    expect(missing).toEqual([]);
  });
});
