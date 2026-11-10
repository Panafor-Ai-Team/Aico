import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToolStore } from '@/store/tool';

import { composioExecutor } from './exector';

vi.mock('@/store/tool', () => ({ useToolStore: { getState: vi.fn() } }));

const callComposioTool = vi.fn();

const payload = {
  apiName: 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
  arguments: '{"per_page":10}',
  id: 'call_1',
  identifier: 'github',
  type: 'builtin',
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  // The local Composio store has not loaded the connection (fresh page load).
  vi.mocked(useToolStore.getState).mockReturnValue({
    callComposioTool,
    composioServers: [],
  } as any);
});

describe('composioExecutor', () => {
  // Regression: the executor refused to call the server when the app was not in
  // the local store yet ("Composio server not found: github"), although the
  // server resolves the user's connection itself.
  it('calls the server even when the local store has no entry for the app', async () => {
    callComposioTool.mockResolvedValue({
      data: { content: '[]', state: { content: [] }, success: true },
      success: true,
    });

    const result = await composioExecutor(payload);

    expect(callComposioTool).toHaveBeenCalledWith({
      identifier: 'github',
      toolArgs: { per_page: 10 },
      toolSlug: payload.apiName,
    });
    expect(result).toMatchObject({ content: '[]', success: true });
  });

  it('reports a Composio error result as a failure', async () => {
    callComposioTool.mockResolvedValue({
      data: { content: 'Not Found', state: { content: [], isError: true }, success: true },
      success: true,
    });

    const result = await composioExecutor(payload);

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ message: 'Not Found' });
    expect(result.content).toBe('Not Found');
  });

  it('passes on a server rejection (e.g. no connection) as a failure', async () => {
    callComposioTool.mockResolvedValue({
      error: 'No Composio connection found for "github".',
      success: false,
    });

    const result = await composioExecutor(payload);

    expect(result).toMatchObject({
      content: 'No Composio connection found for "github".',
      success: false,
    });
  });
});
