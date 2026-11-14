import { NextResponse } from 'next/server';

import { readSkillZip } from '@/server/services/market/skillZip';

type RouteContext = {
  params: Promise<{
    identifier: string;
  }>;
};

/**
 * GET /market/skills/[identifier]/download
 *
 * Serves the skill ZIP from the read-only catalog directory (`SKILL_ZIP_DIR`,
 * filled by `aico-skills/tools/fetch_zips.py`). Public like the upstream
 * endpoint it replaces; the store must not depend on market.lobehub.com at
 * runtime.
 */
export const GET = async (_req: Request, context: RouteContext) => {
  const { identifier } = await context.params;

  const zip = await readSkillZip(identifier);

  if (!zip) {
    return NextResponse.json({ error: 'Skill archive not found' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(zip), {
    headers: {
      'Content-Disposition': `attachment; filename="${identifier}.zip"`,
      'Content-Length': String(zip.length),
      'Content-Type': 'application/zip',
      // Catalog snapshots are immutable; skip re-reading the file per install.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
