import type { EvaluateResult, RubricResult } from '@lobechat/eval-rubric';
import { evaluate } from '@lobechat/eval-rubric';
import type { EvalBenchmarkRubric, UserSystemAgentConfig } from '@lobechat/types';
import debug from 'debug';

import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';
import {
  initServerModelRuntime,
  toServerCallModelId,
} from '@/server/services/aico/serverModelRuntime';

import { resolveSystemAgentModelConfig } from '../systemAgent/modelConfig';

const log = debug('task-review');

export interface ReviewConfig {
  autoRetry: boolean;
  enabled: boolean;
  judge: ReviewJudge;
  maxIterations: number;
  rubrics: EvalBenchmarkRubric[];
}

export interface ReviewJudge {
  model?: string;
  prompt?: string;
  provider?: string;
}

export interface ReviewResult {
  iteration: number;
  overallScore: number;
  passed: boolean;
  rubricResults: RubricResult[];
  suggestions: string[];
}

export class TaskReviewService {
  private db: LobeChatDatabase;
  private userId: string;
  private workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.db = db;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  async review(params: {
    content: string;
    iteration?: number;
    judge: ReviewJudge;
    rubrics: EvalBenchmarkRubric[];
    taskName: string;
  }): Promise<ReviewResult> {
    const { content, rubrics, judge, taskName, iteration = 1 } = params;

    // 1. Resolve model/provider
    const { model, provider } = await this.resolveModelConfig(judge);

    log(
      'Starting review for task %s (iteration %d, model=%s, provider=%s, rubrics=%d)',
      taskName,
      iteration,
      model,
      provider,
      rubrics.length,
    );

    // 2. Initialize ModelRuntime for LLM-based rubrics. A managed runtime is
    // authorized (allow-list + billing) for one model, so a rubric that
    // overrides the judge model gets its own runtime.
    const runtimes = new Map<string, ReturnType<typeof initServerModelRuntime>>();
    const getRuntime = (callModel: string) => {
      let runtime = runtimes.get(callModel);
      if (!runtime) {
        runtime = initServerModelRuntime({
          db: this.db,
          model: callModel,
          provider,
          userId: this.userId,
          workspaceId: this.workspaceId,
        });
        runtimes.set(callModel, runtime);
      }
      return runtime;
    };
    await getRuntime(model);

    // 3. Run evaluate() from @lobechat/eval-rubric
    const result: EvaluateResult = await evaluate(
      {
        actual: content,
        rubrics,
        testCase: { input: taskName },
      },
      {
        matchContext: {
          generateObject: async (payload) => {
            const callModel = payload.model ? toServerCallModelId(provider, payload.model) : model;
            const modelRuntime = await getRuntime(callModel);
            return (modelRuntime as any).generateObject(
              {
                messages: payload.messages as any[],
                model: callModel,
                schema: { name: 'judge_score', schema: payload.schema },
              },
              { metadata: { trigger: 'task-review' } },
            );
          },
          judgeModel: model,
        },
        passThreshold: 0.6,
      },
    );

    log('Review complete: %s (score: %.2f, passed: %s)', taskName, result.score, result.passed);

    return {
      iteration,
      overallScore: Math.round(result.score * 100),
      passed: result.passed,
      rubricResults: result.rubricResults,
      suggestions: [],
    };
  }

  private async resolveModelConfig(
    judge: ReviewJudge,
  ): Promise<{ model: string; provider: string }> {
    if (judge.model && judge.provider) {
      return resolveSystemAgentModelConfig({
        override: judge,
        taskKey: 'topic',
      });
    }

    const userModel = new UserModel(this.db, this.userId);
    const settings = await userModel.getUserSettings();
    const systemAgent = settings?.systemAgent as Partial<UserSystemAgentConfig> | undefined;
    const topicConfig = systemAgent?.topic;

    return resolveSystemAgentModelConfig({
      override: judge,
      taskConfig: topicConfig,
      taskKey: 'topic',
    });
  }
}
