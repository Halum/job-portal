import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './directory';
export * from './mark';
export * from './watchlist';
export * from './data';

export const boardsMigrations: ModuleMigrations = {
  name: 'boards',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
