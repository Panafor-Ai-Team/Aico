'use client';

import { memo } from 'react';

import NotFound from '@/components/404';

/** SPA catch-all page for unknown URLs — stays light instead of redirecting home. */
const NotFoundPage = memo(() => <NotFound />);

NotFoundPage.displayName = 'NotFoundPage';

export default NotFoundPage;
