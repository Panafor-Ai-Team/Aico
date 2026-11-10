/**
 * The books check threads a balance chain through ledger rows that share one
 * instant (a renewal writes its refunds and its debits in one transaction).
 * A weekly renewal takes the balance UP through the refunds and then DOWN
 * through the debits, so the same balance appears twice in the chain and the
 * way through it is ambiguous.
 *
 * Synthetic data with the shape of a real 7-member weekly renewal (micro-USD).
 * Ids are chosen so the old greedy order meets the repeated balance and takes
 * the downward branch first.
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { orderChain } from './reconciliation';

interface Row {
  amountMicroUsd: number | null;
  balanceAfterMicroUsd: number;
  balanceBeforeMicroUsd: number;
  createdAt: Date;
  id: string;
}

const row = (id: string, before: number, after: number, when: string): Row => ({
  amountMicroUsd: after - before,
  balanceAfterMicroUsd: after,
  balanceBeforeMicroUsd: before,
  createdAt: new Date(when),
  id,
});

const T = '2026-01-12T00:00:04.000Z';
/** Refunds first (the balance climbs 1.0 → 15.5) ... */
const refunds = [
  row('refund-1', 1_000_000, 3_500_000, T),
  row('refund-2', 3_500_000, 6_000_000, T),
  row('refund-3', 6_000_000, 6_125_000, T),
  row('refund-4', 6_125_000, 8_400_000, T),
  row('refund-5', 8_400_000, 10_900_000, T),
  row('refund-6', 10_900_000, 13_200_000, T),
  row('refund-7', 13_200_000, 15_700_000, T),
];
/** ... then the debits (it falls back through 13.2 to 0.575). */
const debits = [
  row('debit-1', 15_700_000, 13_200_000, T),
  row('debit-2', 13_200_000, 10_700_000, T),
  row('debit-3', 10_700_000, 10_575_000, T),
  row('debit-4', 10_575_000, 8_075_000, T),
  row('debit-5', 8_075_000, 5_575_000, T),
  row('debit-6', 5_575_000, 3_075_000, T),
  row('debit-7', 3_075_000, 575_000, T),
];
const earlier = row('earlier', 200_000, 1_000_000, '2026-01-10T12:00:00.000Z');

const breaks = (rows: Row[]) =>
  rows.flatMap((r, i) =>
    i > 0 && rows[i - 1].balanceAfterMicroUsd !== r.balanceBeforeMicroUsd ? [r.id] : [],
  );

describe('orderChain: a renewal that goes up through refunds and back down through debits', () => {
  it('threads the whole transaction and ends at the real balance', () => {
    const ordered = orderChain([earlier, ...refunds, ...debits]);

    expect(ordered).toHaveLength(15);
    expect(breaks(ordered)).toEqual([]);
    // The wallet really holds the end of the chain after this renewal.
    expect(ordered.at(-1)?.balanceAfterMicroUsd).toBe(575_000);
  });

  it('does not depend on the order the rows arrive in', () => {
    const shuffled = [...debits, earlier, ...refunds].reverse();

    const ordered = orderChain(shuffled);

    expect(breaks(ordered)).toEqual([]);
    expect(ordered.at(-1)?.balanceAfterMicroUsd).toBe(575_000);
  });

  it('still reports a genuinely missing row as a break', () => {
    const withoutOne = debits.filter((d) => d.id !== 'debit-5');

    const ordered = orderChain([earlier, ...refunds, ...withoutOne]);

    expect(breaks(ordered).length).toBeGreaterThan(0);
  });

  it('keeps the plain one-after-another case working', () => {
    const a = row('a', 0, 10, '2026-01-01T00:00:00.000Z');
    const b = row('b', 10, 4, '2026-01-02T00:00:00.000Z');

    expect(orderChain([b, a]).map((r) => r.id)).toEqual(['a', 'b']);
  });
});
