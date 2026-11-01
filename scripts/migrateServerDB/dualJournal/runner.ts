// Typed facade over `../dualJournalRunner.cjs`, the single implementation (plain CommonJS so
// the Docker image can run it beside `docker.cjs`). See that file for the semantics.
// @ts-ignore tsgo handle esm import cjs and compatibility issues
import * as impl from '../dualJournalRunner.cjs';

export interface MigrationEntry {
  hash: string;
  statements: string[];
  tag: string;
  when: number;
}

export interface MigrationTrack {
  entries: MigrationEntry[];
  name: string;
}

/** Single-connection executor; transactions are issued as plain BEGIN / COMMIT. */
export interface MigrationExecutor {
  exec: (sql: string) => Promise<void>;
  query: <T = Record<string, any>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface LedgerRowSnapshot {
  createdAt: number;
  hash: string;
  id: number;
}

export interface DualJournalReport {
  applied: string[];
  /** Applied earlier (matched by `when`) but the file changed since; never re-run. */
  drift: Array<{ appliedHash: string; currentHash: string; tag: string }>;
  /** Satisfied by an equivalent entry already applied from the other track. */
  equivalent: string[];
  /** Recorded as applied without executing (e.g. pg_search unavailable). */
  skipped: string[];
  /** Ledger rows matching no entry of any track. */
  unknownRows: LedgerRowSnapshot[];
}

export interface RunDualJournalOptions {
  /** Tag → `when` of an entry (in any track) whose ledger row also satisfies this tag. */
  equivalences?: Record<string, number>;
  executor: MigrationExecutor;
  lockKey?: number;
  /** Record without executing, e.g. pg_search/BM25 statements where unavailable. */
  skip?: (entry: MigrationEntry) => boolean;
  tracks: MigrationTrack[];
}

export interface DualJournalMigrationError extends Error {
  report: DualJournalReport;
  tag: string;
}

export const DualJournalMigrationError: new (
  tag: string,
  report: DualJournalReport,
  options: { cause: unknown },
) => DualJournalMigrationError = impl.DualJournalMigrationError;

export const readTrack: (name: string, migrationsFolder: string) => MigrationTrack = impl.readTrack;

export const readLedger: (executor: MigrationExecutor) => Promise<LedgerRowSnapshot[]> =
  impl.readLedger;

export const runDualJournal: (options: RunDualJournalOptions) => Promise<DualJournalReport> =
  impl.runDualJournal;

/** What drizzle's own migrator would apply: entries newer than the newest `created_at`. */
export const stockDrizzlePending: (track: MigrationTrack, rows: LedgerRowSnapshot[]) => string[] =
  impl.stockDrizzlePending;

export const createPgExecutor: (client: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}) => MigrationExecutor = impl.createPgExecutor;

export const formatReport: (report: DualJournalReport) => string = impl.formatReport;

export interface DualJournalPlan {
  drift: DualJournalReport['drift'];
  equivalent: string[];
  pending: MigrationEntry[];
  unknownRows: LedgerRowSnapshot[];
}

/** What `runDualJournal` would do against these ledger rows; touches no database. */
export const planDualJournal: (options: {
  equivalences?: Record<string, number>;
  rows: LedgerRowSnapshot[];
  tracks: MigrationTrack[];
}) => DualJournalPlan = impl.planDualJournal;

export const formatPlan: (plan: DualJournalPlan) => string = impl.formatPlan;
