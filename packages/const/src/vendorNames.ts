import { BRANDING_NAME } from '@lobechat/business-const';

/**
 * Upstream project and gateway names that must never reach end users (D-018):
 * the forked project (LobeHub / LobeChat / Lobe) and the inference gateways
 * (CheapVibeCode / CVC, OpenRouter). Covers display names, ids and hostnames,
 * e.g. `cheapvibecode`, `api.openrouter.ai`, `lobe-hub`.
 */
const VENDOR_NAME_PATTERN =
  /cheap[\s_-]?vibe[\s_-]?code|open[\s_-]?router|lobe[\s_-]?(?:hub|chat)|\bcvc\b|\blobe\b/gi;

/** True when the text names an upstream project or gateway. */
export const hasVendorName = (text: string): boolean => {
  VENDOR_NAME_PATTERN.lastIndex = 0;
  const found = VENDOR_NAME_PATTERN.test(text);
  VENDOR_NAME_PATTERN.lastIndex = 0;
  return found;
};

/**
 * Replace upstream project and gateway names with the product name.
 * Use on any text that came from a gateway, the upstream code base or the
 * server before it is shown to a user (error messages, error details).
 */
export const scrubVendorNames = (text: string, replacement: string = BRANDING_NAME): string =>
  text.replace(VENDOR_NAME_PATTERN, replacement);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * {@link scrubVendorNames} applied to every string value inside arrays and
 * plain objects. Keys are left alone: they are code identifiers, and renaming
 * them could merge two fields. Other objects (Date, Error, class instances)
 * are returned unchanged.
 */
export const scrubVendorNamesDeep = <T>(value: T, replacement: string = BRANDING_NAME): T => {
  if (typeof value === 'string') return scrubVendorNames(value, replacement) as T;
  if (Array.isArray(value)) {
    return value.map((item) => scrubVendorNamesDeep(item, replacement)) as T;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = scrubVendorNamesDeep(item, replacement);
    }
    return result as T;
  }
  return value;
};
