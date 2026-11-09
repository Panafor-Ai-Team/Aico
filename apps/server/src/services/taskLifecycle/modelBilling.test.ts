// @vitest-environment node
import type { TaskItem } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskLifecycleService } from './index';
import type * as SynthesizeModule from './synthesize';

/**
 * After a task run, the handoff summary / topic title and the brief judge +
 * brief generation call a managed model from the server. Without an explicit
 * billing context and model id, `initModelRuntimeFromDB` refuses them with
 * `BILLING_CONTEXT_REQUIRED`, and the swallowed error leaves no title, summary
 * or brief card.
 */
const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  getUserWallet: vi.fn(),
  initModelRuntimeFromDB: vi.fn(),
  shouldEmitTopicBrief: vi.fn(),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: mocks.initModelRuntimeFromDB,
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn().mockImplementation(() => ({ getUserWallet: mocks.getUserWallet })),
}));

vi.mock('@/server/services/taskScheduler', () => ({
  createTaskSchedulerModule: () => ({}),
}));

vi.mock('./synthesize', async (importOriginal) => ({
  ...(await importOriginal<typeof SynthesizeModule>()),
  shouldEmitTopicBrief: mocks.shouldEmitTopicBrief,
}));

const MANAGED = { model: 'synthetic/managed-model', provider: 'aico' };
const BILLED = {
  billingContext: { organizationId: 'org_test_1', source: 'organization' },
  modelId: MANAGED.model,
};

const task = {
  config: {},
  context: {},
  id: 'task_test_1',
  identifier: 'TASK-1',
  instruction: 'summarize the news',
  name: 'Daily news',
} as unknown as TaskItem;

const createService = () => {
  const service = new TaskLifecycleService({} as any, 'user_test_1', 'ws_test_1');
  const s = service as any;
  s.systemAgentService.getTaskModelConfig = vi.fn().mockResolvedValue(MANAGED);
  s.systemAgentService.getUserLocale = vi.fn().mockResolvedValue('en-US');
  s.topicModel.update = vi.fn().mockResolvedValue(undefined);
  s.taskTopicModel.updateHandoff = vi.fn().mockResolvedValue(undefined);
  s.taskTopicModel.findByTopicId = vi.fn().mockResolvedValue(undefined);
  s.taskTopicModel.updateBriefDecision = vi.fn().mockResolvedValue(undefined);
  s.taskModel.getReviewConfig = vi.fn().mockReturnValue(undefined);
  s.taskModel.getDocumentsPinnedSince = vi.fn().mockResolvedValue([]);
  s.briefModel.create = vi.fn().mockResolvedValue(undefined);
  return service;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserWallet.mockResolvedValue({
    preferredBillingSource: 'organization',
    preferredOrganizationId: 'org_test_1',
  });
  mocks.initModelRuntimeFromDB.mockResolvedValue({ generateObject: mocks.generateObject });
});

describe('TaskLifecycleService managed-model billing', () => {
  it('bills the handoff summary / topic title call', async () => {
    mocks.generateObject.mockResolvedValue({ summary: 'done', title: 'News digest' });
    const service = createService();

    await (service as any).generateHandoff(
      task.id,
      task.identifier,
      'topic_test_1',
      'the last assistant message',
      task,
    );

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      {},
      'user_test_1',
      'aico',
      'ws_test_1',
      BILLED,
    );
    expect(mocks.generateObject.mock.calls[0][0].model).toBe(MANAGED.model);
    expect((service as any).topicModel.update).toHaveBeenCalledWith('topic_test_1', {
      title: 'News digest',
    });
  });

  it('bills both the brief judge and the brief generation calls', async () => {
    mocks.shouldEmitTopicBrief.mockReturnValue({ emit: 'unknown' });
    mocks.generateObject
      .mockResolvedValueOnce({ emit: true, reason: 'substantive result' })
      .mockResolvedValueOnce({ summary: 'Three headlines', title: 'Daily news' });
    const service = createService();

    await (service as any).synthesizeTopicBrief(
      task.id,
      task.identifier,
      'topic_test_1',
      'a long, substantive assistant message with real findings',
      'done',
      task,
    );

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledTimes(2);
    for (const call of mocks.initModelRuntimeFromDB.mock.calls) {
      expect(call).toEqual([{}, 'user_test_1', 'aico', 'ws_test_1', BILLED]);
    }
    expect((service as any).briefModel.create).toHaveBeenCalledTimes(1);
  });

  it('keeps BYOK providers unbilled', async () => {
    mocks.generateObject.mockResolvedValue({ title: 'News digest' });
    const service = createService();
    (service as any).systemAgentService.getTaskModelConfig = vi
      .fn()
      .mockResolvedValue({ model: 'gpt-test', provider: 'openai' });

    await (service as any).generateHandoff(task.id, task.identifier, 'topic_test_1', 'msg', task);

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      {},
      'user_test_1',
      'openai',
      'ws_test_1',
    );
    expect(mocks.getUserWallet).not.toHaveBeenCalled();
  });
});
