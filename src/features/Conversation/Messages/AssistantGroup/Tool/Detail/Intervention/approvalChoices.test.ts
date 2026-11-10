import { describe, expect, it } from 'vitest';

import { resolveApprovalChoices, resolveApprovalFooterButtons } from './approvalChoices';

describe('resolveApprovalFooterButtons', () => {
  it('gives confirm / cancel cards both a Cancel and a Confirm button', () => {
    expect(resolveApprovalFooterButtons({ confirmCancel: true })).toEqual(['cancel', 'confirm']);
  });

  it('keeps the single Submit button for regular approval cards', () => {
    expect(resolveApprovalFooterButtons({})).toEqual(['submit']);
  });
});

describe('resolveApprovalChoices', () => {
  it('offers approve, approve for the chat and reject in manual mode', () => {
    expect(resolveApprovalChoices({ canApproveChat: true, isAllowListMode: false })).toEqual([
      'approve',
      'approve-chat',
      'reject',
    ]);
  });

  it('adds "approve and remember" in allow-list mode', () => {
    expect(resolveApprovalChoices({ canApproveChat: true, isAllowListMode: true })).toEqual([
      'approve',
      'approve-chat',
      'approve-remember',
      'reject',
    ]);
  });

  it('hides "approve for the chat" when there is no chat to remember it on', () => {
    expect(resolveApprovalChoices({ canApproveChat: false, isAllowListMode: false })).toEqual([
      'approve',
      'reject',
    ]);
  });

  it('has no reject-reason or remember rows on confirm / cancel cards', () => {
    expect(
      resolveApprovalChoices({ canApproveChat: true, confirmCancel: true, isAllowListMode: true }),
    ).toEqual(['approve']);
    expect(
      resolveApprovalChoices({ canApproveChat: true, confirmCancel: true, isAllowListMode: false }),
    ).toEqual(['approve']);
  });
});
