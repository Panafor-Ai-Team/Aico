import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getServerDB } from '@/database/core/db-adaptor';
import { assertCronAuth } from '@/server/services/aico/cronAuth';
import {
  runLedgerSnapshotPhase,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_LIMIT,
} from '@/server/services/aico/ledger/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(SNAPSHOT_MAX_LIMIT).default(SNAPSHOT_DEFAULT_LIMIT),
  phase: z.enum(['wallets', 'budgets', 'finalize']),
});

/**
 * Enforce cutover snapshot, run by an operator while the ledger is paused:
 * `?phase=wallets`, then `budgets`, each until `done: true`, then `finalize`.
 * Auth: `Authorization: Bearer $CRON_SECRET`
 */
export const POST = async (req: Request) => {
  const denied = assertCronAuth(req);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({
    limit: searchParams.get('limit') ?? undefined,
    phase: searchParams.get('phase') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const db = await getServerDB();
  const { body, status } = await runLedgerSnapshotPhase(db, parsed.data);
  return NextResponse.json(body, { status });
};
