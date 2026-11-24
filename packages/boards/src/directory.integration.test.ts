import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { boardsMigrations, createBoardDirectory, markBoards, type BoardDirectory } from './index';

describe('board directory against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let directory: BoardDirectory;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [boardsMigrations]);
    handle = createDb(container.getConnectionUri());
    directory = createBoardDirectory(handle.db);
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const entries = [
    { ats: 'greenhouse', token: 'alpha', name: 'Alpha' },
    { ats: 'greenhouse', token: 'beta', name: 'Beta' },
    { ats: 'lever', token: 'alpha', name: 'Alpha Lever', host: 'eu' },
  ];

  it('imports idempotently: a second import adds nothing and changes nothing', async () => {
    expect(await directory.importBoards(entries)).toBe(3);
    await directory.mark('greenhouse', ['alpha']);
    expect(
      await directory.importBoards([...entries, { ats: 'ashby', token: 'gamma', name: 'Gamma' }]),
    ).toBe(1);
    expect(await directory.importBoards(entries)).toBe(0);
    // the existing mark and the existing name survive a re-import with other values
    await directory.importBoards([{ ats: 'greenhouse', token: 'alpha', name: 'Renamed' }]);
    expect(await directory.listMarked('greenhouse')).toEqual([
      { ats: 'greenhouse', token: 'alpha', name: 'Alpha', host: null, marked: true },
    ]);
  });

  it('lists marked and unmarked boards of one ATS, and keeps the Lever host', async () => {
    expect((await directory.listUnmarked('greenhouse')).map((b) => b.token)).toEqual(['beta']);
    expect(await directory.listMarked('lever')).toEqual([]);
    expect((await directory.listUnmarked('lever'))[0]).toMatchObject({
      token: 'alpha',
      host: 'eu',
    });
  });

  it('the mark script is re-runnable and writes only the mark', async () => {
    const fetchLocations = (token: string): Promise<string[]> =>
      Promise.resolve([token === 'beta' ? 'Berlin' : 'Austin']);
    const first = await markBoards(directory, 'greenhouse', (b) => fetchLocations(b.token));
    expect(first).toEqual({ checked: 1, marked: 1, failed: [] });
    const second = await markBoards(directory, 'greenhouse', (b) => fetchLocations(b.token));
    expect(second).toEqual({ checked: 0, marked: 0, failed: [] }); // marked boards are not checked again
    expect((await directory.listMarked('greenhouse')).map((b) => [b.token, b.name])).toEqual([
      ['alpha', 'Alpha'],
      ['beta', 'Beta'],
    ]);
  });
});
