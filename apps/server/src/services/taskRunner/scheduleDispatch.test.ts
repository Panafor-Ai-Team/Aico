// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchDueScheduledTasks } from './scheduleDispatch';

const mocks = vi.hoisted(() => ({
  appEnv: { enableQueueAgentRuntime: false },
  getScheduledTasks: vi.fn(),
  publishJSON: vi.fn(),
  runScheduleTick: vi.fn(),
}));

vi.mock('@/database/models/task', () => ({
  TaskModel: { getScheduledTasks: mocks.getScheduledTasks },
}));
vi.mock('@/envs/app', () => ({ appEnv: mocks.appEnv }));
vi.mock('@/libs/qstash', () => ({ qstashClient: { publishJSON: mocks.publishJSON } }));
vi.mock('./scheduleTick', () => ({ runScheduleTick: mocks.runScheduleTick }));

const db = {} as any;

const task = (overrides: Record<string, unknown>) => ({
  createdByUserId: 'user-1',
  id: 'task-1',
  identifier: 'TASK-1',
  lastHeartbeatAt: null,
  schedulePattern: '0 10 * * *',
  scheduleTimezone: 'Asia/Tehran',
  ...overrides,
});

/** 2026-11-08 10:01 in Tehran (UTC+03:30). */
const NOW = new Date('2026-11-08T10:01:00+03:30');

beforeEach(() => {
  mocks.appEnv.enableQueueAgentRuntime = false;
  mocks.getScheduledTasks.mockReset();
  mocks.publishJSON.mockReset();
  mocks.runScheduleTick.mockReset().mockResolvedValue({ ran: true, taskIdentifier: 'TASK-1' });
});

describe('dispatchDueScheduledTasks', () => {
  it('runs a due task inline outside queue mode', async () => {
    mocks.getScheduledTasks.mockResolvedValue([
      task({}),
      task({ id: 'task-2', identifier: 'TASK-2', schedulePattern: '0 18 * * *' }),
    ]);

    const result = await dispatchDueScheduledTasks(db, { now: NOW });

    expect(mocks.runScheduleTick).toHaveBeenCalledTimes(1);
    expect(mocks.runScheduleTick).toHaveBeenCalledWith('task-1', 'user-1');
    expect(mocks.publishJSON).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 1, dryRun: false, due: 1, skipped: 1, total: 2 });
  });

  it('does not run a one-off task dated tomorrow', async () => {
    mocks.getScheduledTasks.mockResolvedValue([task({ schedulePattern: '0 10 9 11 *' })]);

    const result = await dispatchDueScheduledTasks(db, { now: NOW });

    expect(mocks.runScheduleTick).not.toHaveBeenCalled();
    expect(result.due).toBe(0);
  });

  it('runs the one-off task on its date', async () => {
    mocks.getScheduledTasks.mockResolvedValue([task({ schedulePattern: '0 10 9 11 *' })]);

    await dispatchDueScheduledTasks(db, { now: new Date('2026-11-09T10:01:00+03:30') });

    expect(mocks.runScheduleTick).toHaveBeenCalledWith('task-1', 'user-1');
  });

  it('only reports due tasks on a dry run', async () => {
    mocks.getScheduledTasks.mockResolvedValue([task({})]);

    const result = await dispatchDueScheduledTasks(db, { dryRun: true, now: NOW });

    expect(mocks.runScheduleTick).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 0, dryRun: true, due: 1, skipped: 0, total: 1 });
  });

  it('keeps going when one inline tick fails', async () => {
    mocks.getScheduledTasks.mockResolvedValue([
      task({}),
      task({ id: 'task-2', identifier: 'TASK-2' }),
    ]);
    mocks.runScheduleTick.mockRejectedValueOnce(new Error('boom'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await dispatchDueScheduledTasks(db, { now: NOW });

    expect(mocks.runScheduleTick).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ dispatched: 1, due: 2 });
    error.mockRestore();
  });

  it('publishes through QStash in queue mode', async () => {
    mocks.appEnv.enableQueueAgentRuntime = true;
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'https://app.example.test/';
    mocks.getScheduledTasks.mockResolvedValue([task({})]);
    mocks.publishJSON.mockResolvedValue({ messageId: 'm1' });

    const result = await dispatchDueScheduledTasks(db, { now: NOW });

    expect(mocks.runScheduleTick).not.toHaveBeenCalled();
    expect(mocks.publishJSON).toHaveBeenCalledWith({
      body: { taskId: 'task-1', userId: 'user-1' },
      url: 'https://app.example.test/api/workflows/task/schedule-execute',
    });
    expect(result.dispatched).toBe(1);
    if (prev === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prev;
  });
});
