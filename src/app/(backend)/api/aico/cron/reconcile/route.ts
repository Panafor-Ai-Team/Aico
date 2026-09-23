import { NextResponse } from 'next/server';

import { getServerDB } from '@/database/core/db-adaptor';
import { assertCronAuth } from '@/server/services/aico/cronAuth';
import { runReconciliation } from '@/server/services/aico/reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only books check (ledger chains, float vs live keys, key drift); the
 * verdict is stored for the platform admin panel.
 * Suggested interval: every 15 minutes.
 * Auth: `Authorization: Bearer $CRON_SECRET`
 */
export const GET = async (req: Request) => {
  const denied = assertCronAuth(req);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const db = await getServerDB();
  const run = await runReconciliation(db, { trigger: 'cron' });

  return NextResponse.json(
    {
      checks: run.checks.map(({ id, status }) => ({ id, status })),
      id: run.id,
      status: run.status,
    },
    { status: run.status === 'error' ? 500 : 200 },
  );
};
