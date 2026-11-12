import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TreeActionImpl } from './actions';
import type { TreeState } from './types';

const { mockRefreshFileList, mockResourceMove, mockStoreMove } = vi.hoisted(() => ({
  mockRefreshFileList: vi.fn(),
  mockResourceMove: vi.fn(),
  mockStoreMove: vi.fn(),
}));

const fileStoreState = {
  moveResource: mockStoreMove,
  refreshFileList: mockRefreshFileList,
  resourceMap: new Map<string, unknown>(),
};

vi.mock('@/services/resource', () => ({
  resourceService: {
    moveResource: mockResourceMove,
  },
}));

vi.mock('@/store/file', () => ({
  useFileStore: {
    getState: () => fileStoreState,
  },
}));

const createState = (): TreeState => ({
  children: {},
  epoch: 0,
  errors: {},
  expanded: {},
  init: vi.fn(),
  knowledgeBaseId: 'kb-1',
  loadChildren: vi.fn(),
  moveItem: vi.fn(),
  moveItems: vi.fn(),
  expandAncestors: vi.fn(),
  reconcile: vi.fn(),
  removeItems: vi.fn(),
  renameItem: vi.fn(),
  reset: vi.fn(),
  revalidate: vi.fn(),
  status: {},
  toggle: vi.fn(),
});

const createSetter = (getState: () => TreeState) => {
  return (
    partial:
      Partial<TreeState> | TreeState | ((state: TreeState) => Partial<TreeState> | TreeState),
  ) => {
    const next = typeof partial === 'function' ? partial(getState()) : partial;
    Object.assign(getState(), next);
  };
};

describe('TreeActionImpl.moveItem', () => {
  beforeEach(() => {
    mockRefreshFileList.mockReset();
    mockResourceMove.mockReset();
    mockStoreMove.mockReset();
    fileStoreState.resourceMap = new Map();
  });

  it('falls back to backend move when the source node is absent from tree cache', async () => {
    const state = createState();
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );
    const revalidateSpy = vi.spyOn(actions, 'revalidate').mockResolvedValue();

    await actions.moveItem('file-1', 'folder-a', 'folder-b');
    await Promise.resolve();

    expect(mockResourceMove).toHaveBeenCalledWith('file-1', 'folder-b');
    expect(mockRefreshFileList).toHaveBeenCalledTimes(1);
    expect(mockStoreMove).not.toHaveBeenCalled();
    expect(revalidateSpy).toHaveBeenCalledWith('folder-a');
    expect(revalidateSpy).toHaveBeenCalledWith('folder-b');
  });

  it('delegates to the file store when explorer state already has the item', async () => {
    const state = createState();
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );

    fileStoreState.resourceMap = new Map([['file-1', { id: 'file-1' }]]);

    await actions.moveItem('file-1', 'folder-a', 'folder-b');
    await Promise.resolve();

    expect(mockStoreMove).toHaveBeenCalledWith('file-1', 'folder-b');
    expect(mockResourceMove).not.toHaveBeenCalled();
    expect(mockRefreshFileList).not.toHaveBeenCalled();
  });
});

describe('TreeActionImpl optimistic actions', () => {
  beforeEach(() => {
    mockRefreshFileList.mockReset();
    mockResourceMove.mockReset().mockResolvedValue(undefined);
    mockStoreMove.mockReset();
    fileStoreState.resourceMap = new Map();
  });

  const withTimeout = <T>(promise: Promise<T>, ms = 1000) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
    ]);

  it('settles and lets a second move in the same folder reach the server', async () => {
    const state = createState();
    state.children = {
      'folder-a': [
        { id: 'file-1', isFolder: false, name: 'one.txt' } as any,
        { id: 'file-2', isFolder: false, name: 'two.txt' } as any,
      ],
    };
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );
    vi.spyOn(actions, 'revalidate').mockResolvedValue();

    await withTimeout(actions.moveItem('file-1', 'folder-a', 'folder-b'));
    await withTimeout(actions.moveItem('file-2', 'folder-a', 'folder-b'));

    expect(mockResourceMove).toHaveBeenCalledWith('file-1', 'folder-b');
    expect(mockResourceMove).toHaveBeenCalledWith('file-2', 'folder-b');
  });
});

describe('TreeActionImpl folder slug keys', () => {
  it('reconciles explorer rows (keyed by folder slug) into the folder id the tree renders', () => {
    const state = createState();
    state.children = {
      '': [{ id: 'docs_folder1', isFolder: true, name: 'Folder', slug: 'abc12345' } as any],
    };
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );

    actions.reconcile('abc12345', [{ id: 'file-9', isFolder: false, name: 'nine.txt' } as any]);

    expect(state.children['docs_folder1']?.map((item) => item.id)).toEqual(['file-9']);
    expect(state.children['abc12345']).toBeUndefined();
  });
});
