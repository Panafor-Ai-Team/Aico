import { HotkeyEnum, HotkeyScopeEnum } from '@lobechat/const/hotkeys';
import { useEffect } from 'react';
import { useHotkeysContext } from 'react-hotkeys-hook';

import { useHotkeyById } from './useHotkeyById';

/**
 * Save document hotkey (Cmd+S / Ctrl+S)
 * @param onSave - Callback invoked when the save hotkey is triggered
 */
export const useSaveDocumentHotkey = (onSave: () => void | Promise<void>) => {
  return useHotkeyById(
    HotkeyEnum.SaveDocument,
    () => {
      void onSave();
    },
    {
      enableOnContentEditable: true,
    },
  );
};

/**
 * Register Files scope and enable it
 * Use this in components that need Files scope hotkeys
 */
// Several mounted components can register the Files scope at once (the
// Resources layout, a library layout, the page editor). Count them so the
// scope is only disabled when the last one unmounts; otherwise leaving a
// library turned Cmd+S off while the outer Resources layout was still open.
let filesScopeUsers = 0;

export const useRegisterFilesHotkeys = () => {
  const { enableScope, disableScope } = useHotkeysContext();

  useEffect(() => {
    filesScopeUsers += 1;
    enableScope(HotkeyScopeEnum.Files);
    return () => {
      filesScopeUsers = Math.max(filesScopeUsers - 1, 0);
      if (filesScopeUsers === 0) disableScope(HotkeyScopeEnum.Files);
    };
  }, [enableScope, disableScope]);

  return null;
};
