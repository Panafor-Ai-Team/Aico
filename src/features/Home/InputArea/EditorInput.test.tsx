import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import HomeEditorInput from './EditorInput';

const getBusinessChatInputSendAreaPrefix = vi.fn((..._args: unknown[]) => (
  <div data-testid="aico-billing-switcher" />
));
const useBusinessChatInputAlerts = vi.fn(() => <div data-testid="aico-funds-blocked-alert" />);

vi.mock('@/business/client/hooks/useBusinessChatInputSendAreaPrefix', () => ({
  getBusinessChatInputSendAreaPrefix: (...args: unknown[]) =>
    getBusinessChatInputSendAreaPrefix(...args),
  useBusinessChatInputAlerts: () => useBusinessChatInputAlerts(),
  useBusinessChatInputSendDisabled: () => false,
}));

vi.mock('@/features/AicoBilling', () => ({
  useFundsBlockedComposerCue: () => ({
    blocked: false,
    onMarkdownContentChange: (onChange: (content: string) => void) => onChange,
  }),
}));

vi.mock('@/features/ChatInput/ActionBar', () => ({
  default: () => <div data-testid="action-bar" />,
}));

vi.mock('@/features/ChatInput/ActionBar/Upload', () => ({
  default: () => <div data-testid="file-upload" />,
}));

const chatInputProviderProps = vi.fn();

vi.mock('@/features/ChatInput', () => ({
  ChatInputProvider: ({ children, ...props }: { children: React.ReactNode }) => {
    chatInputProviderProps(props);
    return <>{children}</>;
  },
  DesktopChatInput: ({
    leftContent,
    sendAreaPrefix,
  }: {
    leftContent?: React.ReactNode;
    sendAreaPrefix?: React.ReactNode;
  }) => (
    <div data-testid="desktop-chat-input">
      {leftContent}
      {sendAreaPrefix}
    </div>
  ),
}));

vi.mock('./ModeSelect', () => ({
  default: () => <div data-testid="mode-select" />,
}));

vi.mock('@/store/chat', () => ({
  useChatStore: { setState: vi.fn() },
}));

describe('HomeEditorInput billing switcher', () => {
  beforeEach(() => {
    getBusinessChatInputSendAreaPrefix.mockClear();
    useBusinessChatInputAlerts.mockClear();
  });

  it('exposes the billing source switcher before the first message', () => {
    render(
      <HomeEditorInput
        contextSelectionKey="home:chat:agt_inbox"
        initialValue=""
        isAgentConfigLoading={false}
        loading={false}
        mode="chat"
        send={async () => {}}
        onModeChange={() => {}}
        onValueChange={() => {}}
      />,
    );

    expect(getBusinessChatInputSendAreaPrefix).toHaveBeenCalled();
    expect(screen.getByTestId('aico-billing-switcher')).toBeInTheDocument();
  });

  it('mounts funds-blocked alerts above the composer (Conversation parity)', () => {
    render(
      <HomeEditorInput
        contextSelectionKey="home:chat:agt_inbox"
        initialValue=""
        isAgentConfigLoading={false}
        loading={false}
        mode="chat"
        send={async () => {}}
        onModeChange={() => {}}
        onValueChange={() => {}}
      />,
    );

    expect(useBusinessChatInputAlerts).toHaveBeenCalled();
    expect(screen.getByTestId('aico-funds-blocked-alert')).toBeInTheDocument();
  });
});

describe('HomeEditorInput thinking level', () => {
  beforeEach(() => {
    chatInputProviderProps.mockClear();
  });

  it('exposes the thinking level beside the model label before the first message', () => {
    render(
      <HomeEditorInput
        agentId="agt_inbox"
        contextSelectionKey="home:chat:agt_inbox"
        initialValue=""
        isAgentConfigLoading={false}
        loading={false}
        mode="chat"
        send={async () => {}}
        onModeChange={() => {}}
        onValueChange={() => {}}
      />,
    );

    expect(chatInputProviderProps).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agt_inbox',
        rightActions: ['modelLabel', 'reasoningEffort'],
      }),
    );
  });
});

describe('HomeEditorInput attachment actions', () => {
  beforeEach(() => {
    chatInputProviderProps.mockClear();
  });

  const renderInput = (mode: 'chat' | 'task') =>
    render(
      <HomeEditorInput
        contextSelectionKey={`home:${mode}:agt_home`}
        initialValue=""
        isAgentConfigLoading={false}
        loading={false}
        mode={mode}
        send={async () => {}}
        onModeChange={() => {}}
        onValueChange={() => {}}
      />,
    );

  it('keeps the full plus menu in chat mode', () => {
    renderInput('chat');

    expect(screen.getByTestId('action-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('file-upload')).not.toBeInTheDocument();
  });

  it('keeps the attachment action in task mode', () => {
    renderInput('task');

    expect(screen.getByTestId('file-upload')).toBeInTheDocument();
  });
});
