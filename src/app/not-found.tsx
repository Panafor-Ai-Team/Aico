export const dynamic = 'force-static';

/**
 * Next App Router miss (rare — SPA `[[...path]]` usually serves chat URLs).
 * Keep this static: the root layout has no i18n / theme providers.
 */
export default function GlobalNotFound() {
  return (
    <main
      style={{
        alignItems: 'center',
        display: 'flex',
        flexDirection: 'column',
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
        gap: 12,
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <p style={{ fontSize: 64, fontWeight: 700, margin: 0, opacity: 0.12 }}>404</p>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Page not found</h1>
      <p style={{ color: '#666', fontSize: 14, lineHeight: 1.6, margin: 0, maxWidth: 420 }}>
        This page doesn&apos;t exist or may have been moved.
      </p>
      <a
        href="/"
        style={{
          background: '#111',
          borderRadius: 8,
          color: '#fff',
          fontSize: 14,
          fontWeight: 500,
          marginTop: 8,
          padding: '8px 16px',
          textDecoration: 'none',
        }}
      >
        Back to Home
      </a>
    </main>
  );
}
