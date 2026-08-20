import { get, post } from './apiClient';

export interface MigrationStep {
  id: string;
  title: string;
  essential: boolean;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  error?: string | null;
  ms: number;
  /** Live progress for a slow, explicable step (the first-run git download). Cleared when it settles. */
  detail?: string | null;
}

export interface MigrationSnapshot {
  phase: 'running' | 'completed' | 'failed';
  isUpgrade: boolean;
  fromVersion: string;
  toVersion: string;
  steps: MigrationStep[];
  warnings: string[];
  error?: string | null;
}

export const getMigrationStatus = () => get<MigrationSnapshot>('/api/migration/status');
export const retryMigration = () => post('/api/migration/retry');
