export interface OAuthPopupResult {
  error?: string;
  status: 'success' | 'error' | 'dismissed';
  synced?: boolean;
}

/** Error whose message is safe and useful to show the user verbatim. */
export const userFacingError = (message: string) =>
  Object.assign(new Error(message), { userFacing: true as const });

/** Turn a non-success popup result into a user-facing error. */
export const popupResultError = (result: OAuthPopupResult) =>
  userFacingError(
    result.status === 'error'
      ? result.error || 'Authorization failed'
      : 'Authorization was not completed',
  );

interface CreateViaOAuthDeps {
  create: () => Promise<{ id: string; isNew: boolean }>;
  deleteConnector: (id: string) => Promise<unknown>;
  fetchConnectors: () => Promise<unknown>;
  popup: Window;
  startOAuth: (id: string) => Promise<string>;
  waitForPopup: (popup: Window, id: string) => Promise<OAuthPopupResult>;
}

/**
 * Create a connector and drive its OAuth popup. A connector this call freshly
 * created is rolled back when authorization cannot start or fails, so no empty
 * "disconnected" row is left behind. A dismissed popup is NOT rolled back: the
 * user may still finish in it, and the callback needs the row to exist.
 */
export const createConnectorViaOAuth = async (deps: CreateViaOAuthDeps): Promise<void> => {
  const { id, isNew } = await deps.create();
  const rollback = async () => {
    if (isNew) await deps.deleteConnector(id).catch(() => {});
  };

  let result: OAuthPopupResult;
  try {
    const authorizationUrl = await deps.startOAuth(id);
    deps.popup.location.href = authorizationUrl;
    result = await deps.waitForPopup(deps.popup, id);
  } catch (error) {
    await rollback();
    throw error;
  }

  await deps.fetchConnectors();
  if (result.status === 'success') return;
  if (result.status === 'error') await rollback();
  throw popupResultError(result);
};
