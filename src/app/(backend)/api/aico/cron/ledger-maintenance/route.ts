import { NextResponse } from 'next/server';

import { getServerDB } from '@/database/core/db-adaptor';
import { assertCronAuth } from '@/server/services/aico/cronAuth';
import { runLedgerMaintenance } from '@/server/services/aico/ledger/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Usage ledger upkeep: charges expired holds and reconciles the shared CVC
 * account against ledger spend.
 * Suggested interval: every 5 minutes.
 * Auth: `Authorization: Bearer $CRON_SECRET`
 */
export const GET = async (req: Request) => {
  const denied = assertCronAuth(req);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const db = await getServerDB();
  return NextResponse.json(await runLedgerMaintenance(db));
};
