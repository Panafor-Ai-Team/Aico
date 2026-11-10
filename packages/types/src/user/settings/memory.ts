export type UserMemoryEffort = 'high' | 'low' | 'medium';

export interface UserMemorySettings {
  /** Background extraction from past conversations, billed to the user. On unless set to false. */
  autoExtract?: boolean;
  effort?: UserMemoryEffort;
  enabled?: boolean;
}
