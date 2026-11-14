import { isEqual } from 'es-toolkit';
import { useEffect } from 'react';
import { shallow } from 'zustand/shallow';

import {
  getActiveWorkspaceId,
  useActiveWorkspaceId,
} from '@/business/client/hooks/useActiveWorkspaceId';
import { mutate, useClientDataSWR } from '@/libs/swr';
import { resourceKeys } from '@/libs/swr/keys';
import { resourceService } from '@/services/resource';
import type { ResourceItem, ResourceQueryParams } from '@/types/resource';

import { useFileStore } from '../../store';
import { mergeServerResourcesWithOptimistic } from './utils';

type ResourceSWRKey = [string, ResourceQueryParams, string | null];

const isResourceSWRKey = (
  key: unknown,
  queryParams: ResourceQueryParams,
  workspaceId: string | null,
) => {
  if (!Array.isArray(key)) return false;

  return (
    key[0] === resourceKeys.list.root && isEqual(key[1], queryParams) && key[2] === workspaceId
  );
};

/**
 * Revalidate resources with current or specific query params
 * This can be called from outside React components (e.g., store actions)
 */
export const revalidateResources = async (params?: ResourceQueryParams) => {
  const queryParams = params || useFileStore.getState().queryParams;
  const workspaceId = getActiveWorkspaceId();
  if (queryParams) {
    await mutate(
      (key) => isResourceSWRKey(key, queryParams, workspaceId),
      async (currentData) => currentData,
      {
        revalidate: true,
      },
    );
  }
};

type CachedResourcePage = Awaited<ReturnType<typeof resourceService.queryResources>>;

const isResourceListKey = (key: unknown) => Array.isArray(key) && key[0] === resourceKeys.list.root;

/**
 * Apply a local change to every cached resource list page, without refetching.
 *
 * The explorer copies the cached page into the store whenever the folder or
 * filter changes. Delete, rename and move only patched the store, so going to
 * another folder and back within the dedupe window showed deleted rows again
 * and old names.
 */
export const patchCachedResourceLists = async (
  patch: (items: ResourceItem[]) => ResourceItem[],
): Promise<void> => {
  await mutate(
    isResourceListKey,
    (current: CachedResourcePage | undefined) => {
      if (!current) return current;
      const items = patch(current.items);
      const removed = current.items.length - items.length;
      return {
        ...current,
        items,
        total: current.total === undefined ? undefined : Math.max(current.total - removed, 0),
      };
    },
    { revalidate: false },
  );
  // Search results are cached as a plain item array under their own key; keep
  // them in step too, or a deleted/renamed row stays in the open results.
  await mutate(
    (key) => Array.isArray(key) && key[0] === resourceKeys.search.root,
    (current: ResourceItem[] | undefined) => (current ? patch(current) : current),
    { revalidate: false },
  );
};

/**
 * Drop every cached list page except the one on screen, so other folders are
 * fetched fresh the next time they open (used after a move, where the
 * destination folder's cached page is missing the moved row).
 */
export const dropOtherCachedResourceLists = async (): Promise<void> => {
  const current = useFileStore.getState().queryParams;
  await mutate(
    (key) => isResourceListKey(key) && !isEqual((key as ResourceSWRKey)[1], current),
    undefined,
    { revalidate: false },
  );
};

/**
 * Custom SWR hook for fetching resources with caching and revalidation
 */
export const useFetchResources = (params: ResourceQueryParams | null, enable: any = true) => {
  const workspaceId = useActiveWorkspaceId();

  const swr = useClientDataSWR(
    enable && params ? resourceKeys.list(params, workspaceId) : null,
    async ([, queryParams]: ResourceSWRKey) => {
      const response = await resourceService.queryResources({
        ...queryParams,
        limit: queryParams.limit || 50,
        offset: 0,
      });
      return response;
    },
    {
      // Skip background revalidation when a fresh fetch for the same key
      // happened recently. Cache-hit display still works because the
      // useEffect below syncs swr.data → store regardless of whether the
      // fetcher actually ran.
      dedupingInterval: 30 * 1000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );

  // Sync SWR data → store on every data ref change.
  // Using useEffect (not onSuccess) covers the cache-hit path: when the key
  // changes to a previously-fetched folder, SWR returns cached data synchronously
  // without firing onSuccess. Reading the store mirror alone would surface the
  // previously-written folder's data until revalidation completes.
  const data = swr.data;
  useEffect(() => {
    if (!data || !params) return;

    const { hasMore, queryParams, resourceList, resourceMap, total } = useFileStore.getState();
    const merged = mergeServerResourcesWithOptimistic(data.items, resourceMap, params);

    if (
      !isEqual(queryParams, params) ||
      hasMore !== data.hasMore ||
      total !== data.total ||
      !isEqual(merged.resourceList, resourceList) ||
      !isEqual(merged.resourceMap, resourceMap)
    ) {
      useFileStore.setState(
        {
          hasMore: data.hasMore,
          offset: data.items.length,
          queryParams: params,
          resourceList: merged.resourceList,
          resourceMap: merged.resourceMap,
          total: data.total,
        },
        false,
        'useFetchResources/sync',
      );
    }
  }, [data, params]);

  return swr;
};

/**
 * Hook to access resource store state
 */
export const useResourceStore = () => {
  return useFileStore(
    (s) => ({
      hasMore: s.hasMore,
      queryParams: s.queryParams,
      resourceList: s.resourceList,
      resourceMap: s.resourceMap,
      total: s.total,
    }),
    shallow,
  );
};
