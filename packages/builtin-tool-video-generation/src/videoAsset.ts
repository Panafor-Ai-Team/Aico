import type { Generation, VideoGenerationAsset } from '@lobechat/types';

type Asset = Generation['asset'] | null | undefined;

/** Videos keep the playable file in `url`; `thumbnailUrl` is only the cover frame. */
export const getVideoAssetUrl = (asset: Asset) => asset?.url || asset?.originalUrl;

export const getVideoPosterUrl = (asset: Asset) =>
  (asset as VideoGenerationAsset | null | undefined)?.coverUrl || asset?.thumbnailUrl;
