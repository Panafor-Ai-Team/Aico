'use client';

import { AutoComplete, type AutoCompleteOption } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { mutate as globalMutate } from 'swr';

import { useClientDataSWR } from '@/libs/swr';
import { controlPlaneClient } from '@/libs/trpc/client/controlPlane';

export type ManualReasonKind = 'credit' | 'debit';

const swrKey = (kind: ManualReasonKind) => `aico-manual-reasons-${kind}`;

/** Refetch once a credit or debit lands, so the reason just used is offered next time. */
export const refreshManualReasons = (kind: ManualReasonKind) => globalMutate(swrKey(kind));

/** True when the reason contains every word typed so far, in any order or case. */
export const matchesEveryWord = (reason: string, query: string) => {
  const haystack = reason.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
};

const styles = createStaticStyles(({ css }) => ({
  // Nothing matches: hide the popup instead of showing an empty box.
  popup: css`
    &[data-empty] {
      display: none;
    }
  `,
}));

interface ManualReasonInputProps {
  kind: ManualReasonKind;
  onChange?: (value: string) => void;
  value?: string;
}

/**
 * Reason field for admin credits and debits. Offers the reasons already used,
 * narrowed to those containing every typed word; any new text is kept as typed
 * and joins the suggestions once the transaction records it.
 */
export const ManualReasonInput = memo<ManualReasonInputProps>(({ kind, onChange, value }) => {
  const { t } = useTranslation('aico');
  const { data } = useClientDataSWR(swrKey(kind), () =>
    controlPlaneClient.platformAdmin.listManualReasons.query({ kind }),
  );

  return (
    <AutoComplete
      allowClear
      classNames={{ popup: styles.popup }}
      // Items reach the filter as the option objects `AutoComplete` builds.
      filter={(item, query) => matchesEveryWord((item as AutoCompleteOption).value, query)}
      limit={10}
      options={data ?? []}
      placeholder={t('platform.descriptionPlaceholder')}
      style={{ width: '100%' }}
      value={value ?? ''}
      onChange={onChange}
    />
  );
});

ManualReasonInput.displayName = 'ManualReasonInput';
