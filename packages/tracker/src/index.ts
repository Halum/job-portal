import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './model';
export * from './tracker';

export const trackerMigrations: ModuleMigrations = {
  name: 'tracker',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
