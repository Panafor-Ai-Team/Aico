export type UserMemoryEffort = 'high' | 'low' | 'medium';

export interface UserMemorySettings {
  /** Opt-in background extraction from past conversations; billed to the user. */
  autoExtract?: boolean;
  effort?: UserMemoryEffort;
  enabled?: boolean;
}
