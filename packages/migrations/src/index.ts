import { accountsMigrations } from '@job-portal/accounts';
import { aiMigrations } from '@job-portal/ai';
import type { ModuleMigrations } from '@job-portal/db';
import { boardsMigrations } from '@job-portal/boards';
import { discoveryMigrations } from '@job-portal/discovery';
import { matchingMigrations } from '@job-portal/matching';
import { pipelineMigrations } from '@job-portal/pipeline';
import { trackerMigrations } from '@job-portal/tracker';

/** Every module's migrations, in the order a process applies them. Add a new module here. */
export const allMigrations: ModuleMigrations[] = [
  accountsMigrations,
  aiMigrations,
  discoveryMigrations,
  boardsMigrations,
  matchingMigrations,
  pipelineMigrations,
  trackerMigrations,
];
