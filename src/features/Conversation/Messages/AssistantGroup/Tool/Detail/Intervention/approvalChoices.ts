export type ApprovalChoice = 'approve' | 'approve-remember' | 'reject';

/**
 * Ordered choices for the approval footer; they drive both the numbered rows and
 * the 1/2/3 shortcuts. "Approve & don't ask again" is a first-class option
 * (allow-list only) rather than a checkbox nested under approve. Confirm-only
 * cards (the card itself is where the call is set up) get a single choice.
 */
export const resolveApprovalChoices = ({
  confirmOnly,
  isAllowListMode,
}: {
  confirmOnly?: boolean;
  isAllowListMode: boolean;
}): ApprovalChoice[] => {
  if (confirmOnly) return ['approve'];
  return isAllowListMode ? ['approve', 'approve-remember', 'reject'] : ['approve', 'reject'];
};
