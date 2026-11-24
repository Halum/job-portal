import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './discovery';
export * from './source';
export * from './sources/bundesagentur';

export const discoveryMigrations: ModuleMigrations = {
  name: 'discovery',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
