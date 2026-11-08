import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import defaultResources from './default';

/**
 * D-018: users must never see the upstream project (LobeHub / LobeChat / Lobe)
 * or the inference gateways (CheapVibeCode / CVC, OpenRouter) in UI copy.
 * Brand copy goes through `{{appName}}` / `{{cloudName}}` / `{{supportEmail}}`.
 *
 * Lobe forms are matched case-sensitively so ordinary words survive (German
 * "lobe" = "praise"); keys are not checked because they are code identifiers.
 */
const FORBIDDEN = [
  /Lobe(?:Hub|Chat|AI)?(?![a-z])/,
  /\bLOBE\b/,
  /lobehub\.com/i,
  /cheap[\s_-]?vibe[\s_-]?code/i,
  /open[\s_-]?router/i,
  /\bCVC\b/,
];

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

const findViolations = (namespace: string, values: Record<string, unknown>) =>
  Object.entries(values)
    .filter(([, value]) => typeof value === 'string')
    .filter(([, value]) => FORBIDDEN.some((pattern) => pattern.test(value as string)))
    .map(([key, value]) => `${namespace} ${key}: ${String(value).slice(0, 120)}`);

describe('locale copy has no upstream or gateway names', () => {
  it('default (source) resources', () => {
    const violations = Object.entries(defaultResources).flatMap(([namespace, values]) =>
      findViolations(namespace, values as Record<string, unknown>),
    );

    expect(violations).toEqual([]);
  });

  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('covers every shipped locale', () => {
    expect(localeDirs).toEqual(expect.arrayContaining(['en-US', 'fa-IR', 'fr-FR', 'zh-CN']));
  });

  it.each(localeDirs)('%s', (locale) => {
    const dir = path.join(LOCALES_DIR, locale);
    const violations = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        const values = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
        if (typeof values !== 'object' || values === null || Array.isArray(values)) return [];
        return findViolations(`${locale}/${file}`, values as Record<string, unknown>);
      });

    expect(violations).toEqual([]);
  });
});
