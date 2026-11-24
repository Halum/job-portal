import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './discovery';
export { DISCOVERY_STATES } from './schema';
export * from './source';
export * from './sources/bambase';
export * from './sources/bundesagentur';
export * from './sources/ats';
export * from './sources/board-url';
export * from './rate-limit';

export const discoveryMigrations: ModuleMigrations = {
  name: 'discovery',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
