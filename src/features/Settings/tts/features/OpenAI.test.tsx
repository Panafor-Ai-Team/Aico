import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';

import OpenAI from './OpenAI';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/features/SettingsSearch/anchor', () => ({
  SettingsSearchAnchor: ({ children }: { children: React.ReactNode }) => children,
}));

const setSettings = vi.fn(async () => {});

const renderWithTTS = (tts?: Record<string, unknown>) => {
  act(() => {
    useUserStore.setState({
      isUserStateInit: true,
      setSettings,
      settings: tts ? { tts } : {},
    } as any);
  });

  return render(<OpenAI />);
};

describe('OpenAI TTS settings', () => {
  beforeEach(() => {
    setSettings.mockClear();
  });

  // Form, Tooltip and Select stay real: the bug was Tooltip dropping the
  // value/onChange that Form.Item injects when there is no tooltip title.
  it('shows the saved TTS model', () => {
    renderWithTTS({ openAI: { ttsModel: 'tts-1-hd' } });

    expect(screen.getByRole('combobox')).toHaveTextContent('tts-1-hd');
  });

  it('saves the TTS model when another one is picked', async () => {
    renderWithTTS({ openAI: { ttsModel: 'tts-1' } });

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /tts-1-hd/ }));

    expect(setSettings).toHaveBeenCalledWith({
      tts: expect.objectContaining({ openAI: { ttsModel: 'tts-1-hd' } }),
    });
  });
});
