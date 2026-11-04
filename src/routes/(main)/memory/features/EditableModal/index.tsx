import { toast } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { EditorModal } from '@/features/EditorModal';
import { useUserMemoryStore } from '@/store/userMemory';
import { LayersEnum } from '@/types/userMemory';

const EditableModal = memo(() => {
  const { t } = useTranslation('memory');
  const editingMemoryId = useUserMemoryStore((s) => s.editingMemoryId);
  const editingMemoryContent = useUserMemoryStore((s) => s.editingMemoryContent);
  const editingMemoryLayer = useUserMemoryStore((s) => s.editingMemoryLayer);
  const clearEditingMemory = useUserMemoryStore((s) => s.clearEditingMemory);
  const updateMemory = useUserMemoryStore((s) => s.updateMemory);

  const layerMap = {
    activity: LayersEnum.Activity,
    context: LayersEnum.Context,
    experience: LayersEnum.Experience,
    identity: LayersEnum.Identity,
    preference: LayersEnum.Preference,
  };

  return (
    <EditorModal
      open={!!editingMemoryId}
      value={editingMemoryContent}
      onCancel={clearEditingMemory}
      onConfirm={async (value) => {
        if (!editingMemoryId || !editingMemoryLayer) return;
        try {
          await updateMemory(editingMemoryId, value, layerMap[editingMemoryLayer]);
        } catch (error) {
          // The modal stays open with the user's text so they can retry.
          console.error('[memory] failed to save edited memory', error);
          toast.error(t('edit.error'));
        }
      }}
    />
  );
});

export default EditableModal;
