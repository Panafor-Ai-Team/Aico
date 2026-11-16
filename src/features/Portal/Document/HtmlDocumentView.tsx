'use client';

import { Flexbox } from '@lobehub/ui';
import { Segmented } from '@lobehub/ui/base-ui';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { InlineHtmlPreview } from '@/components/HtmlPreview';

type HtmlViewMode = 'code' | 'preview';

interface HtmlDocumentViewProps {
  /** The source view (highlighted, LTR code editor). */
  code: ReactNode;
  content: string;
}

/**
 * `.html` documents open on a rendered, sandboxed preview (read-only); the source
 * stays one click away. The format itself comes from the stored filename and is
 * never switchable here.
 */
const HtmlDocumentView = ({ code, content }: HtmlDocumentViewProps) => {
  const { t } = useTranslation('portal');
  const [mode, setMode] = useState<HtmlViewMode>('preview');

  return (
    <Flexbox gap={8} height={'100%'} paddingBlock={8}>
      <Flexbox horizontal>
        <Segmented
          size={'small'}
          value={mode}
          options={[
            { label: t('artifacts.display.preview'), value: 'preview' },
            { label: t('artifacts.display.code'), value: 'code' },
          ]}
          onChange={(value) => setMode(value as HtmlViewMode)}
        />
      </Flexbox>
      <Flexbox flex={1} style={{ minHeight: 0 }}>
        {mode === 'preview' ? <InlineHtmlPreview content={content} /> : code}
      </Flexbox>
    </Flexbox>
  );
};

export default HtmlDocumentView;
