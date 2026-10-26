/**
 * CheapVibeCode models whose measured charge counts reasoning tokens a second
 * time (`deepseek-v4.1-flash` ~x0.433 against a published x0.3, `mimo-v2.5`
 * ~x0.072 against x0.05). See docs/aico/CHEAPVIBECODE_PROVIDER_PROBE.md section 3:
 * no field in `/v1/models` predicts which models do this, so the list is
 * measured, not derived.
 *
 * One list for both sides: the usage ledger charges by it, and the model picker
 * uses it to say the published coefficient understates the real cost.
 */
export const REASONING_BILLED_TWICE_MODEL_IDS: readonly string[] = [
  'deepseek-v4.1-flash',
  'mimo-v2.5',
];

export const isReasoningBilledTwice = (modelId?: string | null): boolean =>
  !!modelId && REASONING_BILLED_TWICE_MODEL_IDS.includes(modelId);
