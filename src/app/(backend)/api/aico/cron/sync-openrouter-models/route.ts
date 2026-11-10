import { NextResponse } from 'next/server';

import { getServerDB } from '@/database/core/db-adaptor';
import { OpenRouterModelCatalogSyncService } from '@/server/services/openrouter/modelCatalogSync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Managed model catalog sync, every 6h (host crontab / Vercel Cron / manual ops).
 * For CheapVibeCode this refreshes the per-model multipliers the ledger prices with.
 * Auth: `Authorization: Bearer $CRON_SECRET`
 */
export const GET = async (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Service not configured' }, { status: 503 });
  }

  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = await getServerDB();
  const service = new OpenRouterModelCatalogSyncService(db);
  const status = await service.sync('cron');

  const ok = status.lastStatus === 'success';
  return NextResponse.json(status, { status: ok ? 200 : 502 });
};
