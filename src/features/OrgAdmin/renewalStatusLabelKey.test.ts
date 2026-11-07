import { describe, expect, it } from 'vitest';

import { renewalStatusLabelKey } from './OrgAdminMembers';

describe('renewalStatusLabelKey', () => {
  it.each(['active', 'renewal_pending', 'renewal_failed', 'disabled', 'settled'])(
    'maps %s to its locale key',
    (status) => {
      expect(renewalStatusLabelKey(status)).toBe(`org.renewalStatus.${status}`);
    },
  );

  it('returns null for empty or unknown values', () => {
    expect(renewalStatusLabelKey(null)).toBeNull();
    expect(renewalStatusLabelKey(undefined)).toBeNull();
    expect(renewalStatusLabelKey('mystery')).toBeNull();
  });
});
