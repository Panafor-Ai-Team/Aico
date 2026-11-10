// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const h = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));
vi.mock('@/server/services/aico/ledger/maintenance', () => ({ runLedgerMaintenance: h.run }));

const SECRET = 'test-cron-secret';
const prev = process.env.CRON_SECRET;

const request = (auth: string) =>
  new Request('http://localhost/api/aico/cron/ledger-maintenance', {
    headers: { authorization: auth },
  });

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  h.run.mockReset().mockResolvedValue({ expired: 2, reconcile: { skipped: 'not_shared' } });
});

afterEach(() => {
  if (prev === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = prev;
});

describe('GET /api/aico/cron/ledger-maintenance', () => {
  it('rejects a request without the cron secret', async () => {
    expect((await GET(request('Bearer wrong'))).status).toBe(401);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('returns the maintenance result', async () => {
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      expired: 2,
      reconcile: { skipped: 'not_shared' },
    });
  });
});
