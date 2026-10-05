import type { AgentState, CallLLMPayload } from '@lobechat/agent-runtime';
import { extractTodosFromMessages, normalizeTodosState } from '@lobechat/agent-runtime';
import {
  type ComposioServiceSummary,
  type CredSummary,
  excludeDisabledComposioServices,
  generateComposioServicesList,
  generateCredsList,
  resolveAvailableComposioServices,
} from '@lobechat/builtin-tool-creds';
import { builtinTools } from '@lobechat/builtin-tools';
import { AGENT_PLAN_FILE_TYPE, COMPOSIO_APP_TYPES } from '@lobechat/const';
import type {
  AgentBuilderContext,
  AgentContextDocument,
  AgentGroupConfig,
  OfficialToolItem,
  OnboardingContext,
  PlanTodoConfig,
} from '@lobechat/context-engine';
import { resolveTopicReferences } from '@lobechat/context-engine';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import { SpanStatusCode } from '@lobechat/observability-otel/api';
import {
  buildContextEngineeringAttributes,
  CONTEXT_ENGINEERING_SPAN_NAME,
  recordChatTtftPhase,
  tracer as agentRuntimeTracer,
} from '@lobechat/observability-otel/modules/agent-runtime';
import { getActivePluginIds, getDisabledPluginIds } from '@lobechat/types';

import { composioEnv } from '@/config/composio';
import { AgentModel } from '@/database/models/agent';
import { FileModel } from '@/database/models/file';
import { MessageModel as MessageModelClass } from '@/database/models/message';
import { TopicModel } from '@/database/models/topic';
import { TopicDocumentModel } from '@/database/models/topicDocument';
import { UserModel } from '@/database/models/user';
import { UserPersonaModel } from '@/database/models/userMemory/persona';
import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';
import { AgentDocumentsService } from '@/server/services/agentDocuments';
import { MarketService } from '@/server/services/market';
import { OnboardingService } from '@/server/services/onboarding';
import { toAgentContextDocuments } from '@/utils/agentDocumentContextMapping';

import type { RuntimeExecutorContext } from '../context';
import { buildPostProcessUrl, log, resolveRuntimeHistoryCount } from '../executorHelpers';
import { loadConnectedComposioIds } from './composioConnectedIds';
import {
  resolveServerCallLlmContextHints,
  type ServerCallLlmContextHints,
} from './serverCallLlmContextHints';
import type { ServerCallLlmTooling } from './serverCallLlmTooling';

interface BuildServerCallLlmContextInput {
  ctx: RuntimeExecutorContext;
  llmPayload: CallLLMPayload;
  model: string;
  provider: string;
  state: AgentState;
  tooling: ServerCallLlmTooling;
}

export interface ServerCallLlmContextBuildResult {
  preserveThinkingForPayload?: boolean;
  processedMessages: ChatStreamPayload['messages'];
  resolvedExtendParams?: ServerCallLlmContextHints['resolvedExtendParams'];
  shouldReplayAssistantReasoning: boolean;
}

type ContextMessages = ServerCallLlmContextHints['messagesForContext'];
type ResolvedTools = ServerCallLlmTooling['resolved'];

const CREDS_PLACEHOLDER_PATTERN = /\{\{\s*(?:CREDS_LIST|COMPOSIO_SERVICES_LIST)\s*\}\}/;

/**
 * Placeholder substitution runs over every message the engine produces, so the
 * whole engine input must be scanned — not only the creds tool prompt.
 */
export const containsCredsPlaceholder = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean => {
  if (typeof value === 'string') return CREDS_PLACEHOLDER_PATTERN.test(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) =>
    containsCredsPlaceholder(item, seen),
  );
};

export const buildServerCallLlmContext = async ({
  ctx,
  llmPayload,
  model,
  provider,
  state,
  tooling,
}: BuildServerCallLlmContextInput): Promise<ServerCallLlmContextBuildResult> => {
  const contextBuildStartedAt = Date.now();
  try {
    return await buildServerCallLlmContextInner({
      ctx,
      llmPayload,
      model,
      provider,
      state,
      tooling,
    });
  } finally {
    recordChatTtftPhase('context_build', Date.now() - contextBuildStartedAt, {
      model,
      provider,
    });
  }
};

// Extract <refer_topic> tags from messages and fetch summaries.
// Skip if messages already contain injected topic_reference_context
// (e.g., from client-side contextEngineering preprocessing) to avoid double injection.
const loadTopicReferences = async (ctx: RuntimeExecutorContext, messages: ContextMessages) => {
  const alreadyHasTopicRefs = (messages as Array<{ content: string | unknown }>).some(
    (message) =>
      typeof message.content === 'string' && message.content.includes('topic_reference_context'),
  );

  if (alreadyHasTopicRefs || !ctx.serverDB || !ctx.userId) return undefined;

  const topicModel = new TopicModel(ctx.serverDB, ctx.userId, ctx.workspaceId);
  const messageModel = new MessageModelClass(ctx.serverDB, ctx.userId, ctx.workspaceId);
  return resolveTopicReferences(
    messages as Array<{ content: string | unknown }>,
    async (topicId) => topicModel.findById(topicId),
    async (topicId) => {
      const topic = await topicModel.findById(topicId);
      return messageModel.query(
        {
          agentId: topic?.agentId ?? undefined,
          groupId: topic?.groupId ?? undefined,
          topicId,
        },
        { postProcessUrl: buildPostProcessUrl(ctx) },
      );
    },
  );
};

// Fetch agent documents for context injection.
const loadAgentDocuments = async (
  ctx: RuntimeExecutorContext,
  state: AgentState,
  agentId: string | undefined,
): Promise<AgentContextDocument[] | undefined> => {
  if (!agentId || !ctx.serverDB || !ctx.userId) return undefined;

  try {
    const agentDocService = new AgentDocumentsService(
      ctx.serverDB,
      ctx.userId,
      state.metadata?.workspaceId ?? ctx.workspaceId,
    );
    const docs = await agentDocService.getAgentContextDocuments(agentId);
    if (docs.length > 0) {
      const agentDocuments = toAgentContextDocuments(docs);
      log('Resolved %d agent documents for agent %s', agentDocuments.length, agentId);
      return agentDocuments;
    }
  } catch (error) {
    log('Failed to resolve agent documents for agent %s: %O', agentId, error);
  }

  return undefined;
};

// Detect onboarding agent and build context injection.
const loadOnboardingContext = async ({
  agentId,
  ctx,
  messages,
  resolved,
  state,
}: {
  agentId: string | undefined;
  ctx: RuntimeExecutorContext;
  messages: ContextMessages;
  resolved: ResolvedTools;
  state: AgentState;
}): Promise<OnboardingContext | undefined> => {
  const isOnboardingAgent =
    ctx.agentConfig?.slug === 'web-onboarding' ||
    resolved.enabledToolIds.includes('lobe-web-onboarding');
  const alreadyHasOnboardingContext = (messages as Array<{ content: string | unknown }>).some(
    (message) => {
      if (typeof message.content !== 'string') return false;

      return (
        message.content.includes('<onboarding_context>') ||
        message.content.includes('<current_soul_document>') ||
        message.content.includes('<current_user_persona>')
      );
    },
  );

  if (!isOnboardingAgent || alreadyHasOnboardingContext || !ctx.serverDB || !ctx.userId) {
    return undefined;
  }

  try {
    const { formatWebOnboardingStateMessage } =
      await import('@lobechat/builtin-tool-web-onboarding/utils');
    const onboardingService = new OnboardingService(ctx.serverDB, ctx.userId);
    const docService = new AgentDocumentsService(
      ctx.serverDB,
      ctx.userId,
      state.metadata?.workspaceId ?? ctx.workspaceId,
    );
    const personaModel = new UserPersonaModel(ctx.serverDB, ctx.userId);

    const [onboardingState, soulDoc, persona, userInfo] = await Promise.all([
      onboardingService.getState(),
      onboardingService
        .getInboxAgentId()
        .then((inboxAgentId) =>
          inboxAgentId ? docService.getDocumentByFilename(inboxAgentId, 'SOUL.md') : null,
        )
        .catch((error) => {
          log('Failed to fetch SOUL.md for onboarding context: %O', error);
          return null;
        }),
      personaModel.getLatestPersonaDocument().catch((error) => {
        log('Failed to fetch user persona for onboarding context: %O', error);
        return null;
      }),
      onboardingService.getInitialUserInfo().catch((error) => {
        log('Failed to fetch initial user info for onboarding context: %O', error);
        return undefined;
      }),
    ]);

    log('Built onboarding context for agent %s, phase: %s', agentId, onboardingState.phase);
    return {
      discoveryUserMessageCount: onboardingState.discoveryUserMessageCount,
      personaContent: persona?.persona ?? null,
      phaseGuidance: formatWebOnboardingStateMessage(onboardingState),
      remainingDiscoveryExchanges: onboardingState.remainingDiscoveryExchanges,
      soulContent: soulDoc?.content ?? null,
      userInfo,
    };
  } catch (error) {
    log('Failed to build onboarding context: %O', error);
    return undefined;
  }
};

const loadTopicTitle = async (
  ctx: RuntimeExecutorContext,
  topicId: string | undefined,
): Promise<string> => {
  if (!topicId || !ctx.serverDB || !ctx.userId) return '';

  try {
    const topicModelForLobehub = new TopicModel(ctx.serverDB, ctx.userId, ctx.workspaceId);
    const topicRecord = await topicModelForLobehub.findById(topicId);
    return topicRecord?.title ?? '';
  } catch (error) {
    log('Failed to load topic title for lobehub skill placeholders: %O', error);
    return '';
  }
};

// Tool-specific template variable resolution. The client-side
// contextEngineering.ts resolves these via Zustand stores and lambdaClient.
// In execAgent (server/bot) mode we must fetch from DB directly.
const loadUserInfoVariables = async (
  ctx: RuntimeExecutorContext,
): Promise<{ serverLanguage: string; serverUsername: string }> => {
  if (!ctx.serverDB || !ctx.userId) return { serverLanguage: '', serverUsername: '' };

  try {
    const userInfo = await UserModel.getInfoForAIGeneration(ctx.serverDB, ctx.userId);
    return { serverLanguage: userInfo.responseLanguage, serverUsername: userInfo.userName };
  } catch (error) {
    log('Failed to fetch user info for {{username}}/{{language}} substitution: %O', error);
    return { serverLanguage: '', serverUsername: '' };
  }
};

const loadSandboxUploadedFiles = async (
  ctx: RuntimeExecutorContext,
  sandboxEnabled: string,
  topicId: string | undefined,
): Promise<string> => {
  if (sandboxEnabled !== 'true' || !ctx.serverDB || !ctx.userId || !topicId) return '';

  try {
    const { formatUploadedFilesPrompt } = await import('@lobechat/builtin-tool-cloud-sandbox');
    const fileModel = new FileModel(ctx.serverDB, ctx.userId);
    const uploadedFiles = await fileModel.findFilesToInitInSandbox(topicId);
    return formatUploadedFilesPrompt(uploadedFiles);
  } catch (error) {
    log('Failed to resolve files for {{sandbox_uploaded_files}} substitution: %O', error);
    return '';
  }
};

const loadPlanTodo = async ({
  ctx,
  messages,
  resolved,
  state,
  topicId,
}: {
  ctx: RuntimeExecutorContext;
  messages: ContextMessages;
  resolved: ResolvedTools;
  state: AgentState;
  topicId: string | undefined;
}): Promise<PlanTodoConfig | undefined> => {
  const messageTodos = extractTodosFromMessages(messages);
  if (messageTodos !== undefined) return { enabled: true, todos: messageTodos };

  if (!resolved.enabledToolIds.includes('lobe-agent') || !topicId || !ctx.serverDB || !ctx.userId) {
    return undefined;
  }

  try {
    const topicDocumentModel = new TopicDocumentModel(
      ctx.serverDB,
      ctx.userId,
      state.metadata?.workspaceId ?? ctx.workspaceId,
    );
    const [planDocument] = await topicDocumentModel.findByTopicId(topicId, {
      type: AGENT_PLAN_FILE_TYPE,
    });
    if (planDocument) {
      const todos = normalizeTodosState(
        planDocument.metadata?.todos,
        planDocument.updatedAt.toISOString(),
      );
      if (todos !== undefined) return { enabled: true, todos };
    }
  } catch (error) {
    log('Failed to resolve plan TODO context for topic %s: %O', topicId, error);
  }

  return undefined;
};

const loadCredsList = async (ctx: RuntimeExecutorContext): Promise<string> => {
  if (!ctx.userId) return '';

  try {
    const marketService = new MarketService({ userInfo: { userId: ctx.userId } });
    // Inside a workspace, the agent must only see the workspace's shared
    // organization credentials — personal creds are not visible here.
    const credsResult = ctx.workspaceId
      ? await marketService.market.organizations.creds({ workspaceId: ctx.workspaceId }).list()
      : await marketService.market.creds.list();
    const userCreds = (credsResult as any)?.data ?? [];
    const credsListStr = generateCredsList(
      userCreds.map((cred: any): CredSummary => ({
        description: cred.description,
        key: cred.key,
        name: cred.name,
        ownerDisplayName: cred.ownerDisplayName,
        ownerType: cred.ownerType,
        type: cred.type,
      })),
    );
    log('Fetched %d creds for {{CREDS_LIST}} substitution', userCreds.length);
    return credsListStr;
  } catch (error) {
    log('Failed to fetch creds for {{CREDS_LIST}} substitution: %O', error);
    return '';
  }
};

const loadComposioServicesList = async (
  ctx: RuntimeExecutorContext,
  agentId: string | undefined,
): Promise<string> => {
  if (!ctx.serverDB || !ctx.userId || !composioEnv.COMPOSIO_API_KEY) return '';

  try {
    // Connected = ACTIVE Composio connections across BOTH the legacy plugin
    // projection AND the connector table (agent-scoped connections live only
    // in the latter — see loadConnectedComposioIds).
    const connectedIds = await loadConnectedComposioIds(
      ctx.serverDB,
      ctx.userId,
      ctx.workspaceId,
      agentId,
    );
    // Disabled services are dropped from both lists — not surfaced as
    // "connected, use directly" nor as "available to connect".
    let disabledIdSet = new Set<string>();
    if (agentId) {
      const agentModel = new AgentModel(ctx.serverDB, ctx.userId, ctx.workspaceId);
      const agentConfig = await agentModel.getAgentConfigById(agentId);
      disabledIdSet = new Set(getDisabledPluginIds(agentConfig?.plugins ?? undefined));
    }
    const connected: ComposioServiceSummary[] = excludeDisabledComposioServices(
      COMPOSIO_APP_TYPES.filter((tool) => connectedIds.has(tool.identifier)),
      disabledIdSet,
    ).map((tool) => ({ identifier: tool.identifier, name: tool.label }));
    const available = resolveAvailableComposioServices(
      COMPOSIO_APP_TYPES,
      connectedIds,
      disabledIdSet,
    );
    log(
      'Fetched Composio services for {{COMPOSIO_SERVICES_LIST}}: connected=%d, available=%d',
      connected.length,
      available.length,
    );
    return generateComposioServicesList(connected, available);
  } catch (error) {
    log('Failed to fetch Composio services for {{COMPOSIO_SERVICES_LIST}} substitution: %O', error);
    return '';
  }
};

const loadCredsVariables = async (ctx: RuntimeExecutorContext, agentId: string | undefined) => {
  const [credsListStr, composioServicesListStr] = await Promise.all([
    loadCredsList(ctx),
    loadComposioServicesList(ctx, agentId),
  ]);
  return { composioServicesListStr, credsListStr };
};

const loadAgentBuilderContext = async (
  ctx: RuntimeExecutorContext,
  editingAgentId: string | undefined,
): Promise<AgentBuilderContext | undefined> => {
  if (!editingAgentId || !ctx.serverDB || !ctx.userId) return undefined;

  try {
    const editingAgentModel = new AgentModel(ctx.serverDB, ctx.userId, ctx.workspaceId);
    const editingConfig = (await editingAgentModel.getAgentConfigById(editingAgentId)) as Record<
      string,
      any
    > | null;
    if (!editingConfig) return undefined;

    const enabledPlugins: string[] = getActivePluginIds(
      Array.isArray(editingConfig.plugins) ? editingConfig.plugins : undefined,
    );
    const composioIdentifiers = new Set(COMPOSIO_APP_TYPES.map((tool) => tool.identifier));
    const officialTools: OfficialToolItem[] = [];

    for (const tool of builtinTools) {
      if (tool.hidden) continue;
      if (composioIdentifiers.has(tool.identifier)) continue;
      officialTools.push({
        description: tool.manifest?.meta?.description,
        enabled: enabledPlugins.includes(tool.identifier),
        identifier: tool.identifier,
        installed: true,
        name: tool.manifest?.meta?.title || tool.identifier,
        type: 'builtin',
      });
    }

    if (composioEnv.COMPOSIO_API_KEY) {
      try {
        // Agent-scoped connections aren't in the plugin table — union the
        // connector table so the builder marks them installed too.
        const connectedComposioIds = await loadConnectedComposioIds(
          ctx.serverDB,
          ctx.userId,
          ctx.workspaceId,
          editingAgentId,
        );
        for (const tool of COMPOSIO_APP_TYPES) {
          officialTools.push({
            description: `LobeHub Mcp Server: ${tool.label}`,
            enabled: enabledPlugins.includes(tool.identifier),
            identifier: tool.identifier,
            installed: connectedComposioIds.has(tool.identifier),
            name: tool.label,
            type: 'composio',
          });
        }
      } catch (composioError) {
        log('Failed to load Composio status for agentBuilderContext: %O', composioError);
      }
    }

    return {
      config: {
        chatConfig: editingConfig.chatConfig ?? undefined,
        model: editingConfig.model ?? undefined,
        openingMessage: editingConfig.openingMessage ?? undefined,
        openingQuestions: editingConfig.openingQuestions ?? undefined,
        params: editingConfig.params ?? undefined,
        plugins: enabledPlugins,
        provider: editingConfig.provider ?? undefined,
        systemRole: editingConfig.systemRole ?? undefined,
      },
      meta: {
        avatar: editingConfig.avatar ?? undefined,
        backgroundColor: editingConfig.backgroundColor ?? undefined,
        description: editingConfig.description ?? undefined,
        tags: editingConfig.tags ?? undefined,
        title: editingConfig.title ?? undefined,
      },
      ...(officialTools.length > 0 && { officialTools }),
    };
  } catch (error) {
    log('Failed to build agentBuilderContext for editing agent %s: %O', editingAgentId, error);
    return undefined;
  }
};

const buildServerCallLlmContextInner = async ({
  ctx,
  llmPayload,
  model,
  provider,
  state,
  tooling,
}: BuildServerCallLlmContextInput): Promise<ServerCallLlmContextBuildResult> => {
  const agentConfig = ctx.agentConfig;
  if (!agentConfig) {
    return {
      processedMessages: llmPayload.messages as ChatStreamPayload['messages'],
      shouldReplayAssistantReasoning: false,
    };
  }

  const { operationId, stepIndex } = ctx;
  const { resolved, resolvedSkills, toolDiscoveryConfig } = tooling;
  const agentId = state.metadata?.agentId;

  // Build additional placeholder variables for the lobehub builtin skill
  // (`packages/builtin-skills/src/lobehub/content.ts`) so it can render
  // `{{agent_id}}` / `{{agent_title}}` / `{{topic_id}}` etc. into the
  // model's prompt without needing a separate context injector.
  const lobehubSkillAgentId = state.metadata?.agentId;
  const lobehubSkillTopicId = ctx.topicId ?? state.metadata?.topicId;
  const lobehubSkillAgentMeta = state.metadata?.agentConfig as
    { description?: string | null; title?: string | null } | undefined;

  const sandboxEnabled = String(resolved.enabledToolIds.includes('lobe-cloud-sandbox'));

  // Start the creds lookups alongside everything else when the prompt sources
  // known up front already reference them; otherwise decide after assembly.
  const loadCredsUpFront = containsCredsPlaceholder([
    agentConfig.systemRole,
    Object.values(resolved.promptManifestMap),
    resolvedSkills?.enabledSkills,
    llmPayload.messages,
  ]);

  const contextHintsPromise = resolveServerCallLlmContextHints({
    ctx,
    llmPayload,
    model,
    provider,
  });
  const messagesForContextPromise = contextHintsPromise.then((hints) => hints.messagesForContext);

  const [
    contextHints,
    topicReferences,
    agentDocuments,
    onboardingContext,
    lobehubSkillTopicTitle,
    { serverLanguage, serverUsername },
    sandboxUploadedFiles,
    planTodo,
    agentBuilderContext,
    upFrontCredsVariables,
  ] = await Promise.all([
    contextHintsPromise,
    messagesForContextPromise.then((messages) => loadTopicReferences(ctx, messages)),
    loadAgentDocuments(ctx, state, agentId),
    messagesForContextPromise.then((messages) =>
      loadOnboardingContext({ agentId, ctx, messages, resolved, state }),
    ),
    loadTopicTitle(ctx, lobehubSkillTopicId),
    loadUserInfoVariables(ctx),
    loadSandboxUploadedFiles(ctx, sandboxEnabled, lobehubSkillTopicId),
    messagesForContextPromise.then((messages) =>
      loadPlanTodo({ ctx, messages, resolved, state, topicId: lobehubSkillTopicId }),
    ),
    loadAgentBuilderContext(ctx, state.metadata?.editingAgentId),
    loadCredsUpFront ? loadCredsVariables(ctx, agentId) : undefined,
  ]);

  const {
    capabilities,
    messagesForContext,
    modelDisplayName,
    modelKnowledgeCutoff,
    preserveThinkingForPayload,
    resolvedExtendParams,
    shouldReplayAssistantReasoning,
  } = contextHints;

  const lobehubSkillVariables: Record<string, string> = {
    agent_description: lobehubSkillAgentMeta?.description ?? '',
    agent_id: lobehubSkillAgentId ?? '',
    agent_title: lobehubSkillAgentMeta?.title ?? '',
    topic_id: lobehubSkillTopicId ?? '',
    topic_title: lobehubSkillTopicTitle,
  };

  const sessionDate = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'long',
    timeZone: ctx.userTimezone || 'UTC',
    weekday: 'long',
    year: 'numeric',
  }).format(new Date());

  const memoryEffort = String(
    (state.metadata?.agentConfig as any)?.chatConfig?.memory?.effort ?? '',
  );

  const contextEngineInput = {
    agentDocuments,
    ...(agentBuilderContext && { agentBuilderContext }),
    agentGroup: state.metadata?.agentGroup as AgentGroupConfig | undefined,
    agentManagementContext: (state as any).initialContext?.initialContext?.mentionedAgents?.length
      ? {
          mentionedAgents: (state as any).initialContext.initialContext.mentionedAgents,
        }
      : undefined,
    additionalVariables: {
      ...state.metadata?.deviceSystemInfo,
      ...lobehubSkillVariables,
      COMPOSIO_SERVICES_LIST: upFrontCredsVariables?.composioServicesListStr ?? '',
      CREDS_LIST: upFrontCredsVariables?.credsListStr ?? '',
      language: serverLanguage,
      memory_effort: memoryEffort,
      sandbox_enabled: sandboxEnabled,
      sandbox_uploaded_files: sandboxUploadedFiles,
      session_date: sessionDate,
      username: serverUsername,
    },
    userTimezone: ctx.userTimezone,
    capabilities,
    botPlatformContext: ctx.botPlatformContext,
    discordContext: ctx.discordContext,
    enableHistoryCount: agentConfig.chatConfig?.enableHistoryCount ?? undefined,
    evalContext: ctx.evalContext,
    forceFinish: state.forceFinish,
    historyCount: resolveRuntimeHistoryCount(agentConfig.chatConfig?.historyCount),
    initialContext: (state as any).initialContext?.initialContext,
    knowledge: {
      fileContents: agentConfig.files
        ?.filter((file: { enabled?: boolean | null }) => file.enabled === true)
        .map((file: { content?: string | null; id?: string; name?: string }) => ({
          content: file.content ?? '',
          fileId: file.id ?? '',
          filename: file.name ?? '',
        })),
      knowledgeBases: agentConfig.knowledgeBases
        ?.filter((knowledgeBase: { enabled?: boolean | null }) => knowledgeBase.enabled === true)
        .map((knowledgeBase: { id?: string; name?: string }) => ({
          id: knowledgeBase.id ?? '',
          name: knowledgeBase.name ?? '',
        })),
    },
    messages: messagesForContext,
    model,
    modelDisplayName,
    modelKnowledgeCutoff,
    provider,
    ...(planTodo && { planTodo }),
    systemRole: agentConfig.systemRole ?? undefined,
    toolDiscoveryConfig,
    toolsConfig: {
      manifests: Object.values(resolved.promptManifestMap),
      tools: resolved.enabledToolIds,
    },
    userMemory: state.metadata?.userMemory,
    ...(resolvedSkills?.enabledSkills?.length && {
      skillsConfig: { enabledSkills: resolvedSkills.enabledSkills },
    }),
    enableAgentMode: agentConfig.chatConfig?.enableAgentMode,
    ...(topicReferences && { topicReferences }),
    ...(onboardingContext && { onboardingContext }),
  };

  if (!upFrontCredsVariables && containsCredsPlaceholder(contextEngineInput)) {
    const { composioServicesListStr, credsListStr } = await loadCredsVariables(ctx, agentId);
    contextEngineInput.additionalVariables.COMPOSIO_SERVICES_LIST = composioServicesListStr;
    contextEngineInput.additionalVariables.CREDS_LIST = credsListStr;
  }

  const processedMessages = await agentRuntimeTracer.startActiveSpan(
    CONTEXT_ENGINEERING_SPAN_NAME,
    {
      attributes: buildContextEngineeringAttributes({
        hasImages: (messagesForContext as Array<{ content?: unknown }>).some(
          (message) =>
            Array.isArray(message.content) &&
            (message.content as Array<{ type?: string }>).some(
              (part) => part?.type === 'image_url',
            ),
        ),
        historyCompressed:
          Array.isArray(messagesForContext) &&
          messagesForContext.some(
            (message: { role?: string }) => message?.role === 'compressedGroup',
          ),
        knowledgeCount:
          (contextEngineInput.knowledge?.knowledgeBases?.length ?? 0) +
          (contextEngineInput.knowledge?.fileContents?.length ?? 0),
        knowledgeInjected:
          (contextEngineInput.knowledge?.knowledgeBases?.length ?? 0) > 0 ||
          (contextEngineInput.knowledge?.fileContents?.length ?? 0) > 0,
        memoryInjected: Boolean(contextEngineInput.userMemory?.memories),
        messageCount: messagesForContext.length,
        operationId,
        stepIndex,
        systemRoleLength: contextEngineInput.systemRole?.length,
        toolCount: contextEngineInput.toolsConfig?.tools?.length ?? 0,
      }),
    },
    async (ceSpan) => {
      try {
        const result = await serverMessagesEngine(contextEngineInput);
        ceSpan.setAttribute('lobehub.context.message_count', result.length);
        return result;
      } catch (error) {
        ceSpan.recordException(error as Error);
        ceSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        ceSpan.end();
      }
    },
  );

  const {
    messages: _inputMsgs,
    toolsConfig: _toolsConfig,
    ...contextEngineInputLite
  } = contextEngineInput;
  ctx.tracingContextEngine?.(
    { ...contextEngineInputLite, toolCount: _toolsConfig?.tools?.length ?? 0 },
    processedMessages,
  );

  return {
    preserveThinkingForPayload,
    processedMessages,
    resolvedExtendParams,
    shouldReplayAssistantReasoning,
  };
};
