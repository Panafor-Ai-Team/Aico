import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';

import MemorySetting from './Memory';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/Editor/AutoSaveHint', () => ({
  default: () => null,
}));

vi.mock('@/features/ModelSwitchPanel/components/ControlsForm/LevelSlider', () => ({
  default: () => null,
}));

const setSettings = vi.fn(async () => {});

const renderWithMemory = (memory?: Record<string, unknown>) => {
  act(() => {
    useUserStore.setState({
      isUserStateInit: true,
      setSettings,
      settings: memory ? { memory } : {},
    } as any);
  });

  return render(<MemorySetting />);
};

describe('MemorySetting', () => {
  beforeEach(() => {
    setSettings.mockClear();
  });

  // Form, Tooltip and Switch stay real: the bug was Tooltip dropping the
  // checked/onChange that Form.Item injects when there is no tooltip title.
  it('shows both switches on when the user never saved memory settings', () => {
    renderWithMemory();

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    for (const item of switches) expect(item).toHaveAttribute('aria-checked', 'true');
  });

  it('reflects a saved autoExtract=false', () => {
    renderWithMemory({ autoExtract: false });

    const [enabled, autoExtract] = screen.getAllByRole('switch');
    expect(enabled).toHaveAttribute('aria-checked', 'true');
    expect(autoExtract).toHaveAttribute('aria-checked', 'false');
  });

  it('saves the memory settings when a switch is toggled', async () => {
    renderWithMemory();

    const [enabled] = screen.getAllByRole('switch');
    await act(async () => {
      fireEvent.click(enabled);
    });

    expect(setSettings).toHaveBeenCalledWith({
      memory: expect.objectContaining({ enabled: false }),
    });
  });
});
