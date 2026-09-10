import type { ReactNode } from 'react';

export type TextDirection = 'ltr' | 'rtl' | null;

/**
 * First-strong character direction (Unicode bidi base direction).
 * Skips neutrals; returns rtl for Arabic/Persian/Hebrew strong chars,
 * ltr for Latin (and other LTR) letters. Digits alone do not set direction.
 */
const RTL_STRONG =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const LTR_STRONG = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02B8\u0400-\u04FF]/u;

export const getTextDirectionFromFirstStrong = (text: string): TextDirection => {
  for (const char of text) {
    if (RTL_STRONG.test(char)) return 'rtl';
    if (LTR_STRONG.test(char)) return 'ltr';
  }
  return null;
};

/**
 * Concatenate the text of a ReactNode tree (plain strings, arrays, fragments,
 * elements such as stream-animation spans). Lets message-level `dir` resolve
 * from the actual words even when children are not a single string — otherwise
 * the direction silently falls back to the page direction mid-stream.
 */
export const extractTextFromReactNode = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractTextFromReactNode).join('');
  if (typeof node === 'object' && 'props' in node) {
    return extractTextFromReactNode((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
};
