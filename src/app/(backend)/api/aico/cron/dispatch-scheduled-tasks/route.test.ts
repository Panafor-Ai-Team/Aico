// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const h = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));
vi.mock('@/server/services/taskRunner/scheduleDispatch', () => ({
  dispatchDueScheduledTasks: h.dispatch,
}));

const SECRET = 'test-cron-secret';
const prev = process.env.CRON_SECRET;

const request = (auth?: string) =>
  new Request('http://localhost/api/aico/cron/dispatch-scheduled-tasks', {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  h.dispatch
    .mockReset()
    .mockResolvedValue({ dispatched: 1, dryRun: false, due: 1, skipped: 2, total: 3 });
});

afterEach(() => {
  if (prev === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = prev;
});

describe('GET /api/aico/cron/dispatch-scheduled-tasks', () => {
  it('rejects a request without the cron secret', async () => {
    expect((await GET(request('Bearer wrong'))).status).toBe(401);
    expect((await GET(request())).status).toBe(401);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('returns 503 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(503);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('runs the scheduled-task sweep and returns its result', async () => {
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual({
      dispatched: 1,
      dryRun: false,
      due: 1,
      skipped: 2,
      total: 3,
    });
  });

  it('returns 207 when some due tasks failed to start', async () => {
    h.dispatch.mockResolvedValue({ dispatched: 1, dryRun: false, due: 2, skipped: 0, total: 2 });
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(207);
  });
});
