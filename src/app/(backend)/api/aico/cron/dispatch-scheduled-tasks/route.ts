import { NextResponse } from 'next/server';

import { getServerDB } from '@/database/core/db-adaptor';
import { assertCronAuth } from '@/server/services/aico/cronAuth';
import { dispatchDueScheduledTasks } from '@/server/services/taskRunner/scheduleDispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Run schedule-mode tasks whose cron pattern is due (agent "do X tomorrow at
 * 10:00" / "every day at 9:00"). Self-hosted replacement for the QStash
 * Schedule that drives `/api/workflows/task/schedule-dispatch` upstream.
 * Suggested interval: every 1 minute.
 * Auth: `Authorization: Bearer $CRON_SECRET`
 */
export const GET = async (req: Request) => {
  const denied = assertCronAuth(req);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const db = await getServerDB();
  const result = await dispatchDueScheduledTasks(db);

  const ok = result.dispatched === result.due;
  return NextResponse.json(result, { status: ok ? 200 : 207 });
};
