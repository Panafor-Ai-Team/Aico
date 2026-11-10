import { resolveAicoErrorCode } from '@lobechat/business-const';

import { resolveAicoErrorMessage } from '@/business/client/resolveAicoErrorMessage';
import type { AicoBillingChatBlockReason, AicoBillingSource } from '@/features/AicoBilling/types';
import { type LooseTFunction } from '@/types/looseTranslation';

export const resolveManagedKeyErrorDescription = (params: {
  activeSource: AicoBillingSource | undefined;
  blockReason: AicoBillingChatBlockReason | null;
  serverErrorCode?: string;
  showTrialCta: boolean;
  t: LooseTFunction;
}): string => {
  const { activeSource, blockReason, serverErrorCode, showTrialCta, t } = params;

  const resolvedServerMessage = serverErrorCode
    ? resolveAicoErrorMessage(serverErrorCode, t)
    : undefined;

  if (resolvedServerMessage) return resolvedServerMessage;

  if (
    blockReason === 'PERSONAL_FUNDS_UNAVAILABLE' &&
    showTrialCta &&
    activeSource?.source === 'personal'
  ) {
    return t('billing.fundsBlocked.descWithTrial');
  }

  if (blockReason) return t(`errors.${blockReason}`);

  if (activeSource?.source === 'organization') {
    return t('errors.MEMBER_BUDGET_UNFUNDED');
  }

  return t('errors.managedKey.description');
};

export const shouldShowManagedKeyTrialActions = (params: {
  activeSource: AicoBillingSource | undefined;
  blockReason: AicoBillingChatBlockReason | null;
  serverErrorCode?: string;
  showTrialCta: boolean;
}): boolean => {
  const { activeSource, blockReason, serverErrorCode, showTrialCta } = params;
  const resolvedServerCode = serverErrorCode ? resolveAicoErrorCode(serverErrorCode) : undefined;

  return (
    showTrialCta &&
    activeSource?.source === 'personal' &&
    (resolvedServerCode === 'PERSONAL_FUNDS_UNAVAILABLE' ||
      blockReason === 'PERSONAL_FUNDS_UNAVAILABLE' ||
      blockReason === 'MANAGED_KEY_UNAVAILABLE')
  );
};
