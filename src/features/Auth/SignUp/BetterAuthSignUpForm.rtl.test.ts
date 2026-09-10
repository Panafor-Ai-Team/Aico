import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Persian is the primary language here, so every field on this form takes its
 * side from what is typed in it. That rule is global now (`input` carries
 * `unicode-bidi: plaintext` in styles/global.ts) — these guard the two things
 * the form itself can still get wrong: pinning a direction of its own, and
 * letting `type="email"` hand the empty field to the UA's LTR default.
 */
describe('BetterAuthSignUpForm RTL field alignment', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'BetterAuthSignUpForm.tsx'),
    'utf8',
  );

  it('does not put type=email on the email Input (keeps inputMode + rule validation)', () => {
    expect(source).toContain('inputMode="email"');
    expect(source).toContain("type: 'email'");
    expect(source).not.toMatch(/<Input[\s\S]*?type=["']email["']/);
  });

  it('pins no direction of its own, so each field follows its own text', () => {
    // A hardcoded direction here beats the global rule and sends one language to
    // the wrong edge: an English name stuck on the right, or a Persian address
    // snapped left on the first character typed.
    expect(source).not.toMatch(/direction:\s*(rtl|ltr)/);
    expect(source).not.toMatch(/unicode-bidi/);
  });

  it('keeps name inputs from clipping Persian labels in half-width columns', () => {
    expect(source).toContain('min-width: 0');
    expect(source).toMatch(/\.ant-form-item-label\s*\{[\s\S]*?text-align:\s*start/);
    expect(source).toMatch(/\.ant-form-item-label > label\s*\{[\s\S]*?width:\s*100%/);
  });

  it('uses one primary label color and does not show Optional on field titles', () => {
    expect(source).toContain('color: ${cssVar.colorText}');
    expect(source).not.toContain('colorTextSecondary');
    expect(source).not.toContain('betterAuth.signup.optional');
  });
});
