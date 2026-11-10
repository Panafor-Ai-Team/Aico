// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_GOAL_MAX_ROUNDS, resolveGoalRoundBudget } from '../goalBudget';
import { maybeContinueGoalLoop, syncGoalToolState } from '../goalLoop';

const { runTaskMock, sumCostMock, findToolMessageIdMock, updateToolMessageMock } = vi.hoisted(
  () => ({
    findToolMessageIdMock: vi.fn(),
    runTaskMock: vi.fn(),
    sumCostMock: vi.fn(),
    updateToolMessageMock: vi.fn(),
  }),
);

const mockGoalsCapability = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/server/services/aico/capabilityGate', () => ({
  isCapabilityEnabled: async () => mockGoalsCapability.enabled,
}));

vi.mock('@/server/services/taskRunner', () => ({
  TaskRunnerService: vi.fn(() => ({ runTask: runTaskMock })),
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: vi.fn(() => ({ sumCostByTask: sumCostMock })),
}));
vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn(() => ({
    findToolMessageIdByToolCallId: findToolMessageIdMock,
    updateToolMessage: updateToolMessageMock,
  })),
}));

const db = {} as any;
const baseTask = { id: 'task-1', identifier: 'T-1', totalTopics: 1 } as any;

describe('resolveGoalRoundBudget', () => {
  it('null → uncapped', () => {
    expect(resolveGoalRoundBudget({ maxIterations: null })).toBe(Number.POSITIVE_INFINITY);
  });
  it('absent → default', () => {
    expect(resolveGoalRoundBudget({})).toBe(DEFAULT_GOAL_MAX_ROUNDS);
  });
  it('numbers are floored at 2', () => {
    expect(resolveGoalRoundBudget({ maxIterations: 1 })).toBe(2);
    expect(resolveGoalRoundBudget({ maxIterations: 5 })).toBe(5);
  });
});

describe('maybeContinueGoalLoop', () => {
  beforeEach(() => {
    [runTaskMock, sumCostMock].forEach((m) => m.mockReset());
    mockGoalsCapability.enabled = true;
  });

  it('never spawns a round while the goals capability is off (Aico gate)', async () => {
    mockGoalsCapability.enabled = false;
    const outcome = await maybeContinueGoalLoop({
      db,
      goal: { maxIterations: 3 },
      task: baseTask,
      userId: 'u1',
    });
    expect(outcome).toBe('capability-disabled');
    expect(runTaskMock).not.toHaveBeenCalled();
  });

  it('spawns the next round with the goal trigger while budgets last', async () => {
    runTaskMock.mockResolvedValue({});
    const outcome = await maybeContinueGoalLoop({
      db,
      goal: { maxIterations: 3 },
      task: baseTask,
      userId: 'u1',
    });
    expect(outcome).toBe('continued');
    expect(runTaskMock).toHaveBeenCalledWith({ taskId: 'task-1', trigger: 'goal' });
  });

  it('stops at the round budget', async () => {
    const outcome = await maybeContinueGoalLoop({
      db,
      goal: { maxIterations: 3 },
      task: { ...baseTask, totalTopics: 3 },
      userId: 'u1',
    });
    expect(outcome).toBe('exhausted-rounds');
    expect(runTaskMock).not.toHaveBeenCalled();
  });

  it('uncapped rounds (null) keep looping', async () => {
    runTaskMock.mockResolvedValue({});
    const outcome = await maybeContinueGoalLoop({
      db,
      goal: { maxIterations: null },
      task: { ...baseTask, totalTopics: 42 },
      userId: 'u1',
    });
    expect(outcome).toBe('continued');
  });

  it('stops when the cost budget is spent', async () => {
    sumCostMock.mockResolvedValue(21.5);
    const outcome = await maybeContinueGoalLoop({
      db,
      goal: { maxIterations: 5, maxTotalCost: 20 },
      task: baseTask,
      userId: 'u1',
    });
    expect(outcome).toBe('exhausted-cost');
    expect(runTaskMock).not.toHaveBeenCalled();
  });

  it('ignores cost when no cost budget is set', async () => {
    runTaskMock.mockResolvedValue({});
    const outcome = await maybeContinueGoalLoop({
      db,
      goal: { maxIterations: 5, maxTotalCost: null },
      task: baseTask,
      userId: 'u1',
    });
    expect(outcome).toBe('continued');
    expect(sumCostMock).not.toHaveBeenCalled();
  });

  it('degrades a spawn failure (e.g. CONFLICT: topic still running) to spawn-failed', async () => {
    runTaskMock.mockRejectedValue(new Error('CONFLICT'));
    const outcome = await maybeContinueGoalLoop({
      db,
      goal: { maxIterations: 3 },
      task: baseTask,
      userId: 'u1',
    });
    expect(outcome).toBe('spawn-failed');
  });
});

describe('syncGoalToolState', () => {
  beforeEach(() => {
    [findToolMessageIdMock, updateToolMessageMock].forEach((m) => m.mockReset());
  });

  it('no origin toolCallId → silent no-op', async () => {
    await syncGoalToolState({
      db,
      state: { phase: 'running' },
      task: { ...baseTask, context: {} },
      userId: 'u1',
    });
    expect(findToolMessageIdMock).not.toHaveBeenCalled();
  });

  it('pushes phase + counters onto the origin tool card', async () => {
    findToolMessageIdMock.mockResolvedValue('msg-9');
    await syncGoalToolState({
      db,
      state: { phase: 'paused', roundsRun: 3 },
      task: { ...baseTask, context: { origin: { toolCallId: 'call-1' } } },
      userId: 'u1',
    });
    expect(findToolMessageIdMock).toHaveBeenCalledWith('call-1');
    expect(updateToolMessageMock).toHaveBeenCalledWith('msg-9', {
      pluginState: expect.objectContaining({
        goalPhase: 'paused',
        phase: 'paused',
        roundsRun: 3,
        updatedAt: expect.any(String),
      }),
    });
  });

  it('missing tool card → no write, no throw', async () => {
    findToolMessageIdMock.mockResolvedValue(null);
    await syncGoalToolState({
      db,
      state: { phase: 'done' },
      task: { ...baseTask, context: { origin: { toolCallId: 'call-1' } } },
      userId: 'u1',
    });
    expect(updateToolMessageMock).not.toHaveBeenCalled();
  });
});
