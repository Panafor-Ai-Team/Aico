import { AsyncTaskStatus } from '@/types/asyncTask';
import { type GenerationBatch } from '@/types/generation';

import { type ImageStoreState } from '../../initialState';
import { generationTopicSelectors } from '../generationTopic/selectors';

// ====== topic batch selectors ====== //

const getGenerationBatchesByTopicId = (topicId: string) => (s: ImageStoreState) => {
  return s.generationBatchesMap[topicId] || [];
};

const currentGenerationBatches = (s: ImageStoreState): GenerationBatch[] => {
  const activeTopicId = generationTopicSelectors.activeGenerationTopicId(s);
  if (!activeTopicId) return [];
  return getGenerationBatchesByTopicId(activeTopicId)(s);
};

const getGenerationBatchByBatchId = (batchId: string) => (s: ImageStoreState) => {
  const batches = currentGenerationBatches(s);
  return batches.find((batch) => batch.id === batchId);
};

const isCurrentGenerationTopicLoaded = (s: ImageStoreState): boolean => {
  const activeTopicId = generationTopicSelectors.activeGenerationTopicId(s);
  if (!activeTopicId) return false;
  return Array.isArray(s.generationBatchesMap[activeTopicId]);
};

/**
 * Successful image URLs from the newest batch in the active topic (batches are
 * newest-first). Prefer durable OSS `url`, then provider `originalUrl`.
 */
const latestGeneratedImageUrls = (s: ImageStoreState): string[] => {
  const batches = currentGenerationBatches(s);
  for (const batch of batches) {
    const urls = batch.generations
      .filter((generation) => generation.task?.status === AsyncTaskStatus.Success)
      .map(
        (generation) =>
          generation.asset?.url || generation.asset?.originalUrl || generation.asset?.thumbnailUrl,
      )
      .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));

    if (urls.length > 0) return [...new Set(urls)];
  }
  return [];
};

// ====== aggregate selectors ====== //

export const generationBatchSelectors = {
  getGenerationBatchesByTopicId,
  currentGenerationBatches,
  getGenerationBatchByBatchId,
  isCurrentGenerationTopicLoaded,
  latestGeneratedImageUrls,
};
