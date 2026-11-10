import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';

import ImageSettings from './Image';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/features/SettingsSearch/anchor', () => ({
  SettingsSearchAnchor: ({ children }: { children: React.ReactNode }) => children,
}));

const setSettings = vi.fn(async () => {});

// @lobehub/ui ≥5.30 renders the count as a base-ui NumberField (role `textbox`).
const numberField = () => screen.getByRole('textbox');

const renderWithImage = (image?: Record<string, unknown>) => {
  act(() => {
    useUserStore.setState({
      isUserStateInit: true,
      setSettings,
      settings: image ? { image } : {},
    } as any);
  });

  return render(<ImageSettings />);
};

describe('ImageSettings', () => {
  beforeEach(() => {
    setSettings.mockClear();
  });

  // Form, Tooltip and the slider stay real: the bug was Tooltip dropping the
  // value/onChange that Form.Item injects when there is no tooltip title.
  it('shows the saved default image count', () => {
    renderWithImage({ defaultImageNum: 3 });

    expect(numberField()).toHaveValue('3');
  });

  it('saves the default image count when it is edited', async () => {
    renderWithImage({ defaultImageNum: 1 });

    // FormSliderWithInput commits on the slider's blur, not on each keystroke.
    await act(async () => {
      fireEvent.change(numberField(), { target: { value: '2' } });
    });
    await act(async () => {
      fireEvent.blur(screen.getByRole('slider'));
    });

    expect(setSettings).toHaveBeenCalledWith({
      image: expect.objectContaining({ defaultImageNum: 2 }),
    });
  });
});
