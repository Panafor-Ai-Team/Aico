/**
 * RI — a member whose removal is still being settled (revocation_pending) must
 * not be re-activated by a new invite or a manager assignment: the queued
 * reclaim would settle the new membership's allocation.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { organizationInvites, organizationMembers } from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { OrganizationModel } from '../organization';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const orgModel = new OrganizationModel(serverDB);
const ownerId = 'rejoin-owner';
const memberUserId = 'rejoin-member';
const otherOwnerId = 'rejoin-other-owner';

const joinAs = async (orgId: string, invitedBy: string, userId: string, email: string) => {
  const invite = await orgModel.createInvite({
    identifierType: 'email',
    identifierValue: email,
    invitedByUserId: invitedBy,
    orgId,
    role: 'member',
  });
  const { member } = await orgModel.acceptInvite({ email, token: invite.token, userId });
  return { invite, member };
};

const setStatus = (memberId: string, status: 'left' | 'revocation_pending') =>
  serverDB.update(organizationMembers).set({ status }).where(eq(organizationMembers.id, memberId));

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'rejoin-owner@example.com', id: ownerId },
    { email: 'rejoin-member@example.com', id: memberUserId },
    { email: 'rejoin-other-owner@example.com', id: otherOwnerId },
  ]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

describe('re-joining while a removal is unsettled (RI)', () => {
  it('rejects an invite for a revocation_pending member and leaves invite and member untouched', async () => {
    const org = await orgModel.createOrganization({ name: 'Rejoin Org', ownerUserId: ownerId });
    const { member } = await joinAs(org.id, ownerId, memberUserId, 'rejoin-member@example.com');
    await setStatus(member.id, 'revocation_pending');

    const second = await orgModel.createInvite({
      identifierType: 'email',
      identifierValue: 'rejoin-member@example.com',
      invitedByUserId: ownerId,
      orgId: org.id,
      role: 'member',
    });

    await expect(
      orgModel.acceptInvite({
        email: 'rejoin-member@example.com',
        token: second.token,
        userId: memberUserId,
      }),
    ).rejects.toThrow('MEMBER_REMOVAL_IN_PROGRESS');

    const [row] = await serverDB
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.id, member.id));
    expect(row.status).toBe('revocation_pending');

    const [inviteRow] = await serverDB
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.id, second.id));
    expect(inviteRow.status).toBe('pending');
  });

  it('lets a member who has fully left re-join', async () => {
    const org = await orgModel.createOrganization({ name: 'Rejoin Org', ownerUserId: ownerId });
    const { member } = await joinAs(org.id, ownerId, memberUserId, 'rejoin-member@example.com');
    await setStatus(member.id, 'left');

    const { member: rejoined } = await joinAs(
      org.id,
      ownerId,
      memberUserId,
      'rejoin-member@example.com',
    );

    expect(rejoined.id).toBe(member.id);
    expect(rejoined.status).toBe('active');
  });

  it('still rejects a user who is active in a different organization', async () => {
    const orgA = await orgModel.createOrganization({ name: 'Org A', ownerUserId: ownerId });
    const orgB = await orgModel.createOrganization({
      name: 'Org B',
      ownerUserId: otherOwnerId,
    });
    await joinAs(orgA.id, ownerId, memberUserId, 'rejoin-member@example.com');

    const invite = await orgModel.createInvite({
      identifierType: 'email',
      identifierValue: 'rejoin-member@example.com',
      invitedByUserId: otherOwnerId,
      orgId: orgB.id,
      role: 'member',
    });

    await expect(
      orgModel.acceptInvite({
        email: 'rejoin-member@example.com',
        token: invite.token,
        userId: memberUserId,
      }),
    ).rejects.toThrow('USER_ALREADY_IN_ORGANIZATION');
  });

  it('assignManager refuses a revocation_pending member and keeps the row as it was', async () => {
    const org = await orgModel.createOrganization({ name: 'Rejoin Org', ownerUserId: ownerId });
    const { member } = await joinAs(org.id, ownerId, memberUserId, 'rejoin-member@example.com');
    await setStatus(member.id, 'revocation_pending');

    await expect(
      orgModel.assignManager({ orgId: org.id, role: 'admin', userId: memberUserId }),
    ).rejects.toThrow('MEMBER_REMOVAL_IN_PROGRESS');

    const [row] = await serverDB
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.id, member.id));
    expect(row.status).toBe('revocation_pending');
    expect(row.role).toBe('member');
  });

  it('assignManager still re-activates a member who has left', async () => {
    const org = await orgModel.createOrganization({ name: 'Rejoin Org', ownerUserId: ownerId });
    const { member } = await joinAs(org.id, ownerId, memberUserId, 'rejoin-member@example.com');
    await setStatus(member.id, 'left');

    const updated = await orgModel.assignManager({
      orgId: org.id,
      role: 'admin',
      userId: memberUserId,
    });

    expect(updated.status).toBe('active');
    expect(updated.role).toBe('admin');
  });
});
