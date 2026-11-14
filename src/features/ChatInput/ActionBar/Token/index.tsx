import { ErrorBoundary } from '@lobehub/ui';
import { type PropsWithChildren } from 'react';
import { memo } from 'react';

import { useModelHasContextWindowToken } from '@/hooks/useModelHasContextWindowToken';
import dynamic from '@/libs/next/dynamic';

const LargeTokenContent = dynamic(() => import('./TokenTag'), { ssr: false });

const Token = memo<PropsWithChildren>(({ children }) => {
  const showTag = useModelHasContextWindowToken();

  return showTag && children;
});

// The token tag is decorative. If its lazy chunk fails to load (a tab opened
// before a deploy asks for a chunk hash that no longer exists), render nothing
// instead of letting the error reach the route boundary and replace the chat.
const renderNothing = () => null;

const ContextWindow = () => {
  return (
    <Token>
      <ErrorBoundary fallbackRender={renderNothing}>
        <LargeTokenContent />
      </ErrorBoundary>
    </Token>
  );
};

export default ContextWindow;
