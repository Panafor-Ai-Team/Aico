import debug from 'debug';

import { AsyncTaskModel } from '@/database/models/asyncTask';
import { type ListTopicsForMemoryExtractorCursor } from '@/database/models/topic';
import { getServerDB } from '@/database/server';
import { AsyncTaskError, AsyncTaskErrorType, AsyncTaskStatus } from '@/types/asyncTask';
import { LayersEnum, MemorySourceType } from '@/types/userMemory';

import { MemoryExtractionExecutor } from './extract';

const log = debug('lobe-server:memory:extract:local');

const TOPIC_PAGE_SIZE = 50;

// Same two passes as the process-topic workflow: identity runs after the other layers.
const CEPA_LAYERS: LayersEnum[] = [
  LayersEnum.Context,
  LayersEnum.Experience,
  LayersEnum.Preference,
  LayersEnum.Activity,
];
const IDENTITY_LAYERS: LayersEnum[] = [LayersEnum.Identity];

export interface LocalUserTopicsRunParams {
  asyncTaskId: string;
  from?: Date;
  to?: Date;
  userId: string;
  workspaceId?: string;
}

/**
 * Runs a user-initiated chat-topic memory extraction inside the app server.
 *
 * Use when:
 * - Upstash Workflow is not usable (`MEMORY_USER_MEMORY_EXTRACTION_RUNNER=local`)
 * - The app runs as a long-lived Node server, so work can outlive the request
 *
 * Expects:
 * - `asyncTaskId` was created with `totalTopics` already counted by the same topic filters
 *
 * Returns:
 * - Nothing. Failures are written to the async task, never thrown to the caller
 */
export class MemoryExtractionLocalRunner {
  static schedule(params: LocalUserTopicsRunParams) {
    // NOTICE: let the tRPC mutation answer first; the run continues on the server's event loop.
    setTimeout(() => {
      void this.runUserTopics(params);
    }, 0);
  }

  static async runUserTopics(params: LocalUserTopicsRunParams) {
    const { asyncTaskId, from, to, userId, workspaceId } = params;

    try {
      const executor = await MemoryExtractionExecutor.create();
      const taskModel = new AsyncTaskModel(await getServerDB(), userId, workspaceId);
      let cursor: ListTopicsForMemoryExtractorCursor | undefined;
      let processed = 0;

      do {
        const page = await executor.getTopicsForUser(
          { cursor, forceAll: false, forceTopics: false, from, to, userId, workspaceId },
          TOPIC_PAGE_SIZE,
        );

        for (const topicId of page.ids) {
          if (await taskModel.isUserMemoryExtractionCancellationRequested(asyncTaskId)) {
            log('cancelled user %s task %s after %d topics', userId, asyncTaskId, processed);
            return;
          }

          // On failure extractTopic marks the task Error and throws, which ends the run here.
          for (const layers of [CEPA_LAYERS, IDENTITY_LAYERS]) {
            await executor.extractTopic({
              asyncTaskId,
              forceAll: false,
              forceTopics: false,
              from,
              layers,
              reportProgress: false,
              source: MemorySourceType.ChatTopic,
              to,
              topicId,
              userId,
              userInitiated: true,
              workspaceId,
            });
          }

          // Flips the task to Success once every counted topic is done.
          await taskModel.incrementUserMemoryExtractionProgress(asyncTaskId);
          processed += 1;
        }

        cursor = page.ids.length === TOPIC_PAGE_SIZE ? page.cursor : undefined;
      } while (cursor);

      log('finished user %s task %s: %d topics', userId, asyncTaskId, processed);
    } catch (error) {
      console.error('[memory-extraction] local run failed', error, 'userId:', userId);
      await this.markFailed(params, error);
    }
  }

  private static async markFailed(params: LocalUserTopicsRunParams, error: unknown) {
    try {
      const model = new AsyncTaskModel(await getServerDB(), params.userId, params.workspaceId);
      const task = await model.findById(params.asyncTaskId);
      const isActive =
        task?.status === AsyncTaskStatus.Pending || task?.status === AsyncTaskStatus.Processing;
      if (!isActive) return;

      await model.update(params.asyncTaskId, {
        error: new AsyncTaskError(
          AsyncTaskErrorType.ServerError,
          error instanceof Error ? error.message : 'Memory extraction failed',
        ),
        status: AsyncTaskStatus.Error,
      });
    } catch (taskError) {
      console.error('[memory-extraction] failed to update async task status', taskError);
    }
  }
}
