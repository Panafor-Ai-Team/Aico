type ModelOption = { label: string; value: string };

/**
 * Options still available to add — i.e. not already granted. The "add a
 * model" picker is a single-value combobox that always resets after a pick
 * (see TeamModelsForm), so it never has to juggle a multi-value selection
 * while the vendor Select's built-in search narrows the visible list —
 * that combination is what dropped already-granted models in the old
 * multi-select implementation.
 */
export const excludeSelectedModelOptions = (
  options: ModelOption[],
  selectedIds: string[],
): ModelOption[] => options.filter((option) => !selectedIds.includes(option.value));
