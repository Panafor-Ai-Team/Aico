type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Pick the toast text for a failed connector/plugin save. Surfaces the server's
 * reason for explainable failures (400/412 or errors marked `userFacing`) and
 * keeps the generic text for everything else (500s must not leak details).
 */
export const getSaveErrorMessage = (error: unknown, t: Translate): string => {
  const httpStatus = (error as { data?: { httpStatus?: number } })?.data?.httpStatus;
  const message = (error as Error | undefined)?.message;

  if (httpStatus === 403) {
    return t(
      'dev.permissionDenied',
      'You are not allowed to modify this connector — only the creator or a workspace owner can' as never,
    );
  }

  const showReason =
    !!message &&
    (httpStatus === 400 ||
      httpStatus === 412 ||
      (error as { userFacing?: boolean })?.userFacing === true);

  if (!showReason) return t('dev.saveError');
  if (message === 'MCP_AUTH_REQUIRED') return t('error.mcpAuthRequired');
  return t('dev.saveErrorWithReason', { reason: message });
};
