import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Plugin } from 'vite';
import { describe, expect, it } from 'vitest';

import { __testing, lobeUiImports } from './lobeUiImports';

const ENTRY_ID = '\0lobe-ui-imports-fixture.mjs';

const fixturePlugin: Plugin = {
  name: 'lobe-ui-imports-fixture',
  load(id) {
    if (id !== ENTRY_ID) return;

    return `
      import { Button, DropdownMenuPortal, createModal, toast } from '@lobehub/ui';
      import { containsScript as htmlPreviewContainsScript } from '@lobehub/ui';
      globalThis.__lobeUiProbe = { Button, DropdownMenuPortal, createModal, htmlPreviewContainsScript, toast };
    `;
  },
  resolveId(id) {
    if (id === 'virtual:lobe-ui-imports-fixture') return ENTRY_ID;
  },
};

describe('lobeUiImports', () => {
  // Regression test: the member map once rewrote named-only base-ui atoms
  // exports (e.g. DropdownMenuPortal) to default imports, which broke the
  // production build with "[MISSING_EXPORT] default is not exported".
  // Resolving the real modules forces rolldown to verify every export.
  it('rewrites barrel imports to deep imports that actually exist', async () => {
    const result = await build({
      build: {
        minify: false,
        rolldownOptions: {
          input: 'virtual:lobe-ui-imports-fixture',
        },
        write: false,
      },
      configFile: false,
      logLevel: 'silent',
      plugins: [fixturePlugin, ...lobeUiImports()],
      root: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    });

    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs
      .flatMap((r) => ('output' in r ? r.output : []))
      .filter((item) => item.type === 'chunk')
      .map((item) => item.code)
      .join('\n');

    // The build itself is the assertion: rolldown resolves every rewritten
    // deep path and verifies the export exists (a wrong default/named kind
    // fails with MISSING_EXPORT instead of producing output).
    expect(code).not.toMatch(/from ["']@lobehub\/ui["']/);
    expect(code).toContain('DropdownMenuPortal');
    expect(code).toContain('htmlPreviewContainsScript');
  });

  // Guard for @lobehub/ui upgrades: every barrel export (except the
  // external ErrorBoundary re-export) must be mapped with the correct
  // default/named kind and deep path.
  it('covers every barrel export with the correct import kind', () => {
    const barrel = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../node_modules/@lobehub/ui/es/index.mjs',
      ),
      'utf8',
    );

    const locals = new Map<string, { from: string; isDefault: boolean }>();
    // Barrel imports are single-line; parse them with string ops (no regex).
    for (const line of barrel.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('import ') || !trimmed.includes(' from ')) continue;
      const fromIndex = trimmed.lastIndexOf(' from ');
      const clause = trimmed.slice('import '.length, fromIndex);
      const from = trimmed
        .slice(fromIndex + ' from '.length, -1)
        .replaceAll(/^['"]|['"];?$/g, '')
        .replace(/^\.\//, '@lobehub/ui/es/')
        .replace(/\.mjs$/, '');
      const path = from;
      const namedStart = clause.indexOf('{');
      const namedEnd = clause.indexOf('}');
      if (namedStart !== -1 && namedEnd > namedStart) {
        for (const n of clause
          .slice(namedStart + 1, namedEnd)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          const asIndex = n.indexOf(' as ');
          if (asIndex === -1) locals.set(n, { from: path, isDefault: false });
          else {
            const orig = n.slice(0, asIndex);
            locals.set(n.slice(asIndex + 4), { from: path, isDefault: orig === 'default' });
          }
        }
      }
      const def = (
        namedStart === -1 ? clause : clause.slice(0, namedStart) + clause.slice(namedEnd + 1)
      )
        .replace(/,$/, '')
        .trim();
      if (def) {
        for (const d of def
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean))
          locals.set(d, { from: path, isDefault: true });
      }
    }

    const mapped = new Map<string, { from: string; kind: string; orig: string }>();
    for (const [alias, from] of __testing.defaultMembers)
      mapped.set(alias, { from, kind: 'default', orig: alias });
    for (const [alias, from] of __testing.sameNameMembers)
      mapped.set(alias, { from, kind: 'named', orig: alias });
    for (const [alias, from, orig] of __testing.aliasedMembers)
      mapped.set(alias, { from, kind: 'alias', orig });

    const exportBlock = barrel.match(/export\s*\{([^}]+)\}/)[1];
    const problems: Array<string> = [];
    for (const part of exportBlock
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const am = part.match(/^(\S+)\s+as\s+(\S+)$/);
      const [local, alias] = am ? [am[1], am[2]] : [part, part];
      // Deliberately unmapped: re-exported from an external package.
      if (alias === 'ErrorBoundary') continue;
      const info = locals.get(local);
      const entry = mapped.get(alias);
      if (!entry) problems.push(`missing: ${alias}`);
      else if (entry.from !== info.from) problems.push(`wrong path: ${alias}`);
      else if (info.isDefault && entry.kind !== 'default')
        problems.push(`should be default: ${alias}`);
      else if (!info.isDefault && entry.kind === 'default')
        problems.push(`should be named: ${alias}`);
      else if (!info.isDefault && entry.orig !== local) problems.push(`wrong orig: ${alias}`);
    }

    expect(problems).toEqual([]);
  });
});
