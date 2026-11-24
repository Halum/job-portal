import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './runner';
export * from './ai';
export { createOpenRouterRunner, type OpenRouterOptions } from './openrouter';
export { createClaudeRunner, type ClaudeOptions } from './claude';

export const aiMigrations: ModuleMigrations = {
  name: 'ai',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
