import type { SelectAllState } from './store/initialState';

/**
 * Whether the dragged row is part of the current selection.
 *
 * In "select all" mode `selectedFileIds` holds the rows the user *un*-checked,
 * so membership is inverted: dragging an excluded row moves only that row, and
 * dragging any other row moves the whole selection.
 */
export const isDragInSelection = (
  dragId: string,
  selectedFileIds: string[],
  selectAllState: SelectAllState,
): boolean =>
  selectAllState === 'all' ? !selectedFileIds.includes(dragId) : selectedFileIds.includes(dragId);

/** How many rows the drag overlay should say are being moved. */
export const getDragSelectionCount = (
  selectedFileIds: string[],
  selectAllState: SelectAllState,
  selectionTotal: number | undefined,
): number =>
  selectAllState === 'all'
    ? Math.max((selectionTotal ?? 0) - selectedFileIds.length, 0)
    : selectedFileIds.length;
