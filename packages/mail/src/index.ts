import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrations } from '@job-portal/db';

export * from './mail';
export { GmailAuthError, GmailError, createGmailClient, type GmailClient } from './gmail';
export { MAIL_KINDS, type MailKind } from './classify';

export const mailMigrations: ModuleMigrations = {
  name: 'mail',
  folder: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
};
