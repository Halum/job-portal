import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { accountsMigrations, createAccounts } from './index';

const TOKEN = 'placeholder-token-for-tests';

describe('accounts against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = container.getConnectionUri();
    // Two processes starting together must not race: both calls succeed.
    await Promise.all([
      runMigrationsWithLock(url, [accountsMigrations]),
      runMigrationsWithLock(url, [accountsMigrations]),
    ]);
    handle = createDb(url);
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('seeds one user with the Berlin timezone, and seeding again keeps it one', async () => {
    const accounts = createAccounts(handle.db, TOKEN);
    const first = await accounts.seedUser('user@example.invalid');
    const second = await accounts.seedUser('user@example.invalid');
    expect(first).toMatchObject({ email: 'user@example.invalid', timezone: 'Europe/Berlin' });
    expect(second.id).toBe(first.id);
  });

  it('authenticates only the right bearer token', async () => {
    const accounts = createAccounts(handle.db, TOKEN);
    const user = await accounts.seedUser('user@example.invalid');
    expect(await accounts.authenticate(`Bearer ${TOKEN}`)).toEqual(user);
    expect(await accounts.authenticate('Bearer wrong-token-value')).toBeNull();
    expect(await accounts.authenticate(undefined)).toBeNull();
  });
});
