/**
 * W2 — a key shrink that failed after an admin debit is retried by shrinking,
 * not by `ensureUserKey`, which only ever raises a key.
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { users } from '@/database/schemas';
import { aicoKeyOutbox } from '@/database/schemas/aicoOrganization';
import { processKeyOutbox } from '@/server/services/aico/renewalScheduler';
import type { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

const userId = 'w2-shrink-user';

describe('W2 processKeyOutbox shrink_user_key', () => {
  let db: LobeChatDatabase;

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(aicoKeyOutbox);
    await db.delete(users);
    await db.insert(users).values({ email: 'w2@example.com', id: userId });
  });

  afterEach(async () => {
    await db.delete(aicoKeyOutbox);
    await db.delete(users);
  });

  const enqueue = () =>
    db.insert(aicoKeyOutbox).values({
      action: 'shrink_user_key',
      nextAttemptAt: new Date(Date.now() - 1000),
      status: 'pending',
      userId,
    });

  const readJob = () =>
    db.query.aicoKeyOutbox.findFirst({ where: eq(aicoKeyOutbox.userId, userId) });

  it('shrinks the key and completes the job', async () => {
    await enqueue();
    const shrinkUserKey = vi.fn(async () => ({ keyId: 'k1', status: 'resized' }));
    const ensureUserKey = vi.fn();
    const keyService = { ensureUserKey, shrinkUserKey } as unknown as AicoOpenRouterKeyService;

    await processKeyOutbox(db, { keyService });

    expect(shrinkUserKey).toHaveBeenCalledWith(userId);
    expect(ensureUserKey).not.toHaveBeenCalled();
    expect((await readJob())?.status).toBe('succeeded');
  });

  it('keeps retrying while the shrink outcome is unknown', async () => {
    await enqueue();
    const shrinkUserKey = vi.fn(async () => ({ keyId: 'k1', status: 'ambiguous' }));
    const keyService = { shrinkUserKey } as unknown as AicoOpenRouterKeyService;

    await processKeyOutbox(db, { keyService });

    const job = await readJob();
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(1);
  });

  it('keeps retrying while the shrink could not be verified', async () => {
    await enqueue();
    const shrinkUserKey = vi.fn(async () => ({ keyId: 'k1', status: 'kept', unverified: true }));
    const keyService = { shrinkUserKey } as unknown as AicoOpenRouterKeyService;

    await processKeyOutbox(db, { keyService });

    const job = await readJob();
    expect(job?.status).toBe('pending');
    expect(job?.lastError).toBe('SHRINK_UNVERIFIED');
  });

  it('keeps retrying a key sync that could not be verified, and completes once it can', async () => {
    await db.insert(aicoKeyOutbox).values({
      action: 'sync_user_key',
      nextAttemptAt: new Date(Date.now() - 1000),
      status: 'pending',
      userId,
    });
    const ensureUserKey = vi
      .fn()
      .mockResolvedValueOnce({ created: false, keyId: 'k1', unverified: true })
      .mockResolvedValue({ created: false, keyId: 'k1' });
    const keyService = { ensureUserKey } as unknown as AicoOpenRouterKeyService;

    await processKeyOutbox(db, { keyService });
    expect((await readJob())?.status).toBe('pending');
    expect((await readJob())?.lastError).toBe('KEY_SYNC_UNVERIFIED');

    await processKeyOutbox(db, { keyService, now: new Date(Date.now() + 10 * 60_000) });
    expect((await readJob())?.status).toBe('succeeded');
  });
});
