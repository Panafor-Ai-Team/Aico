import type { ModelUsage } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { mergeStreamUsage } from './mergeStreamUsage';

describe('mergeStreamUsage', () => {
  it('returns the incoming snapshot when there is no previous one', () => {
    const next: ModelUsage = { totalInputTokens: 1200, totalTokens: 1245 };
    expect(mergeStreamUsage(undefined, next)).toBe(next);
  });

  it('keeps the previous snapshot when the incoming one is empty', () => {
    const previous: ModelUsage = { totalInputTokens: 1200, totalTokens: 1245 };
    expect(mergeStreamUsage(previous, undefined)).toBe(previous);
  });

  it('ignores a trailing zero-total artifact after real usage', () => {
    const previous: ModelUsage = {
      totalInputTokens: 1200,
      totalOutputTokens: 45,
      totalTokens: 1245,
    };

    const merged = mergeStreamUsage(previous, {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    });

    expect(merged?.totalTokens).toBe(1245);
    expect(merged?.totalInputTokens).toBe(1200);
    expect(merged?.totalOutputTokens).toBe(45);
  });

  it('ignores an empty usage object', () => {
    const previous: ModelUsage = { totalTokens: 1245 };
    expect(mergeStreamUsage(previous, {})?.totalTokens).toBe(1245);
  });

  it('merges partial snapshots without dragging known totals down', () => {
    const merged = mergeStreamUsage(
      { totalInputTokens: 1200, totalOutputTokens: 12, totalTokens: 1212 },
      // Partial follow-up: only the revised output count, input omitted.
      { totalOutputTokens: 45, totalTokens: 1245 },
    );

    expect(merged).toMatchObject({
      totalInputTokens: 1200,
      totalOutputTokens: 45,
      totalTokens: 1245,
    });
  });

  it('never revises a token count downward', () => {
    const merged = mergeStreamUsage(
      { totalInputTokens: 1200, totalOutputTokens: 45, totalTokens: 1245 },
      { totalInputTokens: 800, totalOutputTokens: 30, totalTokens: 830 },
    );

    expect(merged).toMatchObject({
      totalInputTokens: 1200,
      totalOutputTokens: 45,
      totalTokens: 1245,
    });
  });

  it('lets a later cost figure replace the earlier one', () => {
    const merged = mergeStreamUsage(
      { cost: 0.5, totalTokens: 1245 },
      { cost: 0.02, totalTokens: 1245 },
    );

    expect(merged?.cost).toBe(0.02);
    expect(merged?.totalTokens).toBe(1245);
  });

  it('keeps the previous cost when the incoming event carries none', () => {
    const merged = mergeStreamUsage({ cost: 0.02, totalTokens: 100 }, { totalTokens: 200 });

    expect(merged?.cost).toBe(0.02);
    expect(merged?.totalTokens).toBe(200);
  });

  it('does not let a zero-total artifact zero out the cost', () => {
    // A trailing tool/result chunk converts to `{ ...zeros, cost: 0 }` —
    // pricing 0 tokens yields a 0 cost, not a missing one. Treating that as a
    // reported figure wiped the real cost and hid the cost chip until the
    // next fetch.
    const merged = mergeStreamUsage(
      { cost: 0.25, totalInputTokens: 1200, totalOutputTokens: 45, totalTokens: 1245 },
      { cost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
    );

    expect(merged?.cost).toBe(0.25);
    expect(merged?.totalTokens).toBe(1245);
  });
});
