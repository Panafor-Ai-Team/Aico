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

  it('mirrors every lucide panel icon under RTL by its svg class', () => {
    // One global rule covers every PanelLeft*/PanelRight* (and Sidebar* alias)
    // use site, so new panel toggles cannot regress to LTR arrows.
    expect(source).toContain("svg[class*='lucide-panel-left']:dir(rtl)");
    expect(source).toContain("svg[class*='lucide-panel-right']:dir(rtl)");
    expect(source).toMatch(/lucide-panel-right'\]:dir\(rtl\)\s*\{\s*transform:\s*scaleX\(-1\);/);
  });

  it('mirrors horizontal lucide arrows under RTL, except physical keys in <kbd>', () => {
    // Regression: the document portal "back" ArrowLeft pointed into the content
    // in Persian. One global rule covers every ArrowLeft/Right-family use site.
    const rule = /svg:is\(([\s\S]*?)\):dir\(rtl\):not\(kbd \*\)\s*\{\s*scale:\s*-1 1;\s*\}/.exec(
      source,
    );
    expect(rule).not.toBeNull();
    for (const icon of ['arrow-left', 'arrow-right', 'circle-arrow-right', 'arrow-big-left']) {
      expect(rule![1]).toContain(`[class*='lucide-${icon}']`);
    }
    // `scale`, not `transform`, so a use site's own rotate() still composes.
    expect(rule![0]).not.toContain('transform');
    // Chevrons are excluded on purpose (RTL-aware placement / rotated disclosures).
    expect(rule![1]).not.toContain('chevron');
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
