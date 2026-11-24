import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './criteria';
export * from './filters';
export * from './matching';
export { createPlaceTable, germanPlaces, distanceKm, type Place, type PlaceTable } from './places';

export const matchingMigrations: ModuleMigrations = {
  name: 'matching',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
