export interface ExpertSkillCatalogEntry {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
}

export interface ExpertSkillCatalogPort {
  list(): Promise<readonly ExpertSkillCatalogEntry[]>;
}

export interface ExpertSkillLoadedContent extends ExpertSkillCatalogEntry {
  readonly digestHex: string;
  readonly content: string;
  readonly files: readonly { path: string; bytes: Uint8Array }[];
  readonly baseDirectory: string;
}

export type ExpertSkillErrorCode = 'INVALID_IDENTITY' | 'RESERVED_IDENTITY' | 'NOT_CACHED' | 'LOAD_FAILED';

export class ExpertSkillError extends Error {
  constructor(readonly code: ExpertSkillErrorCode) {
    super(`Expert skill: ${code}`);
    this.name = 'ExpertSkillError';
  }
}
