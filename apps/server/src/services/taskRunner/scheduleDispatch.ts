import { isExecutionTime } from '@lobechat/utils/cronEval';
import debug from 'debug';

import { TaskModel } from '@/database/models/task';
import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';
import { qstashClient } from '@/libs/qstash';

import { runScheduleTick } from './scheduleTick';

const log = debug('task-runner:schedule-dispatch');

const SCHEDULE_EXECUTE_PATH = '/api/workflows/task/schedule-execute';

export interface ScheduleDispatchOptions {
  /** When true, only report what would be dispatched without firing executes. */
  dryRun?: boolean;
  /** Defaults to `new Date()` — exposed for tests. */
  now?: Date;
}

export interface ScheduleDispatchResult {
  dispatched: number;
  dryRun: boolean;
  due: number;
  skipped: number;
  total: number;
}

interface DueTask {
  taskId: string;
  taskIdentifier: string;
  userId: string;
}

/**
 * Central sweep for schedule-mode tasks. Callers:
 *
 * - `POST /api/workflows/task/schedule-dispatch` — QStash Schedule (upstream cloud).
 * - `GET /api/aico/cron/dispatch-scheduled-tasks` — host crontab (self-hosted, D-004).
 *
 * On each call:
 *   1. Loads all schedule-mode tasks in a dispatchable status.
 *   2. Filters by cron pattern + timezone + last-run dedup (`isExecutionTime`).
 *   3. Runs each due task — via one QStash message per task in queue mode, or
 *      inline through `runScheduleTick` otherwise.
 */
export async function dispatchDueScheduledTasks(
  db: LobeChatDatabase,
  { dryRun = false, now = new Date() }: ScheduleDispatchOptions = {},
): Promise<ScheduleDispatchResult> {
  const tasks = await TaskModel.getScheduledTasks(db);

  const due: DueTask[] = [];
  for (const task of tasks) {
    if (!task.schedulePattern) continue;
    const matches = isExecutionTime({
      cronPattern: task.schedulePattern,
      currentTime: now,
      lastExecutedAt: task.lastHeartbeatAt ?? null,
      timezone: task.scheduleTimezone,
    });
    if (!matches) continue;
    due.push({
      taskId: task.id,
      taskIdentifier: task.identifier,
      userId: task.createdByUserId,
    });
  }

  const skipped = tasks.length - due.length;
  log('scan: total=%d due=%d skipped=%d dryRun=%s', tasks.length, due.length, skipped, dryRun);

  const dispatched = dryRun || due.length === 0 ? 0 : await fanout(due);

  return { dispatched, dryRun, due: due.length, skipped, total: tasks.length };
}

const fanout = async (due: DueTask[]): Promise<number> => {
  // In queue mode, hand off via QStash so each task gets its own retry budget
  // and runs in an isolated handler invocation. Otherwise run inline so
  // self-hosted / dev / electron can exercise the path without QStash.
  if (appEnv.enableQueueAgentRuntime) {
    if (!process.env.APP_URL) {
      throw new Error('APP_URL is required to fan out scheduled task executions via QStash');
    }
    const url = `${process.env.APP_URL.replace(/\/$/, '')}${SCHEDULE_EXECUTE_PATH}`;

    const results = await Promise.allSettled(
      due.map((d) =>
        qstashClient.publishJSON({
          body: { taskId: d.taskId, userId: d.userId },
          url,
        }),
      ),
    );

    let dispatched = 0;
    for (const [i, r] of results.entries()) {
      if (r.status === 'fulfilled') {
        dispatched += 1;
      } else {
        console.error(
          '[task/schedule-dispatch] failed to publish task=%s identifier=%s: %O',
          due[i].taskId,
          due[i].taskIdentifier,
          r.reason,
        );
      }
    }
    return dispatched;
  }

  // Inline: errors are logged but don't fail the sweep — one bad task
  // shouldn't block the rest.
  const results = await Promise.allSettled(due.map((d) => runScheduleTick(d.taskId, d.userId)));
  let dispatched = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') {
      dispatched += 1;
    } else {
      console.error(
        '[task/schedule-dispatch] inline tick failed task=%s: %O',
        due[i].taskId,
        r.reason,
      );
    }
  }
  return dispatched;
};
