type ModelOption = { label: string; value: string };

/**
 * Narrows options to a search-matched subset, but always keeps already-selected
 * ids in — otherwise the underlying multi-select unmounts their items while
 * filtering and drops them from the value on the next pick (repro: search,
 * then click an unrelated match — prior selections vanish because the base-ui
 * Select loses items it can no longer see).
 */
export const filterModelOptionsKeepingSelected = (
  options: ModelOption[],
  query: string,
  selectedIds: string[],
): ModelOption[] => {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (option) =>
      selectedIds.includes(option.value) ||
      option.label.toLowerCase().includes(q) ||
      option.value.toLowerCase().includes(q),
  );
};
