import { describe, expect, it, vi } from 'vitest';

import { createConnectorViaOAuth } from './oauthCreate';

const setup = (over: { isNew?: boolean; result?: any; startError?: Error } = {}) => {
  const deleteConnector = vi.fn().mockResolvedValue(undefined);
  const popup = { location: { href: '' } } as unknown as Window;
  const deps = {
    create: vi.fn().mockResolvedValue({ id: 'c1', isNew: over.isNew ?? true }),
    deleteConnector,
    fetchConnectors: vi.fn().mockResolvedValue(undefined),
    popup,
    startOAuth: over.startError
      ? vi.fn().mockRejectedValue(over.startError)
      : vi.fn().mockResolvedValue('https://auth.example.com/authorize'),
    waitForPopup: vi.fn().mockResolvedValue(over.result ?? { status: 'success' }),
  };
  return { deleteConnector, deps, popup };
};

describe('createConnectorViaOAuth', () => {
  it('rolls back a freshly created connector when OAuth cannot start', async () => {
    const { deleteConnector, deps } = setup({ startError: new Error('OAuth setup failed') });

    await expect(createConnectorViaOAuth(deps)).rejects.toThrow('OAuth setup failed');
    expect(deleteConnector).toHaveBeenCalledWith('c1');
  });

  it('never deletes a pre-existing connector', async () => {
    const { deleteConnector, deps } = setup({ isNew: false, startError: new Error('x') });

    await expect(createConnectorViaOAuth(deps)).rejects.toThrow();
    expect(deleteConnector).not.toHaveBeenCalled();
  });

  it('rolls back when authorization fails, and surfaces the reason', async () => {
    const { deleteConnector, deps } = setup({
      result: { error: 'access_denied', status: 'error' },
    });

    await expect(createConnectorViaOAuth(deps)).rejects.toMatchObject({
      message: 'access_denied',
      userFacing: true,
    });
    expect(deleteConnector).toHaveBeenCalledWith('c1');
  });

  it('keeps the connector when the popup is merely dismissed', async () => {
    const { deleteConnector, deps } = setup({ result: { status: 'dismissed' } });

    await expect(createConnectorViaOAuth(deps)).rejects.toMatchObject({ userFacing: true });
    expect(deleteConnector).not.toHaveBeenCalled();
  });

  it('navigates the popup and keeps the connector on success', async () => {
    const { deleteConnector, deps, popup } = setup();

    await createConnectorViaOAuth(deps);

    expect(popup.location.href).toBe('https://auth.example.com/authorize');
    expect(deleteConnector).not.toHaveBeenCalled();
  });
});
