export type ApprovalChoice = 'approve' | 'approve-chat' | 'approve-remember' | 'reject';

/**
 * Ordered choices for the approval footer; they drive both the numbered rows and
 * the 1/2/3 shortcuts. "Approve" covers the rest of the request; "Always approve
 * in this chat" covers every later request in the topic (only when there is a
 * topic to remember it on). "Approve & don't ask again" is a first-class option
 * (allow-list only) rather than a checkbox nested under approve. Confirm /
 * cancel cards (the card itself is where the call is set up) have no rows:
 * Enter confirms, and a separate Cancel button stops the call.
 */
export const resolveApprovalChoices = ({
  canApproveChat,
  confirmCancel,
  isAllowListMode,
}: {
  canApproveChat: boolean;
  confirmCancel?: boolean;
  isAllowListMode: boolean;
}): ApprovalChoice[] => {
  if (confirmCancel) return ['approve'];

  const choices: ApprovalChoice[] = ['approve'];
  if (canApproveChat) choices.push('approve-chat');
  if (isAllowListMode) choices.push('approve-remember');
  choices.push('reject');
  return choices;
};

export type ApprovalFooterButton = 'cancel' | 'confirm' | 'submit';

/** Footer buttons, left to right. */
export const resolveApprovalFooterButtons = ({
  confirmCancel,
}: {
  confirmCancel?: boolean;
}): ApprovalFooterButton[] => (confirmCancel ? ['cancel', 'confirm'] : ['submit']);
