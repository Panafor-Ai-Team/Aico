import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialState as fileInitialState } from '@/store/file/initialState';
import { useFileStore } from '@/store/file/store';
import { useKnowledgeBaseStore } from '@/store/library';

import { useResourceManagerStore } from '.';
import { initialState } from './initialState';

const { mockDeleteResourcesByQuery, mockMoveResource, mockResolveSelectionIds } = vi.hoisted(
  () => ({
    mockDeleteResourcesByQuery: vi.fn(),
    mockMoveResource: vi.fn(),
    mockResolveSelectionIds: vi.fn(),
  }),
);

vi.mock('@/services/resource', () => ({
  resourceService: {
    deleteResourcesByQuery: mockDeleteResourcesByQuery,
    moveResource: mockMoveResource,
    resolveSelectionIds: mockResolveSelectionIds,
  },
}));

describe('resource manager store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useResourceManagerStore.setState(initialState);
    useFileStore.setState(fileInitialState);
  });

  it('should default workspace resources to private mode when no preference is persisted', () => {
    useResourceManagerStore.setState({
      listVisibility: 'workspace',
      selectAllState: 'loaded',
      selectedFileIds: ['file-1'],
    });

    useResourceManagerStore.getState().hydrateListVisibility('workspace-1');

    expect(useResourceManagerStore.getState()).toMatchObject({
      listVisibility: 'private',
      selectAllState: 'none',
      selectedFileIds: [],
    });
  });

  it('should drop the previous source rows when the source filter changes', () => {
    // Regression: the pick used to update ResourceManager state only, leaving
    // the previous source's rows on screen and interactive until the fetch
    // landed — and a "select all" fired in that window resolved against the
    // stale queryParams, so the next batch action targeted the wrong source.
    useFileStore.setState({
      queryParams: { category: 'images', sourceFilter: 'generated' } as any,
      resourceList: [{ id: 'file-1' }, { id: 'file-2' }] as any,
      resourceMap: new Map([['file-1', { id: 'file-1' } as any]]),
      selectAllState: 'all',
    } as any);
    useResourceManagerStore.setState({
      selectAllState: 'all',
      selectedFileIds: ['file-9'],
      selectionTotal: 12,
      sourceFilter: 'generated' as any,
    });

    useResourceManagerStore.getState().setSourceFilter('uploaded' as any);

    expect(useResourceManagerStore.getState()).toMatchObject({
      selectAllState: 'none',
      selectedFileIds: [],
      sourceFilter: 'uploaded',
    });
    expect(useResourceManagerStore.getState().selectionTotal).toBeUndefined();
    expect(useFileStore.getState().resourceList).toEqual([]);
  });

  it('should ignore re-picking the already active source filter', () => {
    useFileStore.setState({ resourceList: [{ id: 'file-1' }] as any } as any);
    useResourceManagerStore.setState({ sourceFilter: 'uploaded' as any });

    useResourceManagerStore.getState().setSourceFilter('uploaded' as any);

    // No clear, so clicking the active chip does not flash the list.
    expect(useFileStore.getState().resourceList).toEqual([{ id: 'file-1' }]);
  });

  it('should exclude deselected ids when resolving all-selected resources', async () => {
    useResourceManagerStore.setState({
      selectAllState: 'all',
      selectedFileIds: ['file-2'],
    });
    useFileStore.setState({
      queryParams: { q: 'report' } as any,
    });
    mockResolveSelectionIds.mockResolvedValue({
      ids: ['file-1', 'file-2', 'file-3'],
    });

    const result = await useResourceManagerStore.getState().resolveSelectedResourceIds();

    expect(mockResolveSelectionIds).toHaveBeenCalledWith({ q: 'report' });
    expect(result).toEqual(['file-1', 'file-3']);
  });

  it('should store the role-scoped total when selecting every query result', async () => {
    useFileStore.setState({ queryParams: { q: 'report' } as any });
    mockResolveSelectionIds.mockResolvedValue({ ids: ['file-1', 'file-2'], total: 2 });

    await useResourceManagerStore.getState().selectAllResources();

    expect(mockResolveSelectionIds).toHaveBeenCalledWith({ q: 'report' });
    expect(useResourceManagerStore.getState()).toMatchObject({
      selectAllState: 'all',
      selectedFileIds: [],
      selectionTotal: 2,
    });
  });

  it('should resolve nothing (not the exclusions) when select-all has no query', async () => {
    useResourceManagerStore.setState({ selectAllState: 'all', selectedFileIds: ['excluded-1'] });
    useFileStore.setState({ queryParams: undefined } as any);

    await expect(useResourceManagerStore.getState().resolveSelectedResourceIds()).resolves.toEqual(
      [],
    );
  });

  it('should drop a select-all that lands after the user changed folder', async () => {
    useFileStore.setState({ queryParams: { parentId: 'folder-a' } as any });
    mockResolveSelectionIds.mockImplementation(async () => {
      useFileStore.setState({ queryParams: { parentId: 'folder-b' } as any });
      return { ids: ['file-1'], total: 1 };
    });

    await useResourceManagerStore.getState().selectAllResources();

    expect(useResourceManagerStore.getState().selectAllState).not.toBe('all');
  });

  it('moves to another library: add to target, clear the folder, then leave the source', async () => {
    const calls: string[] = [];
    useKnowledgeBaseStore.setState({
      addFilesToKnowledgeBase: vi.fn(async () => {
        calls.push('add');
      }),
      removeFilesFromKnowledgeBase: vi.fn(async () => {
        calls.push('remove');
      }),
    } as any);
    mockMoveResource.mockImplementation(async (id: string, parentId: string | null) => {
      calls.push(`move:${id}:${parentId}`);
    });
    useResourceManagerStore.setState({ libraryId: 'kb-source' });

    await useResourceManagerStore.getState().moveResourcesToLibrary('kb-target', ['f1']);

    expect(calls).toEqual(['add', 'move:f1:null', 'remove']);
  });

  it('keeps files in the source library when the target refuses them', async () => {
    const remove = vi.fn();
    useKnowledgeBaseStore.setState({
      addFilesToKnowledgeBase: vi.fn().mockRejectedValue(new Error('CONFLICT')),
      removeFilesFromKnowledgeBase: remove,
    } as any);
    useResourceManagerStore.setState({ libraryId: 'kb-source' });

    await expect(
      useResourceManagerStore.getState().moveResourcesToLibrary('kb-target', ['f1']),
    ).rejects.toThrow('CONFLICT');
    expect(remove).not.toHaveBeenCalled();
    expect(mockMoveResource).not.toHaveBeenCalled();
  });

  it('should keep all-selected deletion caller-scoped when exclusions are present', async () => {
    const deleteResources = vi.fn().mockResolvedValue(undefined);

    useResourceManagerStore.setState({
      selectAllState: 'all',
      selectedFileIds: ['file-2'],
    });
    useFileStore.setState({
      clearCurrentQueryResources: vi.fn(),
      deleteResources,
      queryParams: { q: 'report' } as any,
    });
    mockDeleteResourcesByQuery.mockResolvedValue({ count: 2 });

    await useResourceManagerStore.getState().onActionClick('delete');

    expect(mockDeleteResourcesByQuery).toHaveBeenCalledWith({ q: 'report' }, ['file-2']);
    expect(mockResolveSelectionIds).not.toHaveBeenCalled();
    expect(deleteResources).not.toHaveBeenCalled();
    expect(useResourceManagerStore.getState()).toMatchObject({
      selectAllState: 'none',
      selectedFileIds: [],
      selectionTotal: undefined,
    });
  });
});
