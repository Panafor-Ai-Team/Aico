import { describe, expect, it } from 'vitest';

import { getCurrentOrgRole, isPlatformAdmin, requiresPhoneVerification } from './orgRole';

describe('orgRole helpers (Phase 1 stubs)', () => {
  it('getCurrentOrgRole always returns null until Phase 2 schema exists', async () => {
    await expect(getCurrentOrgRole('user_1', 'org_1')).resolves.toBeNull();
  });

  it('isPlatformAdmin always returns false until platform_admins exists', async () => {
    await expect(isPlatformAdmin('user_1')).resolves.toBe(false);
  });

  describe('requiresPhoneVerification', () => {
    it('skips when phone is already verified', async () => {
      await expect(
        requiresPhoneVerification({
          phoneNumberVerified: true,
          userId: 'user_1',
        }),
      ).resolves.toBe(false);
    });

    it('requires verify for independent buyers (no org)', async () => {
      await expect(
        requiresPhoneVerification({
          phoneNumberVerified: false,
          userId: 'user_1',
        }),
      ).resolves.toBe(true);
    });

    it('requires verify when orgId is set but Phase 2 stub returns null role', async () => {
      // Once Phase 2 lands: member → false, owner/admin → true
      await expect(
        requiresPhoneVerification({
          orgId: 'org_1',
          phoneNumberVerified: false,
          userId: 'user_1',
        }),
      ).resolves.toBe(true);
    });
  });
});
