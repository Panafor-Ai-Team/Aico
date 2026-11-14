import { HotkeyScopeEnum } from '@lobechat/const/hotkeys';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRegisterFilesHotkeys } from './filesScope';

const scope = vi.hoisted(() => ({ disableScope: vi.fn(), enableScope: vi.fn() }));

vi.mock('react-hotkeys-hook', () => ({
  useHotkeysContext: () => scope,
}));

describe('useRegisterFilesHotkeys', () => {
  it('keeps the Files scope on until the last registering component unmounts', () => {
    const outer = renderHook(() => useRegisterFilesHotkeys());
    const inner = renderHook(() => useRegisterFilesHotkeys());

    inner.unmount();
    expect(scope.disableScope).not.toHaveBeenCalled();

    outer.unmount();
    expect(scope.disableScope).toHaveBeenCalledWith(HotkeyScopeEnum.Files);
  });
});
