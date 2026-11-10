import { GroupBy } from '../../../../types';

/**
 * ModelTable sub-row dimension: providers when the table is grouped by Model,
 * models otherwise (Provider/User). Mirrors `innerKey` in `ModelTable.tsx`,
 * which groups sub-rows by `log.provider` when grouped by Model and by
 * `log.model` otherwise — both must agree on which dimension the sub-rows are,
 * since it drives both the sub-row icon (BrandedProviderIcon vs.
 * BrandedModelIcon) and label text (formatBrandedProviderId vs.
 * formatBrandedModelId).
 */
export const isInnerRowProvider = (groupBy: GroupBy): boolean => groupBy === GroupBy.Model;
