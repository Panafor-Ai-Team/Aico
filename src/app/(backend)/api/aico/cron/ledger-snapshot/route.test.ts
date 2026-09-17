// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const h = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));
vi.mock('@/server/services/aico/ledger/snapshot', () => ({
  runLedgerSnapshotPhase: h.run,
  SNAPSHOT_DEFAULT_LIMIT: 25,
  SNAPSHOT_MAX_LIMIT: 100,
}));

const SECRET = 'test-cron-secret';
const prev = process.env.CRON_SECRET;

const request = (query: string, auth = `Bearer ${SECRET}`) =>
  new Request(`http://localhost/api/aico/cron/ledger-snapshot${query}`, {
    headers: { authorization: auth },
    method: 'POST',
  });

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  h.run.mockReset().mockResolvedValue({ body: { reason: 'not_paused' }, status: 409 });
});

afterEach(() => {
  if (prev === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = prev;
});

describe('POST /api/aico/cron/ledger-snapshot', () => {
  it('rejects a request without the cron secret', async () => {
    const res = await POST(request('?phase=wallets', 'Bearer wrong'));
    expect(res.status).toBe(401);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('rejects an unknown phase or an out-of-range limit', async () => {
    expect((await POST(request('?phase=everything'))).status).toBe(400);
    expect((await POST(request('?phase=wallets&limit=1000'))).status).toBe(400);
    expect((await POST(request(''))).status).toBe(400);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('passes the phase through and relays the phase status', async () => {
    const res = await POST(request('?phase=budgets&limit=10'));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ reason: 'not_paused' });
    expect(h.run).toHaveBeenCalledWith({}, { limit: 10, phase: 'budgets' });
  });
});
