// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerDB } from '@/database/core/db-adaptor';
import { AicoBillingModel } from '@/database/models/aicoBilling';
import { UserModel } from '@/database/models/user';

import { accountDeletionRouter } from './accountDeletion';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(),
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn(),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: { deleteUser: vi.fn() },
}));

const addAbuseBlocklist = vi.fn();

const mockUser = (user: Record<string, any> | undefined) => {
  vi.mocked(getServerDB).mockResolvedValue({
    query: { users: { findFirst: vi.fn().mockResolvedValue(user) } },
  } as any);
};

const caller = () => accountDeletionRouter.createCaller({ userId: 'test-user' } as any);

const expectNoDeletion = () => {
  expect(addAbuseBlocklist).not.toHaveBeenCalled();
  expect(UserModel.deleteUser).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(AicoBillingModel).mockImplementation(() => ({ addAbuseBlocklist }) as any);
});

describe('accountDeletionRouter.requestDeletion', () => {
  it('rejects a request with no confirmEmail without deleting anything', async () => {
    mockUser({ email: 'user@example.com', id: 'test-user', phone: null });

    await expect(caller().requestDeletion({} as any)).rejects.toThrow();

    expectNoDeletion();
  });

  it('rejects an empty confirmEmail without deleting anything', async () => {
    mockUser({ email: 'user@example.com', id: 'test-user', phone: null });

    await expect(caller().requestDeletion({ confirmEmail: '' })).rejects.toThrow();

    expectNoDeletion();
  });

  it('accepts a confirmEmail that differs only in casing from the stored email', async () => {
    mockUser({ email: 'User@Example.com', id: 'test-user', phone: '+15550100' });

    await expect(caller().requestDeletion({ confirmEmail: 'user@example.com' })).resolves.toEqual({
      ok: true,
    });

    expect(addAbuseBlocklist).toHaveBeenCalledWith({
      email: 'User@Example.com',
      phone: '+15550100',
      reason: 'account_deletion',
    });
    expect(UserModel.deleteUser).toHaveBeenCalledWith(expect.anything(), 'test-user');
  });

  it('rejects a mismatched confirmEmail without deleting anything', async () => {
    mockUser({ email: 'user@example.com', id: 'test-user', phone: null });

    await expect(
      caller().requestDeletion({ confirmEmail: 'someone-else@example.com' }),
    ).rejects.toThrow('EMAIL_MISMATCH');

    expectNoDeletion();
  });

  it('rejects deletion for a user with no stored email', async () => {
    mockUser({ email: null, id: 'test-user', phone: '+15550100' });

    await expect(caller().requestDeletion({ confirmEmail: 'user@example.com' })).rejects.toThrow(
      'EMAIL_MISMATCH',
    );

    expectNoDeletion();
  });
});
