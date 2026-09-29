'use client';

import { memo } from 'react';

import NotFound from '@/components/404';

/** Community detail miss — same 404 surface as unknown routes. */
const CommunityNotFound = memo(() => <NotFound />);

CommunityNotFound.displayName = 'CommunityNotFound';

export default CommunityNotFound;
