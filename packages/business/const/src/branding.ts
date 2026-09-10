// the code below can only be modified with commercial license
// if you want to use it in the commercial usage
// please contact us for more information: hello@lobehub.com

/**
 * Every env read below MUST be written out as a literal `process.env.X` (or
 * `process.env['X']`) expression, once per variable.
 *
 * The SPA is bundled by esbuild with `'process.env': '{}'` plus one define per
 * `NEXT_PUBLIC_*` key (see `plugins/vite/sharedRendererConfig.ts`). esbuild
 * substitutes only *statically analysable* keys: a lookup whose key is a
 * variable — as in the previous `readBrandingEnv(name)` helper, which did
 * `process.env[name]` — compiles to `({})[name]` and is therefore always
 * `undefined` in the browser. That silently pinned the client to the fallbacks
 * below while the Node server read the real values, so branding diverged
 * between server and client.
 *
 * Note this means client-side branding is baked in at BUILD time and only via
 * the `NEXT_PUBLIC_*` twin — a private `BRANDING_*` var is deliberately never
 * exposed to the browser bundle.
 */
const brandingValue = (value: string | undefined, fallback: string) => value?.trim() || fallback;

/** Default product name shown across the UI, metadata, and API client headers. */
export const BRANDING_NAME = brandingValue(
  process.env.BRANDING_NAME ?? process.env.NEXT_PUBLIC_BRANDING_NAME,
  'Panachat',
);

/**
 * Persian display name for fa-* locales (UI copy, logos, i18n `{{appName}}`).
 * Falls back to {@link BRANDING_NAME} when unset.
 */
export const BRANDING_NAME_FA = brandingValue(
  process.env.BRANDING_NAME_FA ?? process.env.NEXT_PUBLIC_BRANDING_NAME_FA,
  'پاناچت',
);

/** Brand mark / emoji used in auth emails and similar surfaces. */
export const BRANDING_EMOJI = brandingValue(
  process.env.BRANDING_EMOJI ?? process.env.NEXT_PUBLIC_BRANDING_EMOJI,
  '🐦‍🔥',
);

/** Organization / legal entity name used in copyright and structured data. */
export const ORG_NAME = brandingValue(
  process.env.ORG_NAME ?? process.env.NEXT_PUBLIC_ORG_NAME,
  BRANDING_NAME,
);

/** Persian organization name for fa-* locales. */
export const ORG_NAME_FA = brandingValue(
  process.env.ORG_NAME_FA ?? process.env.NEXT_PUBLIC_ORG_NAME_FA,
  BRANDING_NAME_FA,
);

/** Hosted cloud offering name, e.g. "Panachat Cloud". */
export const BRANDING_CLOUD_NAME = brandingValue(
  process.env.BRANDING_CLOUD_NAME ?? process.env.NEXT_PUBLIC_BRANDING_CLOUD_NAME,
  `${BRANDING_NAME} Cloud`,
);

/** Persian cloud offering name for fa-* locales. */
export const BRANDING_CLOUD_NAME_FA = brandingValue(
  process.env.BRANDING_CLOUD_NAME_FA ?? process.env.NEXT_PUBLIC_BRANDING_CLOUD_NAME_FA,
  `ابر ${BRANDING_NAME_FA}`,
);

/** @deprecated Use {@link BRANDING_CLOUD_NAME} instead. */
export const LOBE_CHAT_CLOUD = BRANDING_CLOUD_NAME;

/** Public marketing / docs site URL (defaults to APP_URL when unset). */
export const BRANDING_SITE_URL = brandingValue(
  process.env.BRANDING_SITE_URL ?? process.env.NEXT_PUBLIC_BRANDING_SITE_URL,
  '',
);

/** Product logo URL used by ProductLogo / metadata. Defaults to the favicon_io PWA icon. */
export const BRANDING_LOGO_URL = brandingValue(
  process.env.BRANDING_LOGO_URL ?? process.env.NEXT_PUBLIC_BRANDING_LOGO_URL,
  '/icons/icon-192x192.png',
);

/**
 * Unset by default. Typed as optional strings rather than literal `undefined`
 * so consumers can narrow them (`SOCIAL_URL.discord?.trim()`) and a white-label
 * deployment can populate them — a literal `undefined` type collapses those
 * expressions to `never`.
 */
type OptionalUrl = string | undefined;

export const BRANDING_URL: {
  help: OptionalUrl;
  privacy: OptionalUrl;
  subscription: OptionalUrl;
  support: OptionalUrl;
  terms: OptionalUrl;
} = {
  help: undefined,
  privacy: undefined,
  subscription: undefined,
  support: undefined,
  terms: undefined,
};

export const SOCIAL_URL: {
  discord: OptionalUrl;
  github: OptionalUrl;
  medium: OptionalUrl;
  x: OptionalUrl;
  youtube: OptionalUrl;
} = {
  discord: undefined,
  github: undefined,
  medium: undefined,
  x: undefined,
  youtube: undefined,
};

export const FILE_URL: { importFromNotionGuide: OptionalUrl } = {
  importFromNotionGuide: undefined,
};

export const BRANDING_EMAIL: {
  business: string;
  replyTo: OptionalUrl;
  support: string;
} = {
  business: readBrandingEnv('BRANDING_BUSINESS_EMAIL', ''),
  replyTo: undefined,
  support: brandingValue(
    process.env.BRANDING_SUPPORT_EMAIL ?? process.env.NEXT_PUBLIC_BRANDING_SUPPORT_EMAIL,
    '',
  ),
};

export const BRANDING_PROVIDER = brandingValue(
  process.env.BRANDING_PROVIDER ?? process.env.NEXT_PUBLIC_BRANDING_PROVIDER,
  'official',
);

export const APPLE_APP_STORE_ID = '';

export const COPYRIGHT = `© ${new Date().getFullYear()} ${ORG_NAME}`;
export const COPYRIGHT_FULL = `${COPYRIGHT}. All rights reserved.`;

/** True when the locale should use Persian brand strings. */
export const isPersianBrandingLocale = (locale?: string | null) =>
  Boolean(locale && (locale === 'fa-IR' || locale === 'fa' || locale.startsWith('fa-')));

/** Product display name for the given locale (Persian → پاناچت). */
export const getLocalizedBrandingName = (locale?: string | null) =>
  isPersianBrandingLocale(locale) ? BRANDING_NAME_FA : BRANDING_NAME;

/** Default inbox assistant title, e.g. "Panachat AI". */
export const BRANDING_INBOX_NAME = `${BRANDING_NAME} AI`;

/** Persian inbox assistant title for fa-* locales. */
export const BRANDING_INBOX_NAME_FA = `${BRANDING_NAME_FA} AI`;

/** Inbox assistant display name for the given locale. */
export const getLocalizedBrandingInboxName = (locale?: string | null) =>
  isPersianBrandingLocale(locale) ? BRANDING_INBOX_NAME_FA : BRANDING_INBOX_NAME;

/** Organization display name for the given locale. */
export const getLocalizedOrgName = (locale?: string | null) =>
  isPersianBrandingLocale(locale) ? ORG_NAME_FA : ORG_NAME;

/** Cloud offering display name for the given locale. */
export const getLocalizedBrandingCloudName = (locale?: string | null) =>
  isPersianBrandingLocale(locale) ? BRANDING_CLOUD_NAME_FA : BRANDING_CLOUD_NAME;
