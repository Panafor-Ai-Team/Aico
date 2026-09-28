export type ApprovalChoice = 'approve' | 'approve-remember' | 'reject';

/**
 * Ordered choices for the approval footer; they drive both the numbered rows and
 * the 1/2/3 shortcuts. "Approve & don't ask again" is a first-class option
 * (allow-list only) rather than a checkbox nested under approve. Confirm / cancel
 * cards (the card itself is where the call is set up) have no rows: Enter
 * confirms, and a separate Cancel button stops the call.
 */
export const resolveApprovalChoices = ({
  confirmCancel,
  isAllowListMode,
}: {
  confirmCancel?: boolean;
  isAllowListMode: boolean;
}): ApprovalChoice[] => {
  if (confirmCancel) return ['approve'];
  return isAllowListMode ? ['approve', 'approve-remember', 'reject'] : ['approve', 'reject'];
};

export type ApprovalFooterButton = 'cancel' | 'confirm' | 'submit';

/** Footer buttons, left to right. */
export const resolveApprovalFooterButtons = ({
  confirmCancel,
}: {
  confirmCancel?: boolean;
}): ApprovalFooterButton[] => (confirmCancel ? ['cancel', 'confirm'] : ['submit']);
