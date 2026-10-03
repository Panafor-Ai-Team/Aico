import {
  didPreviousTurnGenerateImage,
  findPendingUserMessageText,
  hasPreviousImageGeneration,
  ImageGenerationManifest,
  isImageGenerationUserIntent,
} from '@lobechat/builtin-tool-image-generation';
import {
  isVideoGenerationUserIntent,
  VideoGenerationManifest,
} from '@lobechat/builtin-tool-video-generation';

export type MediaGenerationToolMode = 'agent' | 'chat' | 'custom';

export type MediaGenerationOffer = {
  image: boolean;
  video: boolean;
};

type MessageLike = {
  content?: unknown;
  /** Match image-intent `MessageLike` — no `null` (structural assignability). */
  role?: string;
};

/**
 * Decide whether lobe-image-generation / lobe-video-generation should be in the
 * LLM tool offer set for this turn.
 *
 * Clear photo/video asks still run via directToolCalls even when the offer is
 * false — Create-parity does not need the tools in the catalog. Offering them
 * only on intent (or agent pin) avoids ~5k tokens of schemas on every FC turn.
 *
 * - chat: FC ∧ intent
 * - agent: FC ∧ (intent ∨ pinned in plugins)
 * - custom: only when pinned (caller usually ignores these rules)
 */
export const resolveMediaGenerationOffer = (params: {
  messages?: MessageLike[] | null;
  modelCanUseTools: boolean;
  plugins?: string[] | null;
  toolMode: MediaGenerationToolMode;
}): MediaGenerationOffer => {
  if (!params.modelCanUseTools) return { image: false, video: false };

  const plugins = params.plugins ?? [];
  const imagePinned = plugins.includes(ImageGenerationManifest.identifier);
  const videoPinned = plugins.includes(VideoGenerationManifest.identifier);

  if (params.toolMode === 'custom') {
    return { image: imagePinned, video: videoPinned };
  }

  const pendingText = findPendingUserMessageText(params.messages) ?? '';
  const hasPreviousGenerated = hasPreviousImageGeneration(params.messages);
  const previousTurnGeneratedImage = didPreviousTurnGenerateImage(params.messages);

  const imageIntent =
    pendingText.length > 0 &&
    isImageGenerationUserIntent(pendingText, {
      hasPreviousGenerated,
      previousTurnGeneratedImage,
    });
  const videoIntent = pendingText.length > 0 && isVideoGenerationUserIntent(pendingText);

  if (params.toolMode === 'chat') {
    return { image: imageIntent, video: videoIntent };
  }

  return {
    image: imageIntent || imagePinned,
    video: videoIntent || videoPinned,
  };
};
