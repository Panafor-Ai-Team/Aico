import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regression: Persian (RTL) must not double-mirror Switch thumbs or place
 * Tabs/Segmented sliding backgrounds with logical inset against physical offsets.
 */
describe('global RTL control fixes', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'global.ts'),
    'utf8',
  );

  it('keeps switches LTR under dir=rtl', () => {
    expect(source).toContain("html[dir='rtl'] [role='switch']");
    expect(source).toContain(":dir(rtl) [role='switch']");
    expect(source).toContain('--switch-dir: 1');
    expect(source).toContain('direction: ltr');
  });

  it('feeds Tabs indicators the right-edge offset under RTL', () => {
    expect(source).toContain(":dir(rtl) [role='tablist'] > [role='presentation']");
    expect(source).toContain("html[dir='rtl'] [role='tablist'] > [role='presentation']");
    // Must override the inline-styled var, hence !important.
    expect(source).toContain('--active-tab-left: var(--active-tab-right) !important;');
  });

  it('mirrors Segmented indicators against the list padding box under RTL', () => {
    expect(source).toContain(
      "html[dir='rtl'] [data-orientation='horizontal'] > [aria-hidden='true']:first-of-type",
    );
    expect(source).toContain(
      'inset-inline-start: calc(100% - var(--active-item-left) - var(--active-item-width));',
    );
  });

  it('does not rely on approaches that cannot work for absolutely positioned indicators', () => {
    // `direction: ltr` on the indicator itself is ignored: logical insets map
    // through the containing block's direction.
    expect(source).not.toMatch(
      /\[role='tablist'\] > \[role='presentation'\][\s\S]*?direction:\s*ltr/,
    );
    // inset-inline: auto wiped the physical left offset under RTL.
    expect(source).not.toContain('inset-inline: auto');
  });
});
