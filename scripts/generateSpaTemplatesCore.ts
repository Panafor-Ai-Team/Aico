/**
 * Vite production builds rewrite absolute `/app-icons/...` URLs with `base` (`/_spa/`
 * or `/_spa-auth/`). The splash logo and PWA icons already live at root
 * `/app-icons/...` (see BRANDING_LOGO_URL / public/app-icons), so map them back before
 * embedding the HTML into Next templates.
 */
export const normalizeSpaHtmlPublicPaths = (html: string) =>
  html
    .replaceAll('/_spa/app-icons/', '/app-icons/')
    .replaceAll('/_spa-auth/app-icons/', '/app-icons/');
