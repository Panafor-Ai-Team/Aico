import type {
  ContextBuilder,
  ContextBuildInput,
  ContextBuildOutput,
} from '@lobechat/agent-runtime';
import {
  didPreviousTurnGenerateImage,
  findPendingUserMessageText,
  hasPreviousImageGeneration,
  isImageGenerationUserIntent,
  resolveDirectImageGenerationToolCall,
  resolveForcedImageGenerationToolChoice,
} from '@lobechat/builtin-tool-image-generation';
import { resolveDirectVideoGenerationToolCall } from '@lobechat/builtin-tool-video-generation';

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

    // Clear video / image asks must call the generator — reasoning models
    // otherwise invent a plaintext prompt and never invoke the tool. Prefer the
    // Create one-shot path (skip LLM) on clear intent even when the tool is
    // missing from the offer set; otherwise keep forcing tool_choice. Video is
    // checked first: "make a video from this photo" names a photo too.
    // Prefer raw payload messages for image intent (assistantGroup / no injectors).
    const rawMessages = input.payload.messages;
    const latestUserText = findPendingUserMessageText(result.processedMessages);
    const directToolCall =
      resolveDirectVideoGenerationToolCall({
        executorMap: tooling.resolved.executorMap,
        messages: result.processedMessages,
        sourceMap: tooling.resolved.sourceMap,
      }) ??
      resolveDirectImageGenerationToolCall({
        executorMap: tooling.resolved.executorMap,
        historyMessages: rawMessages,
        messages: result.processedMessages,
        sourceMap: tooling.resolved.sourceMap,
      });
    if (
      !directToolCall &&
      isImageGenerationUserIntent(latestUserText, {
        hasPreviousGenerated: hasPreviousImageGeneration(rawMessages),
        previousTurnGeneratedImage: didPreviousTurnGenerateImage(rawMessages),
      })
    ) {
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
