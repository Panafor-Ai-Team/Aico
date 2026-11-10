import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * Guards the SPA bundle, not the Node runtime.
 *
 * `branding.test.ts` runs under Node, where `process.env` is a real object, so a
 * dynamic `process.env[name]` lookup works there and every assertion passes —
 * which is precisely why the client-side breakage went unnoticed. The browser
 * bundle is different: vite/esbuild replaces `process.env` with `{}` and injects
 * one define per `NEXT_PUBLIC_*` key, so only *statically analysable* reads
 * survive. A variable key compiles to `({})[name]` and always yields undefined.
 *
 * So the only way to catch a regression is to bundle the module the way the SPA
 * does and assert the override actually lands in the output.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));

const BRANDING_ENTRY = path.join(dir, 'branding.ts');
// OFFICIAL_URL / OFFICIAL_SITE live in @lobechat/const and had the same defect.
const URL_ENTRY = path.resolve(dir, '../../../const/src/url.ts');

const bundleWithSpaDefines = async (entry: string, defines: Record<string, string>) => {
  const result: any = await build({
    build: {
      // Dependencies are bundled in (not externalised) so the output can be
      // evaluated standalone from a data: URL.
      lib: { entry, fileName: 'out', formats: ['es'] },
      minify: false,
      write: false,
    },
    define: {
      ...defines,
      // Mirrors plugins/vite/sharedRendererConfig.ts: a bare `process.env`
      // fallback so browser runtime access doesn't crash.
      'process.env': '{}',
    },
    logLevel: 'silent',
  });

  return result[0].output[0].code as string;
};

/**
 * Evaluate the bundled output in isolation. Asserting on the *evaluated export*
 * rather than on substrings matters: the hardcoded fallbacks legitimately remain
 * in the bundle as fallback arguments, so a text search cannot distinguish
 * "override applied" from "fallback used".
 */
const evaluateBundle = async (code: string) =>
  import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

describe('branding constants survive SPA bundling', () => {
  it('applies NEXT_PUBLIC_ branding overrides in the client bundle', async () => {
    const code = await bundleWithSpaDefines(BRANDING_ENTRY, {
      'process.env.NEXT_PUBLIC_BRANDING_NAME': JSON.stringify('BrandProbe'),
      'process.env.NEXT_PUBLIC_BRANDING_PROVIDER': JSON.stringify('provider-probe'),
    });

    const bundled = await evaluateBundle(code);

    expect(bundled.BRANDING_NAME).toBe('BrandProbe');
    expect(bundled.BRANDING_PROVIDER).toBe('provider-probe');
    // Derived values must follow the override, not the hardcoded fallback.
    expect(bundled.BRANDING_CLOUD_NAME).toBe('BrandProbe Cloud');
    expect(bundled.ORG_NAME).toBe('BrandProbe');
  });

  it('falls back cleanly when no override is defined', async () => {
    const bundled = await evaluateBundle(await bundleWithSpaDefines(BRANDING_ENTRY, {}));

    expect(bundled.BRANDING_NAME).toBe('Panachat');
  });

  it('applies NEXT_PUBLIC_APP_URL so OFFICIAL_URL is not pinned to localhost', async () => {
    const code = await bundleWithSpaDefines(URL_ENTRY, {
      'process.env.NEXT_PUBLIC_APP_URL': JSON.stringify('https://chat.example.com'),
    });

    const bundled = await evaluateBundle(code);

    expect(bundled.OFFICIAL_URL).toBe('https://chat.example.com');
    expect(bundled.OFFICIAL_SITE).toBe('https://chat.example.com');
  });

  it.each([
    ['branding.ts', BRANDING_ENTRY],
    ['const/url.ts', URL_ENTRY],
  ])('reads env with statically analysable keys in %s', async (_name, entry) => {
    const output = await bundleWithSpaDefines(entry, {});

    // A dynamic lookup survives bundling as an index against the substituted
    // empty object. Nothing in these modules should read env by variable key.
    expect(output).not.toMatch(/process_env_default\s*\[/);
    expect(output).not.toMatch(/\{\s*\}\s*\[/);
  });
});
