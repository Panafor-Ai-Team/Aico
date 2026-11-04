import { useCallback } from 'react';

import { isUploadBlockedByAbility, useMediaUploadAbility } from '@/hooks/useMediaUploadAbility';
import { usePermission } from '@/hooks/usePermission';
import { useFileStore } from '@/store/file';

interface UseUploadFilesOptions {
  /** The conversation's agent id. Decides whether the chat-only file-type whitelist applies. */
  agentId: string;
  model?: string;
  provider?: string;
}

/**
 * Hook to handle file uploads with multimodal media support filtering.
 * Filters out image/video files if the model cannot receive them directly or via fallback.
 *
 * @param options - The agent id (for upload validation scope) plus model/provider for vision support
 * @returns handleUploadFiles - Callback to handle file uploads
 */
export const useUploadFiles = (options: UseUploadFilesOptions) => {
  const { agentId, model = '', provider = '' } = options;

  const mediaUploadAbility = useMediaUploadAbility(model, provider, agentId);
  const { canUploadImage, canUploadVideo, canUploadAudio } = mediaUploadAbility;
  const uploadFiles = useFileStore((s) => s.uploadChatFiles);
  const { allowed: canUpload } = usePermission('create_content');

  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      if (!canUpload) return;

      // Filter out media files if the model cannot receive them directly or via fallback.
      const filteredFiles = files.filter(
        (file) => !isUploadBlockedByAbility(file, mediaUploadAbility),
      );

      if (filteredFiles.length > 0) {
        uploadFiles(filteredFiles, agentId);
      }
    },
    [agentId, canUpload, mediaUploadAbility, uploadFiles],
  );

  return { canUploadImage, canUploadVideo, canUploadAudio, handleUploadFiles };
};
