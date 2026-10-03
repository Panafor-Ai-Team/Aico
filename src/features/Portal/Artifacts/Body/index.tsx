import { Flexbox, Highlighter } from '@lobehub/ui';
import { memo, useEffect, useMemo } from 'react';

import { useChatStore } from '@/store/chat';
import { chatPortalSelectors, messageStateSelectors } from '@/store/chat/selectors';
import { ArtifactDisplayMode } from '@/store/chat/slices/portal/initialState';
import { ArtifactType } from '@/types/artifact';

import { isLivePreviewableArtifactType } from './livePreview';
import Renderer from './Renderer';

const ArtifactsUI = memo(() => {
  const [
    messageId,
    displayMode,
    isMessageGenerating,
    artifactType,
    artifactContent,
    artifactCodeLanguage,
    isArtifactTagClosed,
  ] = useChatStore((s) => {
    const messageId = chatPortalSelectors.artifactMessageId(s) || '';
    const identifier = chatPortalSelectors.artifactIdentifier(s);

    return [
      messageId,
      s.portalArtifactDisplayMode,
      messageStateSelectors.isMessageGenerating(messageId)(s),
      chatPortalSelectors.artifactType(s),
      chatPortalSelectors.artifactCode(messageId, identifier)(s),
      chatPortalSelectors.artifactCodeLanguage(s),
      chatPortalSelectors.isArtifactTagClosed(messageId, identifier)(s),
    ];
  });

  useEffect(() => {
    // When generation completes while the user is on Code, flip back to Preview.
    if (isMessageGenerating && displayMode === ArtifactDisplayMode.Code && isArtifactTagClosed) {
      useChatStore.setState({ portalArtifactDisplayMode: ArtifactDisplayMode.Preview });
    }
  }, [isMessageGenerating, displayMode, isArtifactTagClosed]);

  const language = useMemo(() => {
    switch (artifactType) {
      case ArtifactType.React: {
        return 'tsx';
      }

      case ArtifactType.Code: {
        return artifactCodeLanguage;
      }

      case ArtifactType.Python: {
        return 'python';
      }

      default: {
        return 'html';
      }
    }
  }, [artifactType, artifactCodeLanguage]);

  // HTML / SVG / mermaid get a live iframe/preview while tokens stream.
  // Code / Python / React stay on the highlighter (incomplete JSX won't sandbox).
  const canLivePreview = isLivePreviewableArtifactType(artifactType);
  const showCode = !canLivePreview || displayMode === ArtifactDisplayMode.Code;
  const isStreamingCode = isMessageGenerating && showCode && !isArtifactTagClosed;
  const isStreamingArtifact = isMessageGenerating && !isArtifactTagClosed;

  // make sure the message and id is valid
  if (!messageId) return;

  return (
    <Flexbox
      className={'portal-artifact'}
      flex={1}
      gap={8}
      height={'100%'}
      paddingInline={12}
      style={{ overflow: 'hidden' }}
    >
      {showCode ? (
        <Flexbox flex={1} style={{ minHeight: 0, overflow: 'auto' }}>
          <Highlighter
            animated={isStreamingCode}
            language={language || 'txt'}
            style={{ fontSize: 12, minHeight: '100%', overflow: 'visible' }}
          >
            {artifactContent}
          </Highlighter>
        </Flexbox>
      ) : (
        <Renderer animated={isStreamingArtifact} content={artifactContent} type={artifactType} />
      )}
    </Flexbox>
  );
});

export default ArtifactsUI;
