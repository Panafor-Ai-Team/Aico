import {
  isAnaphoricImageEditIntent,
  isImageEditContinuationIntent,
} from '@lobechat/builtin-tool-image-generation';
import type { RuntimeImageGenParams } from 'model-bank';

/**
 * When Create → Image has no manual reference and the prompt is an edit of the
 * prior output, forward the latest successful asset URL(s) so the request is
 * image-to-image — the same parity chat gets from history mining.
 */
export const resolveCreateImageParamsWithPriorReference = (params: {
  parameters: RuntimeImageGenParams;
  priorUrls: string[];
  supportsImageUrl: boolean;
  supportsImageUrls: boolean;
}): RuntimeImageGenParams => {
  const { parameters, priorUrls, supportsImageUrl, supportsImageUrls } = params;

  const hasManualRefs =
    (typeof parameters.imageUrl === 'string' && parameters.imageUrl.length > 0) ||
    (Array.isArray(parameters.imageUrls) && parameters.imageUrls.length > 0);
  if (hasManualRefs || priorUrls.length === 0) return parameters;

  const prompt = typeof parameters.prompt === 'string' ? parameters.prompt.trim() : '';
  if (!prompt) return parameters;

  const isEdit = isImageEditContinuationIntent(prompt) || isAnaphoricImageEditIntent(prompt);
  if (!isEdit) return parameters;

  if (supportsImageUrls) {
    return { ...parameters, imageUrls: priorUrls };
  }
  if (supportsImageUrl) {
    return { ...parameters, imageUrl: priorUrls[0] };
  }
  return parameters;
};
