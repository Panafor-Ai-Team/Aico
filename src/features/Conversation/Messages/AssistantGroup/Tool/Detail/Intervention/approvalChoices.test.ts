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
  it('offers approve and reject in manual mode', () => {
    expect(resolveApprovalChoices({ isAllowListMode: false })).toEqual(['approve', 'reject']);
  });

  it('adds "approve and remember" in allow-list mode', () => {
    expect(resolveApprovalChoices({ isAllowListMode: true })).toEqual([
      'approve',
      'approve-remember',
      'reject',
    ]);
  });

  it('has no reject-reason or remember rows on confirm / cancel cards', () => {
    expect(resolveApprovalChoices({ confirmCancel: true, isAllowListMode: true })).toEqual([
      'approve',
    ]);
    expect(resolveApprovalChoices({ confirmCancel: true, isAllowListMode: false })).toEqual([
      'approve',
    ]);
  });
});
