import { MANAGED_PROVIDER_IDS, OPENROUTER_AUTO_MODEL_ID } from '@lobechat/business-const';
import { useEffect } from 'react';

import { useAgentId } from '@/features/ChatInput/hooks/useAgentId';
import { useAgentModelSelection } from '@/features/ChatInput/hooks/useAgentModelSelection';
import { useEnabledChatModelsState } from '@/hooks/useEnabledChatModels';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';
import { aiProviderSelectors, useAiInfraStore } from '@/store/aiInfra';
import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/slices/topic/selectors';
import { type EnabledProviderWithModels } from '@/types/aiProvider';

interface ModelSelection {
  model: string;
  provider: string;
}

/**
 * Managed runtime ids all resolve to the live gateway at request time, so a
 * stored `openrouter/<model>` selection keeps working after a gateway cutover
 * to `cheapvibecode` (and vice versa) — as long as the model id itself is
 * still offered. Without this, a cutover reads as "every session revoked".
 */
const MANAGED_RUNTIME_PROVIDER_IDS: ReadonlySet<string> = new Set([
  ...MANAGED_PROVIDER_IDS,
  'aico',
  'lobehub',
]);

const isManagedRuntimeProviderId = (id: string): boolean =>
  MANAGED_RUNTIME_PROVIDER_IDS.has(id.trim().toLowerCase());

/**
 * Whether the model is selectable in the given list: exact provider match,
 * or — for managed traffic only — the same model id under any managed
 * provider alias (see above).
 */
export const isModelInList = (
  list: EnabledProviderWithModels[],
  model: string,
  provider: string,
): boolean => {
  if (list.find((item) => item.id === provider)?.children.some((item) => item.id === model)) {
    return true;
  }
  if (!isManagedRuntimeProviderId(provider)) return false;
  return list.some(
    (item) =>
      isManagedRuntimeProviderId(item.id) && item.children.some((child) => child.id === model),
  );
};

/**
 * Fallback model when the current one leaves the enabled list. Prefers the
 * Auto meta-router (always allow-listed in org mode, the product default
 * elsewhere), else the first listed chat model. Undefined when the list is
 * empty (then the unavailable-model notice stays).
 */
export const pickUnavailableModelFallback = (
  list: EnabledProviderWithModels[],
): ModelSelection | undefined => {
  for (const item of list) {
    const auto = item.children.find((child) => child.id === OPENROUTER_AUTO_MODEL_ID);
    if (auto) return { model: auto.id, provider: item.id };
  }
  const first = list.find((item) => item.children.length > 0);
  const child = first?.children[0];
  if (!first || !child) return undefined;
  return { model: child.id, provider: first.id };
};

/**
 * Auto-switch the session's model once its current model drops out of the
 * settled enabled list — wallet switch, admin revocation/disable, or model
 * deletion. Without this the chatbox sits on the "model unavailable" warning
 * until the user picks manually (and sends fail server-side).
 *
 * Judges the EFFECTIVE selection (active topic pin wins — it is what the
 * trigger shows and what the next send uses), not just the agent default:
 * judging the agent default parks revoked topic pins forever. On a switch,
 * both the agent default (when editable) and the topic pin are repaired, so
 * no stale reference survives.
 *
 * Fires on any settled-missing state — first sight included. "Missing" only
 * counts against a confirmed list (org allow-list/catalog actually loaded, see
 * `useEnabledChatModelsState`): a first-load error must never read as
 * "revoked" and clobber the user's model. Never fires for locked selections'
 * agent config (fixed agents, use-only access) — `selectModel` itself also
 * refuses those — but the user's own topic pin is still repaired, since the
 * alternative is every send failing.
 */
export const useAutoSwitchUnavailableModel = () => {
  const agentId = useAgentId();
  const { canSelectModel, isPreferenceLoading, model, provider, selectionPolicy, selectModel } =
    useAgentModelSelection(agentId);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const topicPin = useChatStore(topicSelectors.activeTopicModel);
  const updateTopicModel = useChatStore((s) => s.updateTopicModel);
  const {
    isDataConfirmed,
    isPending: isModelListPending,
    list: enabledChatModelList,
  } = useEnabledChatModelsState();
  const isAgentConfigLoading = useAgentStore(agentByIdSelectors.isAgentConfigLoadingById(agentId));
  const isModelConfigReady = useAiInfraStore((s) =>
    aiProviderSelectors.isInitAiProviderRuntimeState(s),
  );

  const isMemberOverridePending = selectionPolicy === 'member' && isPreferenceLoading;
  const isSettled =
    isModelConfigReady &&
    !isAgentConfigLoading &&
    !isMemberOverridePending &&
    !isModelListPending &&
    isDataConfirmed;

  // Per-level absence (agent default vs active topic pin — the pin is what
  // the trigger shows and what the next send uses), so a healthy agent
  // default is never rewritten just because the topic pin died (and vice
  // versa). Judging only the agent default parks revoked topic pins forever.
  const agentMissing =
    isSettled && !!model && !isModelInList(enabledChatModelList, model, provider ?? '');
  const pinMissing =
    isSettled &&
    !!topicPin &&
    !isModelInList(enabledChatModelList, topicPin.model, topicPin.provider);

  useEffect(() => {
    if (!isSettled || (!agentMissing && !pinMissing)) return;
    const fallback = pickUnavailableModelFallback(enabledChatModelList);
    if (!fallback) return;
    if (agentMissing && canSelectModel) void selectModel(fallback);
    // Re-pin the topic when ITS pin was the missing one. Topic rows are
    // per-user state (unlike shared agent config), so this is safe even for
    // locked selections — the alternative is every send failing.
    if (activeTopicId && topicPin && pinMissing) void updateTopicModel(activeTopicId, fallback);
  }, [
    activeTopicId,
    agentMissing,
    canSelectModel,
    enabledChatModelList,
    isSettled,
    pinMissing,
    selectModel,
    topicPin,
    updateTopicModel,
  ]);
};
