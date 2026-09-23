export type TeamCatalogModel = { displayName?: string | null; id: string; type?: string | null };

const TYPE_ORDER = ['chat', 'image', 'video'];

const rank = (type: string) => TYPE_ORDER.indexOf(type) + 1 || TYPE_ORDER.length + 1;

const teamModelType = (model: TeamCatalogModel) => model.type || 'chat';

/**
 * One tab per model type in the catalog, chat → image → video first, then any
 * other type. Built from the whole catalog (not the search result) so tabs
 * don't vanish while the admin is typing.
 */
export const buildTeamModelTabs = (models: TeamCatalogModel[]) => {
  const byType = new Map<string, TeamCatalogModel[]>();
  for (const model of models) {
    const type = teamModelType(model);
    byType.set(type, [...(byType.get(type) ?? []), model]);
  }
  return [...byType.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([type, items]) => ({ items, type }));
};
