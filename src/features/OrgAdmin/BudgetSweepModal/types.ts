/**
 * Wire shapes for the org budget sweep, shared by the org-manager panel and the
 * control plane. Money arrives as strings (micro-USD exceeds Number precision);
 * `*Usd` fields are the display decimals.
 */

export type SweepEstimateSource = 'openrouter' | 'wallet-only' | 'wallet-fallback';

export type SweepSkipReason = 'no-budget' | 'already-settled';

export interface SweepPreviewRow {
  email: string | null;
  estimateSource: SweepEstimateSource;
  memberId: string;
  pendingPeriodAmountUsd: string;
  period: string;
  periodAmountUsd: string;
  publicCode: string | null;
  reclaimUsd: string;
  settledUsageUsd: string;
  skipReason?: SweepSkipReason;
  username: string | null;
}

export interface SweepPreview {
  currentOrgBalanceUsd: string;
  memberCount: number;
  orgId: string;
  orgName: string;
  projectedOrgBalanceUsd: string;
  rows: SweepPreviewRow[];
  skippedCount: number;
  totalReclaimUsd: string;
}

export interface SweepResultRow {
  email: string | null;
  error?: string;
  memberId: string;
  publicCode: string | null;
  reclaimedUsd: string;
  status: 'reclaimed' | 'skipped' | 'deferred';
  username: string | null;
}

export interface SweepResult {
  batchId: string;
  deferredCount: number;
  orgBalanceUsd: string;
  reclaimedCount: number;
  rows: SweepResultRow[];
  skippedCount: number;
  totalReclaimedUsd: string;
}
