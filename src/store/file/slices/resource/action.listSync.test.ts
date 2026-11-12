import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialState } from '@/store/file/initialState';
import { useFileStore } from '@/store/file/store';
import type { ResourceItem } from '@/types/resource';

const mocks = vi.hoisted(() => ({
  deleteResources: vi.fn(),
  dropOther: vi.fn(),
  moveResource: vi.fn(),
  patchCached: vi.fn(),
  queryResources: vi.fn(),
  updateResource: vi.fn(),
}));

vi.mock('@/services/resource', () => ({
  resourceService: {
    deleteResources: mocks.deleteResources,
    moveResource: mocks.moveResource,
    queryResources: mocks.queryResources,
    updateResource: mocks.updateResource,
  },
}));

vi.mock('./hooks', () => ({
  dropOtherCachedResourceLists: mocks.dropOther,
  patchCachedResourceLists: mocks.patchCached,
}));

const item = (id: string, overrides: Partial<ResourceItem> = {}): ResourceItem => ({
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  fileType: 'text/plain',
  id,
  name: id,
  parentId: null,
  size: 1,
  sourceType: 'file',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  url: `files/${id}.txt`,
  ...overrides,
});

describe('resource list sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileStore.setState(initialState);
  });

  it('renames an item that is not in the loaded list (search result) on the server', async () => {
    mocks.updateResource.mockResolvedValue(item('found-1', { name: 'New' }));

    await useFileStore.getState().updateResource('found-1', { name: 'New' });

    expect(mocks.updateResource).toHaveBeenCalledWith('found-1', { name: 'New' });
    expect(mocks.patchCached).toHaveBeenCalled();
  });

  it('moves an item that is not in the loaded list on the server', async () => {
    mocks.moveResource.mockResolvedValue(item('found-1'));

    await useFileStore.getState().moveResource('found-1', 'folder-x');

    expect(mocks.moveResource).toHaveBeenCalledWith('found-1', 'folder-x');
  });

  it('lowers offset and total after a delete so the next page does not skip rows', async () => {
    const rows = [item('a'), item('b'), item('c')];
    useFileStore.setState({
      offset: 3,
      queryParams: { parentId: null },
      resourceList: rows,
      resourceMap: new Map(rows.map((row) => [row.id, row])),
      total: 10,
    });
    mocks.deleteResources.mockResolvedValue(undefined);

    await useFileStore.getState().deleteResources(['a', 'b']);

    expect(useFileStore.getState()).toMatchObject({ offset: 1, total: 8 });
    expect(mocks.patchCached).toHaveBeenCalled();
    const patch = mocks.patchCached.mock.calls[0][0] as (items: ResourceItem[]) => ResourceItem[];
    expect(patch(rows).map((row) => row.id)).toEqual(['c']);
  });

  it('drops a load-more page that lands after the folder changed', async () => {
    useFileStore.setState({
      hasMore: true,
      offset: 50,
      queryParams: { parentId: 'folder-a' },
      resourceList: [item('a1')],
      resourceMap: new Map([['a1', item('a1')]]),
    });
    mocks.queryResources.mockImplementation(async () => {
      useFileStore.setState({
        queryParams: { parentId: 'folder-b' },
        resourceList: [item('b1')],
        resourceMap: new Map([['b1', item('b1')]]),
      });
      return { hasMore: false, items: [item('a2')] };
    });

    await useFileStore.getState().loadMoreResources();

    expect(useFileStore.getState().resourceList.map((row) => row.id)).toEqual(['b1']);
    expect(useFileStore.getState().isLoadingMore).toBe(false);
  });

  it('keeps loading while the server says more rows exist, even after a short page', async () => {
    useFileStore.setState({
      hasMore: true,
      offset: 50,
      queryParams: { parentId: null },
      resourceList: [],
      resourceMap: new Map(),
    });
    mocks.queryResources.mockResolvedValue({ hasMore: true, items: [item('x')] });

    await useFileStore.getState().loadMoreResources();

    expect(useFileStore.getState().hasMore).toBe(true);
  });
});
