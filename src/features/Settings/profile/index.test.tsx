import { render, screen, within } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProfileSetting from './index';

const { userState } = vi.hoisted(() => ({
  userState: {
    fetchAuthProviders: () => {},
    isLoaded: true,
    isLoadedAuthProviders: false,
    isSignedIn: true,
    user: { email: 'user@example.com' },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormGroup: ({ children, title }: { children: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

vi.mock('antd', () => ({ Divider: () => <hr /> }));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: typeof userState) => unknown) => selector(userState),
}));

vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (s: { serverConfig: object }) => unknown) =>
    selector({ serverConfig: {} }),
}));

vi.mock('@/store/tool', () => ({
  useToolStore: (selector: (s: object) => unknown) =>
    selector({
      composioServers: [],
      isComposioServersInit: false,
      useFetchUserComposioConnections: () => {},
    }),
}));

vi.mock('@/business/client/features/AccountDeletion', () => ({
  default: () => <div data-testid="account-deletion" />,
}));

vi.mock('@/components/Skeleton/Settings/Profile', () => ({
  SettingsProfileRowSkeleton: () => null,
}));
vi.mock('@/features/Settings/features/SettingHeader', () => ({ default: () => null }));

vi.mock('./features/ProfileRow', () => ({
  default: ({
    anchor,
    children,
    label,
  }: {
    anchor?: string;
    children?: ReactNode;
    label?: string;
  }) => (
    <div data-anchor={anchor} data-testid="profile-row">
      <span>{label}</span>
      {children}
    </div>
  ),
}));

vi.mock('./features/AvatarRow', () => ({ default: () => <div data-testid="profile-row" /> }));
vi.mock('./features/FullNameRow', () => ({ default: () => <div data-testid="profile-row" /> }));
vi.mock('./features/UsernameRow', () => ({ default: () => <div data-testid="profile-row" /> }));
vi.mock('./features/InterestsRow', () => ({ default: () => <div data-testid="profile-row" /> }));
vi.mock('./features/PasswordRow', () => ({ default: () => <div data-testid="profile-row" /> }));
vi.mock('./features/EmailRow', () => ({ default: () => <div data-testid="profile-row" /> }));
vi.mock('./features/PhoneRow', () => ({ default: () => <div data-testid="profile-row" /> }));
vi.mock('./features/SSOProvidersList', () => ({ default: () => null }));
vi.mock('./features/ComposioAuthorizationList', () => ({ default: () => null }));

afterEach(() => {
  userState.isSignedIn = true;
});

describe('ProfileSetting', () => {
  it('shows account deletion as the last row of the Account group', () => {
    render(<ProfileSetting />);

    const account = screen.getByRole('region', { name: 'profile.account' });
    const rows = within(account).getAllByTestId('profile-row');
    const lastRow = rows.at(-1)!;

    expect(lastRow.dataset.anchor).toBe('profile-account-deletion');
    expect(within(lastRow).getByText('accountDeletion.title')).toBeTruthy();
    expect(within(lastRow).getByTestId('account-deletion')).toBeTruthy();
    expect(screen.getAllByTestId('account-deletion')).toHaveLength(1);
  });

  it('hides account deletion from a signed-out visitor', () => {
    userState.isSignedIn = false;

    render(<ProfileSetting />);

    expect(screen.queryByTestId('account-deletion')).toBeNull();
  });
});
