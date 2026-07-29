/**
 * Aico Phase 1 auth helpers.
 *
 * Phone verification is NOT required to sign in. It is only required when a
 * user claims trial credits / acts as an independent buyer or org admin who
 * can spend quota (see `requiresPhoneVerification`).
 *
 * `getCurrentOrgRole` / `isPlatformAdmin` depend on Phase 2 schema
 * (`organization_members`, `platform_admins`). Until those tables land, stubs
 * return null / false.
 */

export type OrgRole = 'owner' | 'admin' | 'member';

/**
 * Resolve the caller's role inside an organization.
 * Phase 2 stub — always `null` until organization schema exists.
 */
export async function getCurrentOrgRole(_userId: string, _orgId: string): Promise<OrgRole | null> {
  return null;
}

/**
 * Whether the user is a platform (super) admin — independent of org roles.
 * Phase 2 stub — always `false` until `platform_admins` exists.
 */
export async function isPlatformAdmin(_userId: string): Promise<boolean> {
  return false;
}

export interface RequiresPhoneVerificationInput {
  /**
   * Optional active org. When omitted / null, the user is treated as an
   * independent buyer (must verify phone to claim trial / spend).
   */
  orgId?: string | null;
  phoneNumberVerified: boolean;
  userId: string;
}

/**
 * Phone verify policy for **trial / spend activation** (not login):
 * - Already verified → skip
 * - Org `member` (invited, non-buyer) → skip
 * - Org `owner` / `admin` → require before spending / trial
 * - No org / unknown role (independent buyer) → require before trial
 *
 * Login and signup must NOT call this as a hard gate.
 */
export async function requiresPhoneVerification(
  input: RequiresPhoneVerificationInput,
): Promise<boolean> {
  if (input.phoneNumberVerified) return false;

  if (input.orgId) {
    const role = await getCurrentOrgRole(input.userId, input.orgId);
    if (role === 'member') return false;
    if (role === 'owner' || role === 'admin') return true;
  }

  // Independent buyer, or Phase 2 stub (null role)
  return true;
}
