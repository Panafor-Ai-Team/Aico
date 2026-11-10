import { type LobeTool, type ToolManifestSettings } from '@lobechat/types';

import { type MetaData } from '@/types/meta';

const getPluginFormList = (list: LobeTool[], id: string) => list?.find((p) => p.identifier === id);

const getPluginTitle = (meta?: MetaData) => meta?.title;

/**
 * Display fallback for a tool that has no title: the identifier without the
 * internal `lobe-` prefix, so users never see "lobe-…" in the chat.
 */
const getToolFallbackName = (identifier: string) => identifier.replace(/^lobe-/, '');
const getPluginDesc = (meta?: MetaData) => meta?.description;

const getPluginTags = (meta?: MetaData) => meta?.tags;
const getPluginAvatar = (meta?: MetaData) => meta?.avatar || '🧩';

const isCustomPlugin = (id: string, pluginList: LobeTool[]) =>
  pluginList.some((i) => i.identifier === id && i.type === 'customPlugin');

const isSettingSchemaNonEmpty = (schema?: ToolManifestSettings) =>
  schema?.properties && Object.keys(schema.properties).length > 0;

export const pluginHelpers = {
  getPluginAvatar,
  getPluginDesc,
  getPluginFormList,
  getPluginTags,
  getPluginTitle,
  getToolFallbackName,
  isCustomPlugin,
  isSettingSchemaNonEmpty,
};
