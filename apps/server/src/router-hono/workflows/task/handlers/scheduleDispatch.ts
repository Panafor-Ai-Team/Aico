import type { Context } from 'hono';

import { getServerDB } from '@/database/server';
import {
  dispatchDueScheduledTasks,
  type ScheduleDispatchOptions,
} from '@/server/services/taskRunner/scheduleDispatch';

export type ScheduleDispatchPayload = Pick<ScheduleDispatchOptions, 'dryRun'>;

/**
 * Cron-style central dispatcher. Registered as a QStash Schedule (e.g.
 * `*\/30 * * * *`) pointing at this endpoint. Self-hosted Aico calls the same
 * sweep from the host crontab via `GET /api/aico/cron/dispatch-scheduled-tasks`.
 *
 * No per-user authentication: this is a global sweep. Signature verification is
 * handled by the `qstashAuth` middleware on the route.
 */
export async function scheduleDispatch(c: Context) {
  try {
    const body = (await c.req.json().catch(() => ({}))) as ScheduleDispatchPayload;
    const { dryRun = false } = body ?? {};

    const db = await getServerDB();
    const result = await dispatchDueScheduledTasks(db, { dryRun });

    return c.json({ ...result, success: true });
  } catch (error) {
    console.error('[task/schedule-dispatch] Error:', error);
    return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500);
  }
}
