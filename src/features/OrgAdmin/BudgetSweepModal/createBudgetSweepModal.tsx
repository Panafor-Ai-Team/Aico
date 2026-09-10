'use client';

import { createModal, type ModalInstance } from '@lobehub/ui/base-ui';
import { t } from 'i18next';

import { BudgetSweepModalContent, type BudgetSweepModalContentProps } from './Content';

export const createBudgetSweepModal = (props: BudgetSweepModalContentProps): ModalInstance =>
  createModal({
    content: <BudgetSweepModalContent {...props} />,
    footer: null,
    // A half-finished money-moving confirmation should not close on a stray click.
    maskClosable: false,
    styles: { content: { paddingBlock: 8, paddingInline: 24 } },
    title: t('org.sweep.title', { ns: 'aico' }),
    width: 'min(94vw, 860px)',
  });
