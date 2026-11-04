import { toast } from '@lobehub/ui/base-ui';
import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { openEditorModal } from '@/features/EditorModal';
import { useUserMemoryStore } from '@/store/userMemory';
import { LayersEnum } from '@/types/userMemory';

const LAYER_MAP = {
  activity: LayersEnum.Activity,
  context: LayersEnum.Context,
  experience: LayersEnum.Experience,
  identity: LayersEnum.Identity,
  preference: LayersEnum.Preference,
};

const EditableModal = memo(() => {
  const { t } = useTranslation('memory');
  const editingMemoryId = useUserMemoryStore((s) => s.editingMemoryId);
  const editingMemoryContent = useUserMemoryStore((s) => s.editingMemoryContent);
  const editingMemoryLayer = useUserMemoryStore((s) => s.editingMemoryLayer);
  const clearEditingMemory = useUserMemoryStore((s) => s.clearEditingMemory);
  const updateMemory = useUserMemoryStore((s) => s.updateMemory);

  // Held in a ref rather than in the effect's deps: the editor snapshots the
  // memory when it opens, so an unrelated store update must not tear down and
  // reopen a modal the user is typing in.
  const openEditorRef = useRef<() => ReturnType<typeof openEditorModal>>(undefined);
  openEditorRef.current = () =>
    openEditorModal({
      value: editingMemoryContent,
      onClose: clearEditingMemory,
      onConfirm: async (value) => {
        if (!editingMemoryId || !editingMemoryLayer) return;
        try {
          await updateMemory(editingMemoryId, value, LAYER_MAP[editingMemoryLayer]);
        } catch (error) {
          toast.error(t('edit.error'));
          // Rethrow so the editor footer skips `close()` and the user keeps their text.
          throw error;
        }
      },
    });

  useEffect(() => {
    if (!editingMemoryId) return;
    const instance = openEditorRef.current!();
    return () => instance.close();
  }, [editingMemoryId]);

  return null;
});

export default EditableModal;
