import { t } from 'i18next';

import { getNonJsonHttpStatus } from '@/libs/trpc/client';

/**
 * What the input banner says for a failed send. An edge proxy's HTML error
 * page (nginx 413/502/504) has no tRPC message, so name what happened instead
 * of a JSON parse error; anything else keeps the server's own message.
 */
export const describeSendFailure = (error: Error): string => {
  const status = getNonJsonHttpStatus(error);
  if (status === 413) return t('input.errorTooLarge', { ns: 'chat' });
  if (status === 502 || status === 503 || status === 504) {
    return t('input.errorServerUnavailable', { ns: 'chat' });
  }
  return error.message;
};
