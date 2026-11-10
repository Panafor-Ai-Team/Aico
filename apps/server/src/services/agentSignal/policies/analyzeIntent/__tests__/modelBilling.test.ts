// @vitest-environment node
import { toLiveManagedModelId } from '@lobechat/business-const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { FeedbackDomainJudgeAgentService } from '../feedbackDomainAgent';
import { FeedbackSatisfactionJudgeAgentService } from '../feedbackSatisfaction';
import { SkillIntentClassifierAgentService } from '../skillIntent';

/**
 * Agent Signal judges run server-side after a chat turn. On a managed provider
 * `initModelRuntimeFromDB` refuses a runtime without a billing context and
 * model id (`BILLING_CONTEXT_REQUIRED` / `MODEL_ID_REQUIRED`).
 */
const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  getUserWallet: vi.fn(),
  initModelRuntimeFromDB: vi.fn(),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: mocks.initModelRuntimeFromDB,
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn().mockImplementation(() => ({ getUserWallet: mocks.getUserWallet })),
}));

const db = {} as LobeChatDatabase;

type Judge = (modelConfig: { model: string; provider: string }) => () => Promise<unknown>;

const judges: [string, Judge][] = [
  [
    'skill intent classifier',
    (config) => () =>
      new SkillIntentClassifierAgentService(db, 'user_test_1', config, 'ws_test_1').classify({
        message: 'Use this procedure for future failures.',
        serializedContext: 'topic=debugging',
      }),
  ],
  [
    'feedback satisfaction judge',
    (config) => () =>
      new FeedbackSatisfactionJudgeAgentService(
        db,
        'user_test_1',
        config,
        'ws_test_1',
      ).judgeSatisfaction({ message: 'That was not what I asked for.' }),
  ],
  [
    'feedback domain judge',
    (config) => () =>
      new FeedbackDomainJudgeAgentService(db, 'user_test_1', config, 'ws_test_1').judgeDomains({
        evidence: [],
        message: 'Always answer in bullet points.',
        reason: 'style preference',
        result: 'not_satisfied',
      }),
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserWallet.mockResolvedValue({
    preferredBillingSource: 'organization',
    preferredOrganizationId: 'org_test_1',
  });
  // The parsed output is not under test; only the runtime init and payload are.
  mocks.generateObject.mockResolvedValue({});
  mocks.initModelRuntimeFromDB.mockResolvedValue({ generateObject: mocks.generateObject });
});

describe.each(judges)('%s managed-model billing', (_name, run) => {
  it('bills a managed provider with the preferred source and model id', async () => {
    await run({ model: 'synthetic/managed-model', provider: 'aico' })().catch(() => undefined);

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      db,
      'user_test_1',
      'aico',
      'ws_test_1',
      {
        billingContext: { organizationId: 'org_test_1', source: 'organization' },
        modelId: 'synthetic/managed-model',
      },
    );
  });

  it('authorizes and sends the same live id for another gateway default', async () => {
    const foreign = 'openai/gpt-4o-mini';

    await run({ model: foreign, provider: 'aico' })().catch(() => undefined);

    const live = toLiveManagedModelId(foreign);
    expect(mocks.initModelRuntimeFromDB.mock.calls[0][4].modelId).toBe(live);
    expect(mocks.generateObject.mock.calls[0][0].model).toBe(live);
  });

  it('keeps BYOK providers unbilled', async () => {
    await run({ model: 'gpt-test', provider: 'openai' })().catch(() => undefined);

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      db,
      'user_test_1',
      'openai',
      'ws_test_1',
    );
    expect(mocks.getUserWallet).not.toHaveBeenCalled();
  });
});
