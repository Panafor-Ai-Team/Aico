import { OPENROUTER_AUTO_MODEL_ID } from '@lobechat/business-const';
import { useEffect, useRef } from 'react';

import { useAgentId } from '@/features/ChatInput/hooks/useAgentId';
import { useAgentModelSelection } from '@/features/ChatInput/hooks/useAgentModelSelection';
import { useEnabledChatModelsState } from '@/hooks/useEnabledChatModels';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';
import { aiProviderSelectors, useAiInfraStore } from '@/store/aiInfra';
import { type EnabledProviderWithModels } from '@/types/aiProvider';

interface ModelSelection {
  model: string;
  provider: string;
}

/**
 * Whether the model is selectable in the given list.
 */
export const isModelInList = (
  list: EnabledProviderWithModels[],
  model: string,
  provider: string,
): boolean =>
  Boolean(list.find((item) => item.id === provider)?.children.some((item) => item.id === model));

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
 * Auto-switch the agent's model once its current model drops out of the
 * settled enabled list — wallet switch, admin revocation/disable, or model
 * deletion. Without this the chatbox sits on the "model unavailable" warning
 * until the user picks manually.
 *
 * Fires only on a settled valid→missing transition (not on mount with an
 * already-missing model, not on deprecations seen at cold load, not on
 * loading flashes), only against a settled list, and never for locked
 * selections (fixed agents, use-only access) — `selectModel` itself also
 * refuses those.
 */
export const useAutoSwitchUnavailableModel = () => {
  const agentId = useAgentId();
  const { canSelectModel, isPreferenceLoading, model, provider, selectionPolicy, selectModel } =
    useAgentModelSelection(agentId);
  const { isPending: isModelListPending, list: enabledChatModelList } = useEnabledChatModelsState();
  const isAgentConfigLoading = useAgentStore(agentByIdSelectors.isAgentConfigLoadingById(agentId));
  const isModelConfigReady = useAiInfraStore((s) =>
    aiProviderSelectors.isInitAiProviderRuntimeState(s),
  );

  const isMemberOverridePending = selectionPolicy === 'member' && isPreferenceLoading;
  const isSettled =
    isModelConfigReady && !isAgentConfigLoading && !isMemberOverridePending && !isModelListPending;

  const inList =
    isSettled && model && provider
      ? isModelInList(enabledChatModelList, model, provider)
      : undefined;

  // Last settled validity; stays untouched while unsettled so a reload that
  // lands on a shrunken list still reconciles instead of re-baselining.
  const wasInListRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    if (!isSettled || !canSelectModel || !model || !provider || inList === undefined) return;
    const was = wasInListRef.current;
    wasInListRef.current = inList;
    if (was !== true || inList) return;
    const fallback = pickUnavailableModelFallback(enabledChatModelList);
    if (!fallback) return;
    void selectModel(fallback);
  }, [canSelectModel, enabledChatModelList, inList, isSettled, model, provider, selectModel]);
};
