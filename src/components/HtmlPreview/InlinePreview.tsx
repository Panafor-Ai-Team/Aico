'use client';

import { HtmlPreview } from '@lobehub/ui';
import type { CSSProperties } from 'react';
import { memo, useMemo } from 'react';

import { applyHtmlPreviewBaseUrl } from './applyBaseUrl';
import { ensurePreviewableHtmlDocument } from './detectHtml';

const hideHtmlPreviewActions = () => null;

interface InlineHtmlPreviewProps {
  animated?: boolean;
  baseUrl?: string;
  className?: string;
  content: string;
  height?: CSSProperties['height'];
  style?: CSSProperties;
  width?: CSSProperties['width'];
}

const InlineHtmlPreview = memo<InlineHtmlPreviewProps>(
  ({ animated, baseUrl, className, content, height = '100%', style, width = '100%' }) => {
    const previewContent = useMemo(() => {
      // Wrap fragments so HtmlPreview can leave source-only mode and iframe them.
      const documentHtml = ensurePreviewableHtmlDocument(content);
      return applyHtmlPreviewBaseUrl(documentHtml, baseUrl);
    }, [baseUrl, content]);

    return (
      <HtmlPreview
        actionsRender={hideHtmlPreviewActions}
        animated={animated}
        className={className}
        copyable={false}
        defaultHeight={typeof height === 'number' ? height : 420}
        defaultMode="preview"
        downloadable={false}
        shadow={false}
        streamingMode="auto"
        style={{ height, minHeight: 0, overflow: 'hidden', width, ...style }}
        variant={'borderless'}
        styles={{
          content: { height: '100%' },
          iframe: { height: '100%' },
        }}
      >
        {previewContent}
      </HtmlPreview>
    );
  },
);

InlineHtmlPreview.displayName = 'InlineHtmlPreview';

export default InlineHtmlPreview;
