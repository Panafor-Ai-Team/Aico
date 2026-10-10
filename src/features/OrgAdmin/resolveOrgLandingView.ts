export type OrgLandingView = 'create' | 'manage' | 'member';

type Membership = { id: string; myRole: string };

const MANAGER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/**
 * Decide what `/org` and `/org/:orgId/members` render for the current user.
 *
 * The page used to gate on manageable (owner/admin) orgs only, so invitees
 * who join as `member` landed on the organization creation form right after
 * accepting — even though the join succeeded and the URL already points at
 * their org. They can't use that form anyway (single-org invariant rejects
 * creating a second org), so member-level memberships render a member view.
 */
export const resolveOrgLandingView = (
  mine: ReadonlyArray<Membership> | undefined,
  selectedOrgId: string,
): OrgLandingView => {
  const membership = (mine ?? []).find((o) => o.id === selectedOrgId);
  if (membership && !MANAGER_ROLES.has(membership.myRole)) return 'member';
  if ((mine ?? []).some((o) => MANAGER_ROLES.has(o.myRole))) return 'manage';
  return 'create';
};
