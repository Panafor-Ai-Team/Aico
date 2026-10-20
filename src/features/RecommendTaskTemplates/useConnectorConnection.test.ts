/**
 * @vitest-environment happy-dom
 */
import type { TaskTemplateConnectorReference } from '@lobechat/const';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectorConnectionMarketAuthRequiredError,
  useConnectorConnection,
} from './useConnectorConnection';

const mocks = vi.hoisted(() => ({
  marketAuth: {
    isAuthenticated: false,
    signIn: vi.fn(),
  },
  serverConfig: undefined as any,
  toolState: {
    checkLobehubSkillStatus: vi.fn(),
    composioServers: [],
    createComposioConnection: vi.fn(),
    getLobehubSkillAuthorizeUrl: vi.fn(),
    lobehubSkillServers: [],
    refreshComposioConnectionStatus: vi.fn(),
  },
}));

vi.mock('@/store/serverConfig', () => ({
  getServerConfigStoreState: () => mocks.serverConfig,
}));

vi.mock('@/layout/AuthProvider/MarketAuth', () => ({
  useMarketAuth: () => mocks.marketAuth,
}));

vi.mock('@/store/tool', () => ({
  useToolStore: <T>(selector: (state: typeof mocks.toolState) => T): T => selector(mocks.toolState),
}));

vi.mock('@/store/user', () => ({
  useUserStore: {
    getState: () => ({ user: { id: 'user-id' } }),
  },
}));

const lobehubSpec: TaskTemplateConnectorReference = { identifier: 'linear', source: 'lobehub' };

describe('useConnectorConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.marketAuth.isAuthenticated = false;
    mocks.marketAuth.signIn.mockResolvedValue(null);
    mocks.serverConfig = undefined;
    mocks.toolState.composioServers = [];
    mocks.toolState.lobehubSkillServers = [];
    mocks.toolState.getLobehubSkillAuthorizeUrl.mockResolvedValue({
      authorizeUrl: 'https://market.example.com/oauth/authorize',
      code: 'code',
      expiresIn: 600,
    });
    vi.spyOn(window, 'open').mockReturnValue({
      close: vi.fn(),
      closed: false,
    } as unknown as Window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the user to sign in to Market before requesting LobeHub connector OAuth', async () => {
    const { result } = renderHook(() => useConnectorConnection([lobehubSpec]));

    let error: unknown;
    await act(async () => {
      try {
        await result.current.connect();
      } catch (caughtError) {
        error = caughtError;
      }
    });

    expect(error).toBeInstanceOf(ConnectorConnectionMarketAuthRequiredError);
    expect(mocks.marketAuth.signIn).toHaveBeenCalledWith('connector');
    expect(mocks.toolState.getLobehubSkillAuthorizeUrl).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('opens provider OAuth directly when Market is authenticated', async () => {
    mocks.marketAuth.isAuthenticated = true;
    const { result, unmount } = renderHook(() => useConnectorConnection([lobehubSpec]));

    await act(async () => {
      await result.current.connect();
    });

    expect(mocks.marketAuth.signIn).not.toHaveBeenCalled();
    expect(mocks.toolState.getLobehubSkillAuthorizeUrl).toHaveBeenCalledWith('linear', {
      redirectUri: expect.stringContaining('/oauth/callback/success?provider=linear'),
    });
    expect(window.open).toHaveBeenCalledWith(
      'https://market.example.com/oauth/authorize',
      '_blank',
      'width=600,height=700',
    );

    unmount();
  });

  it('turns Market 401 from the authorize URL request into a silent auth interruption', async () => {
    mocks.marketAuth.isAuthenticated = true;
    mocks.toolState.getLobehubSkillAuthorizeUrl.mockRejectedValue({
      data: { code: 'UNAUTHORIZED', httpStatus: 401 },
    });
    const { result } = renderHook(() => useConnectorConnection([lobehubSpec]));

    let error: unknown;
    await act(async () => {
      try {
        await result.current.connect();
      } catch (caughtError) {
        error = caughtError;
      }
    });

    expect(error).toBeInstanceOf(ConnectorConnectionMarketAuthRequiredError);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('connects GitHub through Composio when Market auth is unavailable', async () => {
    mocks.serverConfig = {
      serverConfig: { enableComposio: true, enableLobehubSkill: false },
    };
    mocks.toolState.createComposioConnection.mockResolvedValue({
      identifier: 'github',
      redirectUrl: 'https://connect.composio.dev/link/abc',
      status: 'pending_auth',
    });
    const githubSpec: TaskTemplateConnectorReference = { identifier: 'github', source: 'lobehub' };
    const { result, unmount } = renderHook(() => useConnectorConnection([githubSpec]));

    await act(async () => {
      await result.current.connect();
    });

    expect(mocks.marketAuth.signIn).not.toHaveBeenCalled();
    expect(mocks.toolState.createComposioConnection).toHaveBeenCalledWith({
      appSlug: 'GITHUB',
      identifier: 'github',
      label: 'GitHub',
    });
    expect(window.open).toHaveBeenCalledWith(
      'https://connect.composio.dev/link/abc',
      '_blank',
      'width=600,height=700',
    );

    unmount();
  });

  it('counts an ACTIVE Composio account as connected for a lobehub-tagged GitHub spec', () => {
    mocks.serverConfig = {
      serverConfig: { enableComposio: true, enableLobehubSkill: false },
    };
    mocks.toolState.composioServers = [{ identifier: 'github', status: 'active' }] as any;
    const githubSpec: TaskTemplateConnectorReference = { identifier: 'github', source: 'lobehub' };
    const { result } = renderHook(() => useConnectorConnection([githubSpec]));

    expect(result.current.isAllConnected).toBe(true);
    expect(result.current.needsConnect).toBe(false);
  });
});
