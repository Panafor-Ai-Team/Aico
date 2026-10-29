'use client';

import { memo } from 'react';

import { useFetchInstalledPlugins } from '@/hooks/useFetchInstalledPlugins';
import { serverConfigSelectors, useServerConfigStore } from '@/store/serverConfig';
import { useToolStore } from '@/store/tool';

/**
 * Loads the tool state a conversation depends on — installed plugins and the
 * user's Composio connections — while the composer is mounted. The chat input's
 * menus are popup-scoped, so without this nothing on the page fetches it and
 * connected apps look missing (auth alert, `@` mentions, the tool set of a run).
 * Renders nothing; SWR dedupes the requests across mounted composers.
 */
const RuntimeToolsHydration = memo(() => {
  const enableComposio = useServerConfigStore(serverConfigSelectors.enableComposio);
  const useFetchUserComposioConnections = useToolStore((s) => s.useFetchUserComposioConnections);

  useFetchInstalledPlugins();
  useFetchUserComposioConnections(enableComposio);

  return null;
});

RuntimeToolsHydration.displayName = 'RuntimeToolsHydration';

export default RuntimeToolsHydration;
