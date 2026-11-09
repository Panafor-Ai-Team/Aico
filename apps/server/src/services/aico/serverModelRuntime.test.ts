// @vitest-environment node
import { toLiveManagedModelId } from '@lobechat/business-const';
import { DEFAULT_MINI_SYSTEM_AGENT_ITEM } from '@lobechat/const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import {
  initServerModelRuntime,
  resolveServerBillingContext,
  toServerCallModelId,
} from './serverModelRuntime';

const mocks = vi.hoisted(() => ({
  getUserWallet: vi.fn(),
  initModelRuntimeFromDB: vi.fn(),
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn().mockImplementation(() => ({ getUserWallet: mocks.getUserWallet })),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: mocks.initModelRuntimeFromDB,
}));

const db = {} as LobeChatDatabase;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserWallet.mockResolvedValue(null);
  mocks.initModelRuntimeFromDB.mockResolvedValue({ runtime: true });
});

describe('resolveServerBillingContext', () => {
  it('bills the personal wallet when the user has no preference', async () => {
    await expect(resolveServerBillingContext(db, 'user_test_1')).resolves.toEqual({
      source: 'personal',
    });
    expect(mocks.getUserWallet).toHaveBeenCalledWith('user_test_1');
  });

  it('bills the preferred organization budget', async () => {
    mocks.getUserWallet.mockResolvedValue({
      preferredBillingSource: 'organization',
      preferredOrganizationId: 'org_test_1',
    });

    await expect(resolveServerBillingContext(db, 'user_test_1')).resolves.toEqual({
      organizationId: 'org_test_1',
      source: 'organization',
    });
  });
});

describe('initServerModelRuntime', () => {
  it.each(['aico', 'openrouter', 'cheapvibecode'])(
    'passes billing context and model for managed provider %s',
    async (provider) => {
      mocks.getUserWallet.mockResolvedValue({
        preferredBillingSource: 'organization',
        preferredOrganizationId: 'org_test_1',
      });

      await initServerModelRuntime({
        db,
        model: 'synthetic/model-1',
        provider,
        userId: 'user_test_1',
        workspaceId: 'ws_test_1',
      });

      expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
        db,
        'user_test_1',
        provider,
        'ws_test_1',
        {
          billingContext: { organizationId: 'org_test_1', source: 'organization' },
          modelId: 'synthetic/model-1',
        },
      );
    },
  );

  it('leaves BYOK providers without billing options', async () => {
    await initServerModelRuntime({
      db,
      model: 'gpt-test',
      provider: 'openai',
      userId: 'user_test_1',
    });

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      db,
      'user_test_1',
      'openai',
      undefined,
    );
    expect(mocks.getUserWallet).not.toHaveBeenCalled();
  });

  it('authorizes the live gateway id for another gateway default', async () => {
    const foreign = 'openai/gpt-4o-mini';

    await initServerModelRuntime({ db, model: foreign, provider: 'aico', userId: 'user_test_1' });

    expect(mocks.initModelRuntimeFromDB.mock.calls[0][4].modelId).toBe(
      toLiveManagedModelId(foreign),
    );
  });
});

describe('toServerCallModelId', () => {
  it('maps managed ids onto the live gateway and keeps BYOK ids', () => {
    expect(toServerCallModelId('aico', 'openai/gpt-4o-mini')).toBe(
      toLiveManagedModelId('openai/gpt-4o-mini'),
    );
    expect(toServerCallModelId('openai', 'openai/gpt-4o-mini')).toBe('openai/gpt-4o-mini');
    expect(toServerCallModelId('aico', DEFAULT_MINI_SYSTEM_AGENT_ITEM.model)).toBe(
      DEFAULT_MINI_SYSTEM_AGENT_ITEM.model,
    );
  });
});
