// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SystemAgentService } from './index';

/**
 * Topic titles and skill metadata are generated server-side. On a managed
 * provider `initModelRuntimeFromDB` refuses a call without a billing context
 * and model id (`BILLING_CONTEXT_REQUIRED` / `MODEL_ID_REQUIRED`), which these
 * methods swallow into `null`.
 */
const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  getUserSettings: vi.fn(),
  getUserWallet: vi.fn(),
  initModelRuntimeFromDB: vi.fn(),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: mocks.initModelRuntimeFromDB,
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn().mockImplementation(() => ({ getUserWallet: mocks.getUserWallet })),
}));

vi.mock('@/database/models/user', () => {
  const UserModel = vi.fn().mockImplementation(() => ({
    getUserSettings: mocks.getUserSettings,
  })) as any;
  UserModel.getInfoForAIGeneration = vi.fn().mockResolvedValue({ responseLanguage: 'en-US' });
  return { UserModel };
});

const MANAGED = { model: 'synthetic/managed-model', provider: 'aico' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserWallet.mockResolvedValue(null);
  mocks.getUserSettings.mockResolvedValue({ systemAgent: { agentMeta: MANAGED, topic: MANAGED } });
  mocks.initModelRuntimeFromDB.mockResolvedValue({ generateObject: mocks.generateObject });
});

describe('SystemAgentService managed-model billing', () => {
  it('bills topic title generation', async () => {
    mocks.generateObject.mockResolvedValue({ title: 'Weekly plan' });
    const service = new SystemAgentService({} as any, 'user_test_1', 'ws_test_1');

    const title = await service.generateTopicTitle({
      lastAssistantContent: 'Here is the plan',
      userPrompt: 'Plan my week',
    });

    expect(title).toBe('Weekly plan');
    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      {},
      'user_test_1',
      'aico',
      'ws_test_1',
      { billingContext: { source: 'personal' }, modelId: MANAGED.model },
    );
  });

  it('bills skill metadata generation', async () => {
    mocks.generateObject.mockResolvedValue({
      description: 'Summarize documents',
      name: 'summarize',
      title: 'Summarize',
    });
    const service = new SystemAgentService({} as any, 'user_test_1');

    const meta = await service.generateSkillMeta({ content: '# Summarize\nSteps…' });

    expect(meta?.name).toBe('summarize');
    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      {},
      'user_test_1',
      'aico',
      undefined,
      {
        billingContext: { source: 'personal' },
        modelId: MANAGED.model,
      },
    );
  });

  it('keeps BYOK providers unbilled', async () => {
    mocks.getUserSettings.mockResolvedValue({
      systemAgent: { topic: { model: 'gpt-test', provider: 'openai' } },
    });
    mocks.generateObject.mockResolvedValue({ title: 'Weekly plan' });
    const service = new SystemAgentService({} as any, 'user_test_1');

    await service.generateTopicTitle({ lastAssistantContent: 'a', userPrompt: 'b' });

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      {},
      'user_test_1',
      'openai',
      undefined,
    );
    expect(mocks.getUserWallet).not.toHaveBeenCalled();
  });
});
