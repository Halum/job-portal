import { accountsMigrations } from '@job-portal/accounts';
import type { ModuleMigrations } from '@job-portal/db';
import { discoveryMigrations } from '@job-portal/discovery';
import { pipelineMigrations } from '@job-portal/pipeline';

/** Every module's migrations, in the order a process applies them. Add a new module here. */
export const allMigrations: ModuleMigrations[] = [
  accountsMigrations,
  discoveryMigrations,
  pipelineMigrations,
];
