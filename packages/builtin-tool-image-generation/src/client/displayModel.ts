/**
 * User-facing model label for chat image generation.
 *
 * Never include the runtime provider (`openrouter` / `aico`) — Aico treats
 * those as managed billing slots, not something to surface in the UI.
 */
export const formatImageGenerationModelLabel = (
  model?: null | string,
  _provider?: null | string,
): string | undefined => {
  const trimmed = model?.trim();
  return trimmed || undefined;
};
