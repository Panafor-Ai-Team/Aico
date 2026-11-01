import { ArtifactType } from '@/types/artifact';

const TYPE_EXTENSIONS: Record<string, string> = {
  'application/lobe.artifacts.mermaid': 'mmd',
  [ArtifactType.Python]: 'py',
  [ArtifactType.React]: 'tsx',
  'image/svg+xml': 'svg',
  'text/markdown': 'md',
};

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  javascript: 'js',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  kotlin: 'kt',
  markdown: 'md',
  md: 'md',
  php: 'php',
  py: 'py',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  sh: 'sh',
  shell: 'sh',
  sql: 'sql',
  swift: 'swift',
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yml',
};

// Characters rejected by Windows / macOS / Linux file systems
const UNSAFE_FILENAME_CHARS = /["*/:<>?\\|]/g;

const getExtension = (type?: string, language?: string) => {
  if (type === ArtifactType.Code) {
    return LANGUAGE_EXTENSIONS[language?.toLowerCase() || ''] || 'txt';
  }

  // html, text/html, a missing type and unknown types all render as HTML
  return (type && TYPE_EXTENSIONS[type]) || 'html';
};

interface ArtifactFileNameParams {
  identifier?: string;
  language?: string;
  title?: string;
  type?: string;
}

export const getArtifactFileName = ({
  identifier,
  language,
  title,
  type,
}: ArtifactFileNameParams) => {
  const baseName =
    [identifier, title]
      .map((name) => name?.replaceAll(UNSAFE_FILENAME_CHARS, '').trim())
      .find(Boolean) || 'artifact';

  return `${baseName}.${getExtension(type, language)}`;
};
