import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './pipeline';
export { RUN_STATUSES, type RunStatus } from './schema';

export const pipelineMigrations: ModuleMigrations = {
  name: 'pipeline',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
