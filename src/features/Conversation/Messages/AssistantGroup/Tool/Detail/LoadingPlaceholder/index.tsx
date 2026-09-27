import { getBuiltinPlaceholder } from '@lobechat/builtin-tools/placeholders';
import { getBuiltinStreaming } from '@lobechat/builtin-tools/streamings';
import { safeParseJSON } from '@lobechat/utils';
import { memo } from 'react';

import Arguments from '../Arguments';

interface LoadingPlaceholderProps {
  apiName: string;
  identifier: string;
  loading?: boolean;
  messageId: string;
  requestArgs?: string;
  startTime?: number;
  toolCallId: string;
}

const LoadingPlaceholder = memo<LoadingPlaceholderProps>(
  ({ identifier, requestArgs, apiName, loading, startTime, toolCallId, messageId }) => {
    const Render =
      getBuiltinPlaceholder(identifier, apiName) || getBuiltinStreaming(identifier, apiName);

    if (Render) {
      return (
        <Render
          apiName={apiName}
          args={safeParseJSON(requestArgs) || {}}
          identifier={identifier}
          messageId={messageId}
          startTime={startTime}
          toolCallId={toolCallId}
        />
      );
    }

    return <Arguments arguments={requestArgs} loading={loading} />;
  },
);

export default LoadingPlaceholder;
