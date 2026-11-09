// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskReviewService } from './index';

/**
 * The task review judge runs server-side after a task run. On a managed
 * provider `initModelRuntimeFromDB` refuses a runtime without a billing context
 * and model id (`BILLING_CONTEXT_REQUIRED` / `MODEL_ID_REQUIRED`).
 */
const mocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
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

vi.mock('@/database/models/user', () => ({
  UserModel: vi.fn().mockImplementation(() => ({ getUserSettings: mocks.getUserSettings })),
}));

vi.mock('@lobechat/eval-rubric', () => ({ evaluate: mocks.evaluate }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserWallet.mockResolvedValue({
    preferredBillingSource: 'organization',
    preferredOrganizationId: 'org_test_1',
  });
  mocks.getUserSettings.mockResolvedValue({});
  mocks.initModelRuntimeFromDB.mockResolvedValue({ generateObject: vi.fn() });
  mocks.evaluate.mockResolvedValue({ passed: true, rubricResults: [], score: 0.9 });
});

describe('TaskReviewService managed-model billing', () => {
  it('bills the judge runtime for a managed judge model', async () => {
    const service = new TaskReviewService({} as any, 'user_test_1', 'ws_test_1');

    const result = await service.review({
      content: 'the run output',
      judge: { model: 'synthetic/judge-model', provider: 'aico' },
      rubrics: [],
      taskName: 'Daily news',
    });

    expect(result.passed).toBe(true);
    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      {},
      'user_test_1',
      'aico',
      'ws_test_1',
      {
        billingContext: { organizationId: 'org_test_1', source: 'organization' },
        modelId: 'synthetic/judge-model',
      },
    );
  });

  it('keeps a BYOK judge unbilled', async () => {
    const service = new TaskReviewService({} as any, 'user_test_1');

    await service.review({
      content: 'the run output',
      judge: { model: 'gpt-test', provider: 'openai' },
      rubrics: [],
      taskName: 'Daily news',
    });

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      {},
      'user_test_1',
      'openai',
      undefined,
    );
    expect(mocks.getUserWallet).not.toHaveBeenCalled();
  });
});
