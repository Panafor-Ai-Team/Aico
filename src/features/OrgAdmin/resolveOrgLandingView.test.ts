import { describe, expect, it } from 'vitest';

import { resolveOrgLandingView } from './resolveOrgLandingView';

const org = (id: string, myRole: string) => ({ id, myRole });

describe('resolveOrgLandingView', () => {
  it('shows the member view when the selected org is a member-level membership', () => {
    // Invitees join as `member`: they manage nothing, but /org/:orgId/members
    // must render their org instead of the creation form.
    expect(resolveOrgLandingView([org('org-1', 'member')], 'org-1')).toBe('member');
  });

  it('shows the manage view for managers of the selected org', () => {
    expect(resolveOrgLandingView([org('org-1', 'owner')], 'org-1')).toBe('manage');
    expect(resolveOrgLandingView([org('org-1', 'admin')], 'org-1')).toBe('manage');
  });

  it('shows the manage view on /org index when the user manages any org', () => {
    expect(resolveOrgLandingView([org('org-1', 'owner')], '')).toBe('manage');
  });

  it('shows the creation form when the user has no memberships at all', () => {
    expect(resolveOrgLandingView([], '')).toBe('create');
    expect(resolveOrgLandingView(undefined, '')).toBe('create');
  });

  it('shows the creation form for an org the user is not a member of', () => {
    expect(resolveOrgLandingView([org('org-1', 'member')], 'org-2')).toBe('create');
  });

  it('shows the member view for a member org even when the user manages another org', () => {
    expect(resolveOrgLandingView([org('org-1', 'owner'), org('org-2', 'member')], 'org-2')).toBe(
      'member',
    );
  });
});
