import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './discovery';
export * from './ai-merge';
export { DISCOVERY_STATES } from './schema';
export * from './source';
export * from './sources/bambase';
export * from './sources/bundesagentur';
export * from './sources/ats';
export * from './sources/jsearch';
export * from './sources/board-url';
export * from './rate-limit';
export * from './site-job';
export { createRequestLog, type LoggedRequest } from './request-log';

export const discoveryMigrations: ModuleMigrations = {
  name: 'discovery',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
