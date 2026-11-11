import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ChangeEvent, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AccountDeletion from './index';

const { confirmModal, mutate, toast } = vi.hoisted(() => ({
  confirmModal: vi.fn(),
  mutate: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal,
  toast,
}));

vi.mock('antd', () => ({
  Input: ({
    onChange,
    placeholder,
    value,
  }: {
    onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    value?: string;
  }) => <input placeholder={placeholder} value={value} onChange={onChange} />,
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: { accountDeletion: { requestDeletion: { mutate } } },
}));

const originalLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: { href: '/settings' } });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.clearAllMocks();
});

const typeEmail = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText('accountDeletion.emailPlaceholder'), {
    target: { value },
  });

const deleteButton = () => screen.getByRole('button', { name: 'accountDeletion.confirmOk' });

describe('AccountDeletion', () => {
  it('keeps the delete button disabled until the account email is typed', () => {
    render(<AccountDeletion />);

    expect(deleteButton()).toHaveProperty('disabled', true);

    typeEmail('   ');
    expect(deleteButton()).toHaveProperty('disabled', true);

    typeEmail('user@example.com');
    expect(deleteButton()).toHaveProperty('disabled', false);
  });

  it('asks for confirmation first and deletes nothing while the dialog is open', () => {
    render(<AccountDeletion />);
    typeEmail('user@example.com');

    fireEvent.click(deleteButton());

    expect(confirmModal).toHaveBeenCalledTimes(1);
    expect(confirmModal.mock.calls[0][0]).toMatchObject({
      content: 'accountDeletion.immediateConfirmContent',
      okButtonProps: { danger: true },
      title: 'accountDeletion.confirmTitle',
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(window.location.href).toBe('/settings');
  });

  it('deletes only after the dialog is confirmed, sending the typed email', async () => {
    mutate.mockResolvedValue({ ok: true });
    render(<AccountDeletion />);
    typeEmail('  user@example.com ');
    fireEvent.click(deleteButton());

    await act(() => confirmModal.mock.calls[0][0].onOk());

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ confirmEmail: 'user@example.com' });
    expect(toast.success).toHaveBeenCalledWith('accountDeletion.deleted');
    expect(window.location.href).toBe('/signin');
  });

  it('stays signed in and explains the mismatch when the server rejects the email', async () => {
    mutate.mockRejectedValue(new Error('EMAIL_MISMATCH'));
    render(<AccountDeletion />);
    typeEmail('other@example.com');
    fireEvent.click(deleteButton());

    await act(() => confirmModal.mock.calls[0][0].onOk());

    expect(toast.error).toHaveBeenCalledWith('accountDeletion.emailMismatch');
    expect(window.location.href).toBe('/settings');
  });
});
