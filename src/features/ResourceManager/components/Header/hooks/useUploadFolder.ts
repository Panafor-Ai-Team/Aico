import { confirmModal, toast } from '@lobehub/ui/base-ui';
import { type TFunction } from 'i18next';
import { type ChangeEvent } from 'react';
import { useCallback } from 'react';

import { type FileManageAction } from '@/store/file/slices/fileManager/action';
import {
  filterFilesByBuiltInBlockList,
  filterFilesByGitignore,
  findGitignoreFile,
  readGitignoreContent,
} from '@/utils/gitignore';

interface UseUploadFolderOptions {
  currentFolderId?: string | null;
  libraryId?: string | null;
  t: TFunction<'file'>;
  uploadFolderWithStructure: FileManageAction['uploadFolderWithStructure'];
}

const useUploadFolder = ({
  currentFolderId,
  libraryId,
  t,
  uploadFolderWithStructure,
}: UseUploadFolderOptions) => {
  /**
   * Upload a picked folder (every file of it, with `webkitRelativePath`) while
   * keeping its folder structure and applying the block list / .gitignore.
   * Shared by the header "Upload folder" menu and the empty-state card.
   */
  const uploadFolderFiles = useCallback(
    async (pickedFiles: File[]) => {
      let files = pickedFiles;
      if (files.length === 0) return;

      const targetFolderId = currentFolderId ?? undefined;
      const targetLibraryId = libraryId ?? undefined;
      const upload = async (fileList: File[]) => {
        try {
          await uploadFolderWithStructure(fileList, targetLibraryId, targetFolderId);
        } catch (error) {
          console.error('Failed to upload folder:', error);
          toast.error(t('upload.uploadFailed', { ns: 'error' }));
        }
      };

      // Apply built-in block list first
      const originalCount = files.length;
      files = filterFilesByBuiltInBlockList(files);
      const builtInBlockedCount = originalCount - files.length;

      if (builtInBlockedCount > 0) {
        toast.info(
          t('header.actions.builtInBlockList.filtered', {
            ignored: builtInBlockedCount,
            total: originalCount,
          }),
        );
      }

      const gitignoreFile = findGitignoreFile(files);

      if (!gitignoreFile) {
        await upload(files);
        return;
      }

      let gitignoreContent: string;
      try {
        gitignoreContent = await readGitignoreContent(gitignoreFile);
      } catch (error) {
        console.error('Failed to read .gitignore:', error);
        await upload(files);
        return;
      }

      const gitignoreOriginalCount = files.length;

      confirmModal({
        cancelText: t('header.actions.gitignore.cancel'),
        content: t('header.actions.gitignore.content', {
          count: gitignoreOriginalCount,
        }),
        okText: t('header.actions.gitignore.apply'),
        onCancel: () => {
          void upload(files);
        },
        onOk: async () => {
          const filteredFiles = filterFilesByGitignore(files, gitignoreContent);
          const ignoredCount = gitignoreOriginalCount - filteredFiles.length;

          if (ignoredCount > 0) {
            toast.info(
              t('header.actions.gitignore.filtered', {
                ignored: ignoredCount,
                total: gitignoreOriginalCount,
              }),
            );
          }

          // Upload without awaiting - let it run in background
          void upload(filteredFiles);
        },
        title: t('header.actions.gitignore.title'),
      });
    },
    [currentFolderId, libraryId, t, uploadFolderWithStructure],
  );

  const handleFolderUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target;
      try {
        await uploadFolderFiles(Array.from(input.files || []));
      } finally {
        // Reset even on failure so picking the same folder again fires onChange.
        input.value = '';
      }
    },
    [uploadFolderFiles],
  );

  return { handleFolderUpload, uploadFolderFiles };
};

export default useUploadFolder;
