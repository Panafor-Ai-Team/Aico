import { describe, expect, it } from 'vitest';

import pluginLocale from '@/locales/default/plugin';

import { getActivateToolsDisplay } from './display';

/** i18next stand-in backed by the real default `plugin` namespace. */
const t = (key: string, options: { defaultValue: string }) =>
  (pluginLocale as Record<string, string>)[key] ?? options.defaultValue;

const LEAK = /lobe|openrouter|cheapvibecode|\bcvc\b/i;

const allLabels = (display: ReturnType<typeof getActivateToolsDisplay>) => [
  ...display.notFoundNames,
  ...display.requestedTools.map((tool) => tool.name),
  ...display.visibleTools.map((tool) => tool.name),
];

describe('getActivateToolsDisplay', () => {
  it('names lobe-skill-store "Skill Store" while the call awaits approval', () => {
    const display = getActivateToolsDisplay(['lobe-skill-store'], undefined, t);

    expect(display.requestedTools).toEqual([
      { identifier: 'lobe-skill-store', name: 'Skill Store' },
    ]);
    expect(display.visibleTools).toEqual(display.requestedTools);
  });

  it('localizes activated tools persisted with a raw identifier as their name', () => {
    const display = getActivateToolsDisplay(
      ['lobe-skill-store', 'lobe-ghost'],
      {
        activatedTools: [
          { apiCount: 3, avatar: '🛒', identifier: 'lobe-skill-store', name: 'lobe-skill-store' },
        ],
        notFound: ['lobe-ghost'],
      },
      t,
    );

    expect(display.visibleTools).toEqual([
      { avatar: '🛒', identifier: 'lobe-skill-store', name: 'Skill Store' },
    ]);
    expect(display.notFoundNames).toEqual(['ghost']);
    expect(allLabels(display).join(' ')).not.toMatch(LEAK);
  });

  it('keeps titles of non-builtin tools', () => {
    const display = getActivateToolsDisplay(
      ['github'],
      { activatedTools: [{ apiCount: 1, identifier: 'github', name: 'GitHub' }] },
      t,
    );

    expect(display.visibleTools.map((tool) => tool.name)).toEqual(['GitHub']);
  });
});
