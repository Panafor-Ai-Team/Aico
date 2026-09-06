import {
  HETEROGENEOUS_TYPE_LABELS,
  isRemoteHeterogeneousType,
} from '@lobechat/heterogeneous-agents';

interface MessageModelNameInput {
  /** `displayName` of the resolved model card, when the model is known locally. */
  displayName?: string;
  model?: string | null;
  provider?: string | null;
}

interface MessageModelName {
  name?: string;
  /** Remote platform agents have no model id, so there is no icon to draw. */
  showIcon: boolean;
}

/**
 * Model identity for the cost hover card: the friendly display name when the
 * model card is known, the raw id otherwise. Remote platform agents (openclaw,
 * hermes) never expose a real model id and fall back to their brand label —
 * the same rule the inline Usage row applies.
 */
export const resolveMessageModelName = ({
  displayName,
  model,
  provider,
}: MessageModelNameInput): MessageModelName => {
  if (provider && isRemoteHeterogeneousType(provider)) {
    const brand = HETEROGENEOUS_TYPE_LABELS[provider];
    if (brand) return { name: brand, showIcon: false };
  }

  return { name: displayName || model || undefined, showIcon: !!model };
};
