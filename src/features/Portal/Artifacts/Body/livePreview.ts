import { ArtifactType } from '@/types/artifact';

/** MIME / type values that can render a useful streaming preview. */
const LIVE_PREVIEWABLE = new Set([
  'text/html',
  'html',
  ArtifactType.Default,
  'image/svg+xml',
  'application/lobe.artifacts.mermaid',
  'text/markdown',
]);

/**
 * Source-only artifact types: incomplete code/React won't render usefully, so
 * keep them on the highlighter until the user switches (or generation ends).
 */
const SOURCE_ONLY = new Set([
  ArtifactType.Code,
  ArtifactType.Python,
  ArtifactType.React,
  'application/lobe.artifacts.code',
  'application/lobe.artifacts.react',
  'python',
]);

export const isLivePreviewableArtifactType = (type?: string | null): boolean => {
  if (!type) return true; // missing type defaults to HTML renderer
  if (SOURCE_ONLY.has(type)) return false;
  if (LIVE_PREVIEWABLE.has(type)) return true;
  // Unknown MIME that isn't an artifacts.* code type → treat as HTML-like
  return !type.startsWith('application/lobe.artifacts.');
};
