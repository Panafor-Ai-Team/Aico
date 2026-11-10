import { describe, expect, it, vi } from 'vitest';

import { AicoChatGuard } from './chatGuard';

describe('AicoChatGuard', () => {
  it('treats aico and openrouter as managed providers', () => {
    expect(AicoChatGuard.isManagedProvider('aico')).toBe(true);
    expect(AicoChatGuard.isManagedProvider('openrouter')).toBe(true);
    expect(AicoChatGuard.isManagedProvider('openai')).toBe(false);
  });

  it('maps aico runtime to openrouter', () => {
    expect(AicoChatGuard.resolveRuntimeProvider('aico')).toBe('openrouter');
    expect(AicoChatGuard.resolveRuntimeProvider('openrouter')).toBe('openrouter');
  });

  describe('C10: legacy first-match org lookup', () => {
    const run = async (openrouterKeyId: string | null) => {
      const guard = new AicoChatGuard({} as never);
      const syncMemberUsage = vi.fn().mockResolvedValue(null);
      const recordUsage = vi.fn().mockResolvedValue(null);
      Object.assign(guard, {
        billingModel: {
          isTrialActive: vi.fn().mockResolvedValue(false),
          recordUsage,
        },
        keyService: { getUserRemaining: vi.fn().mockResolvedValue(null), syncMemberUsage },
        orgModel: {
          getMemberBudget: vi.fn().mockResolvedValue({ openrouterKeyId }),
          listForUser: vi.fn().mockResolvedValue([{ id: 'org-1' }]),
          listMembers: vi
            .fn()
            .mockResolvedValue([{ id: 'member-1', status: 'active', userId: 'u1' }]),
        },
      });

      await guard.afterManagedChat('u1', { modelId: 'm' });

      return { recordUsage, syncMemberUsage };
    };

    it('does not take a placeholder key id for a real key', async () => {
      const { recordUsage, syncMemberUsage } = await run('mock_key_1');

      expect(syncMemberUsage).not.toHaveBeenCalled();
      expect(recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ billingSource: 'personal', orgId: null }),
      );
    });

    it('still bills the organization for a real key id', async () => {
      const { recordUsage, syncMemberUsage } = await run('cvc_real_1');

      expect(syncMemberUsage).toHaveBeenCalledWith('member-1');
      expect(recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ billingSource: 'organization', orgId: 'org-1' }),
      );
    });
  });
});
