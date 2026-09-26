import type {
  ContextBuilder,
  ContextBuildInput,
  ContextBuildOutput,
} from '@lobechat/agent-runtime';
import {
  findLatestUserMessageText,
  isImageGenerationUserIntent,
  resolveDirectImageGenerationToolCall,
  resolveForcedImageGenerationToolChoice,
} from '@lobechat/builtin-tool-image-generation';

import type { RuntimeExecutorContext } from '../context';
import { buildServerCallLlmContext } from './serverCallLlmContextBuilder';
import { resolveServerCallLlmTooling } from './serverCallLlmTooling';

export class ServerContextBuilder implements ContextBuilder {
  constructor(private readonly ctx: RuntimeExecutorContext) {}

  async build(input: ContextBuildInput): Promise<ContextBuildOutput> {
    const tooling = resolveServerCallLlmTooling(
      this.ctx,
      input.state,
      input.payload.allowedToolNames,
    );
    const result = await buildServerCallLlmContext({
      ctx: this.ctx,
      llmPayload: input.payload,
      model: input.model,
      provider: input.provider,
      state: input.state,
      tooling,
    });

    const modelParameters = {
      ...result.resolvedExtendParams,
    } as Record<string, unknown>;

    // Clear image asks must call generateImage — reasoning models otherwise
    // invent a plaintext prompt and never invoke the tool. Prefer the Create →
    // Image one-shot path (skip LLM) when the tool is offered; otherwise keep
    // forcing tool_choice for providers that still need a model round-trip.
    const latestUserText = findLatestUserMessageText(result.processedMessages);
    const directToolCall = resolveDirectImageGenerationToolCall({
      executorMap: tooling.resolved.executorMap,
      messages: result.processedMessages,
      sourceMap: tooling.resolved.sourceMap,
      tools: tooling.resolved.tools,
    });
    if (!directToolCall && isImageGenerationUserIntent(latestUserText)) {
      const toolChoice = resolveForcedImageGenerationToolChoice(tooling.resolved.tools);
      if (toolChoice) {
        modelParameters.tool_choice = toolChoice;
      }
    }

    return {
      ...(directToolCall ? { directToolCalls: [directToolCall] } : {}),
      messages: result.processedMessages,
      modelParameters,
      preserveThinking: result.preserveThinkingForPayload,
      replayAssistantReasoning: result.shouldReplayAssistantReasoning,
      resolvedTools: tooling.resolved,
    };
  }
}
