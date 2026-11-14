import { AGENT_CHAT_TOPIC_URL, AGENT_CHAT_URL } from '@lobechat/const';
import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { buildTaskHandoffPath } from '@/features/AgentTaskManager/taskHandoff';
import { getDraft, saveDraft } from '@/features/ChatInput/draftStorage';
import type { SendButtonHandler } from '@/features/ChatInput/store/initialState';
import { buildMessageContextSelections } from '@/features/ChatInput/utils/contextSelections';
import { useResourceAccess } from '@/features/ResourcePermission/useResourceAccess';
import { useHomeDailyBrief } from '@/hooks/useHomeDailyBrief';
import { usePermission } from '@/hooks/usePermission';
import { useQueryRoute } from '@/hooks/useQueryRoute';
import { agentService } from '@/services/agent';
import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';
import { useChatStore } from '@/store/chat';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';
import { fileChatSelectors, useFileStore } from '@/store/file';
import { useGlobalStore } from '@/store/global';
import { useHomeStore } from '@/store/home';
import { useTaskStore } from '@/store/task';
import type { UploadFileItem } from '@/types/files/upload';

import { useResolvedHomeAgentId } from '../AgentSelect/useResolvedHomeAgentId';
import type { HomeMode } from '../types';
import { taskNameFromMessage } from './taskName';

/**
 * Trim trailing ellipsis the LLM uses on hint placeholders so the sent
 * message doesn't carry the cosmetic suffix.
 */
const stripHintEllipsis = (hint: string): string => hint.replace(/\s*(?:\.{3,}|…)\s*$/, '').trim();

/**
 * Task attachments live in the instruction's Lexical state — the server
 * recovers fileIds from it (`extractFileIdsFromEditorData`) and forwards them
 * to the agent on every run. The home composer keeps picked files in a
 * separate store, so fold them in before the task row is written.
 */
const withUploadedFiles = (editorData: unknown, files: UploadFileItem[]): unknown => {
  const uploaded = files.filter((file) => !!file.fileUrl);
  if (uploaded.length === 0) return editorData;

  const data = (editorData ?? {}) as { root?: Record<string, unknown> };
  const root = data.root ?? { children: [], type: 'root', version: 1 };
  const existing = Array.isArray(root.children) ? root.children : [];

  const paragraphs = uploaded.map((file) => ({
    children: [
      {
        fileUrl: file.fileUrl,
        name: file.file?.name || file.id,
        size: file.file?.size,
        status: 'uploaded',
        type: 'file',
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  }));

  return { ...data, root: { ...root, children: [...paragraphs, ...existing] } };
};

/**
 * Make sure the agent's config is hydrated into `agentMap` before we call
 * `sendMessage`. Without this, sending to an agent the user just picked from
 * the home AgentSelect (and never opened in this session) silently fails:
 * `sendMessage` reaches `getAgentConfigById(agentId)` which returns `undefined`
 * from `agentMap`, the `{ model, provider }` destructure throws, and the
 * surrounding catch swallows it — so the chat page mounts with optimistic
 * messages but the runtime never starts.
 */
const ensureAgentConfigLoaded = async (agentId: string): Promise<void> => {
  const agentState = useAgentStore.getState();
  if (agentState.agentMap[agentId]) return;
  const config = await agentService.getAgentConfigById(agentId);
  if (config) agentState.internal_dispatchAgentMap(agentId, config);
};

type EditorDocument = Record<string, unknown>;

/**
 * Append `extra`'s top-level blocks after `base`'s. Both are serialized
 * editor states (`{ root: { children } }`); when either has another shape,
 * `base` is returned untouched so content the user already has is never lost.
 */
const appendEditorDocument = (base: EditorDocument, extra: EditorDocument): EditorDocument => {
  const baseRoot = base.root as { children?: unknown } | undefined;
  const extraRoot = extra.root as { children?: unknown } | undefined;
  if (!Array.isArray(baseRoot?.children) || !Array.isArray(extraRoot?.children)) return base;

  return {
    ...base,
    root: { ...baseRoot, children: [...baseRoot.children, ...extraRoot.children] },
  };
};

/**
 * Put a refused Home send back in the composer of the conversation it moved to.
 *
 * A Home send does not wait for the run to start: it navigates to the agent's
 * blank conversation and clears the Home editor immediately. When the server
 * then refuses the run (for example, the plan's concurrent-run limit),
 * `sendMessage` restores the text into the editor captured at send time, which
 * is the unmounted Home editor. The conversation composer reads its draft only
 * on mount or on a draft-key change, so without this the message is lost.
 *
 * - The conversation composer is mounted on that blank conversation: write
 *   into it.
 * - Otherwise: save it under the blank-conversation draft key, which the
 *   composer reads when it mounts.
 *
 * Either target may already hold content the user typed there; the refused
 * message is appended after it so neither is lost.
 */
const restoreRefusedSendToConversation = ({
  agentId,
  editorData,
  homeEditor,
}: {
  agentId: string;
  editorData: EditorDocument | undefined;
  /** The Home composer that sent the message; only its identity is compared. */
  homeEditor: unknown;
}) => {
  // A hint-only send has no typed content to give back.
  if (!editorData) return;

  const { activeAgentId, activeTopicId, mainInputEditor } = useChatStore.getState();
  const conversationEditor =
    mainInputEditor && mainInputEditor !== homeEditor ? mainInputEditor : undefined;

  if (conversationEditor && activeAgentId === agentId && !activeTopicId) {
    const current = conversationEditor.getJSONState();
    conversationEditor.setJSONState(
      conversationEditor.getMarkdownContent().trim() && current
        ? appendEditorDocument(current, editorData)
        : editorData,
    );
    return;
  }

  const draftKey = messageMapKey({ agentId, topicId: null });
  const existingDraft = getDraft(draftKey);
  saveDraft(draftKey, existingDraft ? appendEditorDocument(existingDraft, editorData) : editorData);
};

interface PendingTaskRun {
  agentId: string;
  identifier: string;
  instruction: string;
  workspaceId: string | null;
}

export const useSend = (mode: HomeMode = 'chat') => {
  const { t } = useTranslation('home');
  const router = useQueryRoute();
  const activeWorkspaceId = useActiveWorkspaceId();
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const sendMessage = useChatStore((s) => s.sendMessage);
  const clearChatUploadFileList = useFileStore((s) => s.clearChatUploadFileList);
  const clearChatContextSelections = useFileStore((s) => s.clearChatContextSelections);
  const restoreChatContextSelections = useFileStore((s) => s.restoreChatContextSelections);

  const homeInputLoading = useHomeStore((s) => s.homeInputLoading);
  const createTask = useTaskStore((s) => s.createTask);
  const runTask = useTaskStore((s) => s.runTask);
  const toggleTaskAgentPanel = useGlobalStore((s) => s.toggleTaskAgentPanel);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pendingTaskRunRef = useRef<PendingTaskRun | null>(null);

  const inboxAgentId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const { agentId: selectedAgentId } = useResolvedHomeAgentId();
  const agentId = selectedAgentId;
  const contextSelectionKey = `home:${mode}:${selectedAgentId ?? 'unresolved'}`;
  const { allowed: canCreateContent } = usePermission('create_content');
  const agentVisibility = useAgentStore((s) =>
    selectedAgentId ? s.agentMap[selectedAgentId]?.visibility : undefined,
  );
  const gatedResourceId =
    selectedAgentId && selectedAgentId !== inboxAgentId && agentVisibility !== 'private'
      ? selectedAgentId
      : undefined;
  const { canUseResource } = useResourceAccess('agent', gatedResourceId);

  // Daily-brief hint paired with the fixed Home greeting. Pressing Enter on an
  // empty input accepts that hint without changing the visible pair.
  const { currentPair } = useHomeDailyBrief();

  const send = useCallback<SendButtonHandler>(
    async ({ getEditorData, getMarkdownContent }) => {
      const { inputMessage, mainInputEditor } = useChatStore.getState();
      // Prefer the live editor content over the cached `inputMessage`.
      // `onMarkdownContentChange` is wired through the editor's async
      // `onChange`, so a fast type-then-Enter sequence can fire before the
      // cache catches up and the empty-message guard would bail incorrectly.
      const typed = (getMarkdownContent?.() ?? inputMessage ?? '').trim();
      const fileList = fileChatSelectors.chatUploadFileList(useFileStore.getState());
      const contextList = fileChatSelectors.chatContextSelections(contextSelectionKey)(
        useFileStore.getState(),
      );
      const { sendAsAgent, sendAsGroup, sendAsWrite, sendAsResearch, inputActiveMode } =
        useHomeStore.getState();

      // If the user pressed Enter on an empty input, fall back to the
      // currently displayed daily-brief hint (with cosmetic ellipsis stripped)
      // and rotate the carousel so the next press shows / sends a different
      // pair.
      const hint = mode === 'chat' && currentPair?.hint ? stripHintEllipsis(currentPair.hint) : '';
      const usedHint = !typed && !!hint;
      const message = typed || hint;

      // When falling back to the hint, the editor is empty — but its JSON
      // state still contains root nodes (e.g. `{ type: 'doc' }`), which is
      // truthy under `Object.keys(editorData).length > 0`. That makes the
      // user-message renderer take the RichTextMessage branch and draw
      // nothing, so the chat shows a blank user bubble while the agent
      // happily processes the hint text. Skip editorData in that case so
      // the renderer falls back to the markdown `content`.
      const editorData = usedHint
        ? undefined
        : (getEditorData?.() ?? mainInputEditor?.getJSONState());

      if (!canCreateContent) return;

      if ((mode === 'task' || !inputActiveMode) && !canUseResource) return;

      // Task persistence does not support selected context yet. Check this
      // before the empty-message guard so a context-only submission explains
      // why it cannot proceed instead of appearing inert.
      if (mode === 'task' && contextList.length > 0) {
        toast.error(t('dashboard.task.unsupportedContext'));
        return;
      }

      // Require input content (except for default inbox which can have files/context)
      if (!message && fileList.length === 0 && contextList.length === 0) return;

      let submitted = false;
      try {
        const { contextSelections, pageSelections } = buildMessageContextSelections(contextList);

        // Task mode is a commitment, not a proposal: the row is written and the
        // run is launched here. Routing it through the agent would leave both
        // outcomes to a model that is told elsewhere not to start work on its
        // own — pressing send in this mode IS the instruction to start.
        if (mode === 'task') {
          // The task instruction is required server-side, so an
          // attachment-only submission has nothing to run.
          if (!message) {
            toast.error(t('dashboard.task.instructionRequired'));
            return;
          }
          if (!selectedAgentId) return;
          setIsSubmitting(true);
          const pendingTaskRun = pendingTaskRunRef.current;
          const canRetryPendingTask =
            pendingTaskRun?.agentId === selectedAgentId &&
            pendingTaskRun.instruction === message &&
            pendingTaskRun.workspaceId === (activeWorkspaceId ?? null);

          let taskRun = canRetryPendingTask ? pendingTaskRun : null;
          if (!taskRun) {
            const created = await createTask({
              assigneeAgentId: selectedAgentId,
              editorData: withUploadedFiles(editorData, fileList),
              instruction: message,
              name: taskNameFromMessage(message),
              visibility: activeWorkspaceId ? 'private' : undefined,
            });
            if (!created?.identifier) throw new Error('Task creation returned no identifier');
            taskRun = {
              agentId: created.assigneeAgentId ?? selectedAgentId,
              identifier: created.identifier,
              instruction: message,
              workspaceId: activeWorkspaceId ?? null,
            };
            pendingTaskRunRef.current = taskRun;
          }

          const result = await runTask(taskRun.identifier, undefined, { throwOnError: true });
          if (!result?.topicId) throw new Error('Task run did not return a topic');
          pendingTaskRunRef.current = null;
          submitted = true;
          toggleTaskAgentPanel(true);
          router.push(buildTaskHandoffPath(taskRun.agentId, result.topicId));
          return;
        }

        switch (inputActiveMode) {
          case 'agent': {
            await sendAsAgent({
              contextSelections,
              editorData,
              message,
              pageSelections,
              workspaceSlug: activeWorkspaceSlug,
            });
            submitted = true;
            break;
          }

          case 'group': {
            await sendAsGroup({
              contextSelections,
              editorData,
              message,
              pageSelections,
              workspaceSlug: activeWorkspaceSlug,
            });
            submitted = true;
            break;
          }

          case 'write': {
            await sendAsWrite({
              contextSelections,
              editorData,
              message,
              pageSelections,
              workspaceSlug: activeWorkspaceSlug,
            });
            submitted = true;
            break;
          }

          case 'research': {
            await sendAsResearch(message);
            submitted = true;
            break;
          }

          default: {
            if (!selectedAgentId) return;

            await ensureAgentConfigLoaded(selectedAgentId);

            sendMessage({
              context: {
                agentId: selectedAgentId,
                isolatedTopic: true,
                ...(activeWorkspaceSlug ? { workspaceSlug: activeWorkspaceSlug } : {}),
              },
              contextSelections,
              contexts: contextList,
              editorData,
              files: fileList,
              // The Home editor is unmounted once the route commits. Naming it
              // here keeps the send lifecycle's failure restore out of the
              // conversation composer, which `onPreflightFailure` fills below —
              // otherwise the same text lands there twice.
              inputEditor: mainInputEditor,
              message,
              onPreflightFailure: () => {
                restoreChatContextSelections(contextSelectionKey, contextList);
                restoreRefusedSendToConversation({
                  agentId: selectedAgentId,
                  editorData,
                  homeEditor: mainInputEditor,
                });
                // The Home composer's uploads were cleared with it — hand them
                // back so a refused send does not also drop the attachments.
                const fileStore = useFileStore.getState();
                const attachedIds = new Set(fileStore.chatUploadFileList.map((item) => item.id));
                const missingFiles = fileList.filter((item) => !attachedIds.has(item.id));
                if (missingFiles.length > 0)
                  fileStore.dispatchChatUploadFileList({ files: missingFiles, type: 'addFiles' });
              },
              onTopicCreated: (topicId) => {
                router.replace(AGENT_CHAT_TOPIC_URL(selectedAgentId, topicId, false));
                // The route commits as a transition, after sendMessage has already dropped
                // the temp messages from the new-topic key; without an urgent switch the
                // open chat paints its empty welcome state for a few frames.
                if (useChatStore.getState().activeAgentId === selectedAgentId) {
                  useChatStore.setState(
                    { activeTopicId: topicId },
                    false,
                    'Home/useSend/switchToCreatedTopic',
                  );
                }
              },
              pageSelections,
            });

            submitted = true;
            router.push(AGENT_CHAT_URL(selectedAgentId, false));
          }
        }
      } catch (error) {
        console.error('[home:send]', error);
        toast.error(t('dashboard.submitFailed'));
      } finally {
        // Preserve the complete draft when creation or execution fails. The
        // editor, files and context are one unit from the user's perspective.
        if (submitted) {
          clearChatUploadFileList();
          clearChatContextSelections(contextSelectionKey);
          mainInputEditor?.clearContent();
        }
        setIsSubmitting(false);
      }
    },
    [
      activeWorkspaceSlug,
      activeWorkspaceId,
      sendMessage,
      clearChatContextSelections,
      restoreChatContextSelections,
      clearChatUploadFileList,
      contextSelectionKey,
      router,
      currentPair,
      mode,
      createTask,
      runTask,
      toggleTaskAgentPanel,
      inboxAgentId,
      selectedAgentId,
      canUseResource,
      canCreateContent,
      t,
    ],
  );

  return {
    agentId,
    contextSelectionKey,
    loading: homeInputLoading || isSubmitting,
    send,
  };
};
