import { OPENROUTER_AUTO_MODEL_ID } from '@lobechat/business-const';
import { useEffect, useRef } from 'react';

import { useAicoBillingStore } from '@/features/AicoBilling/store';
import { billingContextKey } from '@/features/AicoBilling/types';
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
 * Fallback model for a freshly switched wallet whose list lacks the current
 * model. Prefers the Auto meta-router (always allow-listed in org mode, the
 * product default elsewhere), else the first listed chat model. Undefined
 * when the list is empty (then the unavailable-model notice stays).
 */
export const pickBillingSwitchFallbackModel = (
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
 * Auto-switch the agent's model right after a wallet (billing context)
 * switch leaves the current model outside the newly enabled list — e.g.
 * personal → organization where the team allow-list lacks the model.
 * Without this the chatbox sits on the "model unavailable" warning until
 * the user picks manually.
 *
 * Only fires on an actual context change (not on deprecations or cold-load
 * flashes), only against a settled list, and never for locked selections
 * (fixed agents, use-only access) — `selectModel` itself also refuses those.
 */
export const useAutoSwitchModelOnBillingChange = () => {
  const agentId = useAgentId();
  const { canSelectModel, isPreferenceLoading, model, provider, selectionPolicy, selectModel } =
    useAgentModelSelection(agentId);
  const billingKey = useAicoBillingStore((s) =>
    s.context ? billingContextKey(s.context) : undefined,
  );
  const { isPending: isModelListPending, list: enabledChatModelList } = useEnabledChatModelsState();
  const isAgentConfigLoading = useAgentStore(agentByIdSelectors.isAgentConfigLoadingById(agentId));
  const isModelConfigReady = useAiInfraStore((s) =>
    aiProviderSelectors.isInitAiProviderRuntimeState(s),
  );

  const isMemberOverridePending = selectionPolicy === 'member' && isPreferenceLoading;
  const isSettled =
    isModelConfigReady && !isAgentConfigLoading && !isMemberOverridePending && !isModelListPending;

  // Set on every context change; cleared once a settled pass reconciles.
  // Survives unsettled renders (SWR allow-list still loading) so the switch
  // happens against the new list, never the stale one.
  const needsReconcileRef = useRef(false);
  const prevKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const prev = prevKeyRef.current;
    prevKeyRef.current = billingKey;
    if (prev !== undefined && prev !== billingKey) needsReconcileRef.current = true;
    if (!needsReconcileRef.current) return;
    if (!billingKey || !isSettled || !canSelectModel || !model || !provider) return;
    if (isModelInList(enabledChatModelList, model, provider)) {
      needsReconcileRef.current = false;
      return;
    }
    const fallback = pickBillingSwitchFallbackModel(enabledChatModelList);
    if (!fallback) return;
    needsReconcileRef.current = false;
    void selectModel(fallback);
  }, [billingKey, canSelectModel, enabledChatModelList, isSettled, model, provider, selectModel]);
};
