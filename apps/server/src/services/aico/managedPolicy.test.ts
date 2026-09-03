import { OPENROUTER_AUTO_MODEL_ID } from '@lobechat/business-const';
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OrganizationModel } from '@/database/models/organization';
import { users } from '@/database/schemas';
import {
  modelAccessRules,
  organizationMembers,
  organizations,
  organizationTeamMembers,
  organizationTeams,
} from '@/database/schemas/aicoOrganization';

import { parseAicoBillingContext } from './billingContext';
import { AicoManagedPolicy, AicoManagedPolicyError } from './managedPolicy';

describe('explicit billing context + managed policy', () => {
  it('rejects missing / invalid billing context', () => {
    expect(() => parseAicoBillingContext(undefined)).toThrow(/BILLING_CONTEXT/);
    expect(() => parseAicoBillingContext({ source: 'organization' })).toThrow(
      /BILLING_CONTEXT_ORG/,
    );
    expect(() => parseAicoBillingContext({ source: 'wallet' })).toThrow(/BILLING_CONTEXT_INVALID/);
  });

  it('accepts personal and organization shapes', () => {
    expect(parseAicoBillingContext({ source: 'personal' })).toEqual({ source: 'personal' });
    expect(parseAicoBillingContext({ source: 'organization', organizationId: 'org_1' })).toEqual({
      organizationId: 'org_1',
      source: 'organization',
    });
  });

  it('treats aico and openrouter as managed', () => {
    expect(AicoManagedPolicy.isManagedProvider('aico')).toBe(true);
    expect(AicoManagedPolicy.isManagedProvider('openrouter')).toBe(true);
    expect(AicoManagedPolicy.isManagedProvider('openai')).toBe(false);
  });

  it('AicoManagedPolicyError is fail-closed typed', () => {
    const err = new AicoManagedPolicyError('BILLING_CONTEXT_REQUIRED');
    expect(err.code).toBe('BILLING_CONTEXT_REQUIRED');
    expect(err.name).toBe('AicoManagedPolicyError');
  });

  it('OR-003: authorize requires modelId for managed providers', async () => {
    const policy = new AicoManagedPolicy({} as any, async () => null);
    await expect(
      policy.authorize({ billing: { source: 'personal' }, userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'MODEL_ID_REQUIRED' });
    await expect(
      policy.authorize({ billing: { source: 'personal' }, modelId: '   ', userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'MODEL_ID_REQUIRED' });
  });
});

describe('org wallet: Auto model is not gated by the team allow-list', () => {
  let db: LobeChatDatabase;
  let orgModel: OrganizationModel;
  const ownerId = 'auto-bypass-owner';

  const cleanup = async () => {
    await db.delete(modelAccessRules);
    await db.delete(organizationTeamMembers);
    await db.delete(organizationTeams);
    await db.delete(organizationMembers);
    await db.delete(organizations);
    await db.delete(users);
  };

  beforeEach(async () => {
    db = await getTestDB();
    orgModel = new OrganizationModel(db);
    await cleanup();
    await db.insert(users).values([{ email: 'owner@example.com', id: ownerId }]);
  });

  afterEach(cleanup);

  it('lets Auto through even when the team allow-list omits it, but still blocks other unlisted models', async () => {
    const org = await orgModel.createOrganization({ name: 'Bypass Org', ownerUserId: ownerId });
    const teams = await orgModel.listTeams(org.id);
    // Admin explicitly restricted the team to a non-Auto model.
    await orgModel.setTeamModelAccess({
      modelIds: ['openai/gpt-4o-mini'],
      orgId: org.id,
      teamId: teams[0].id,
    });

    const policy = new AicoManagedPolicy(db, async () => null);
    const billing = parseAicoBillingContext({ organizationId: org.id, source: 'organization' });

    // Auto clears the allow-list gate and fails later (no budget provisioned) —
    // never MODEL_NOT_ALLOWED, which is what a missing allow-list row used to throw.
    await expect(
      policy.authorize({ billing, modelId: OPENROUTER_AUTO_MODEL_ID, userId: ownerId }),
    ).rejects.toMatchObject({ code: 'MEMBER_BUDGET_INACTIVE' });

    // A model that genuinely isn't granted is still rejected.
    await expect(
      policy.authorize({ billing, modelId: 'openai/gpt-4o', userId: ownerId }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_ALLOWED:openai/gpt-4o' });
  });

  it('lets Auto through even when the team is locked to zero models', async () => {
    const org = await orgModel.createOrganization({ name: 'Locked Org', ownerUserId: ownerId });
    const teams = await orgModel.listTeams(org.id);
    await orgModel.setTeamModelAccess({ modelIds: [], orgId: org.id, teamId: teams[0].id });

    const policy = new AicoManagedPolicy(db, async () => null);
    const billing = parseAicoBillingContext({ organizationId: org.id, source: 'organization' });

    await expect(
      policy.authorize({ billing, modelId: OPENROUTER_AUTO_MODEL_ID, userId: ownerId }),
    ).rejects.toMatchObject({ code: 'MEMBER_BUDGET_INACTIVE' });
  });
});
