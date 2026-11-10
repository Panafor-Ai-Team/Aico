import { NextResponse } from 'next/server';

import { buildConnectorClientMetadata } from '@/server/services/connector/oauth';

/** Public OAuth Client ID Metadata Document (CIMD) for custom connectors. */
export const GET = () => {
  const metadata = buildConnectorClientMetadata();
  if (!metadata) return new NextResponse(null, { status: 404 });
  return NextResponse.json(metadata, { headers: { 'cache-control': 'public, max-age=3600' } });
};
