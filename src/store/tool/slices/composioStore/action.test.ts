import { toast } from '@lobehub/ui/base-ui';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lambdaClient } from '@/libs/trpc/client';

import { useToolStore } from '../../store';
import { type ComposioServer, ComposioServerStatus } from './types';

vi.mock('zustand/traditional');

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    composio: {
      createConnection: { mutate: vi.fn() },
      deleteConnection: { mutate: vi.fn() },
    },
  },
  toolsClient: {},
}));

const githubServer: ComposioServer = {
  appSlug: 'GITHUB',
  authConfigId: 'ac_1',
  connectedAccountId: 'ca-1',
  createdAt: 0,
  identifier: 'github',
  label: 'GitHub',
  status: ComposioServerStatus.ACTIVE,
};

beforeEach(() => {
  vi.clearAllMocks();
  useToolStore.setState({ composioServers: [], loadingComposioServerIds: new Set() });
});

// Regression: a failed connect (e.g. Composio refusing the link) returned
// `undefined` silently, so clicking Connect looked like it did nothing.
describe('createComposioConnection', () => {
  it('shows an error toast when the server rejects the connection', async () => {
    vi.mocked(lambdaClient.composio.createConnection.mutate).mockRejectedValue(
      new Error('Multiple connected accounts found'),
    );

    let result: ComposioServer | undefined;
    await act(async () => {
      result = await useToolStore.getState().createComposioConnection({
        appSlug: 'GITHUB',
        identifier: 'github',
        label: 'GitHub',
      });
    });

    expect(result).toBeUndefined();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(useToolStore.getState().loadingComposioServerIds.has('github')).toBe(false);
  });
});

describe('removeComposioConnection', () => {
  it('removes the server when the disconnect succeeds', async () => {
    useToolStore.setState({ composioServers: [githubServer] });
    vi.mocked(lambdaClient.composio.deleteConnection.mutate).mockResolvedValue({ success: true });

    await act(async () => {
      await useToolStore.getState().removeComposioConnection('github');
    });

    expect(useToolStore.getState().composioServers).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('restores the server and shows an error when the disconnect fails', async () => {
    useToolStore.setState({ composioServers: [githubServer] });
    vi.mocked(lambdaClient.composio.deleteConnection.mutate).mockRejectedValue(
      new Error('Composio down'),
    );

    await act(async () => {
      await useToolStore.getState().removeComposioConnection('github');
    });

    expect(useToolStore.getState().composioServers).toEqual([githubServer]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
