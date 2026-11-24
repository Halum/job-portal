import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import {
  BoardsError,
  boardsMigrations,
  createBoardDirectory,
  createWatchlist,
  type BoardDirectory,
  type Watchlist,
} from './index';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

describe('watchlist against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let directory: BoardDirectory;
  let watchlist: Watchlist;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [boardsMigrations]);
    handle = createDb(container.getConnectionUri());
    directory = createBoardDirectory(handle.db);
    watchlist = createWatchlist(handle.db);
    await directory.importBoards([
      { ats: 'greenhouse', token: 'alpha', name: 'Alpha' },
      { ats: 'greenhouse', token: 'beta', name: 'Beta' },
      { ats: 'lever', token: 'gamma', name: 'Gamma', host: 'eu' },
      { ats: 'ashby', token: 'delta', name: 'Delta' },
    ]);
    await directory.mark('greenhouse', ['alpha', 'beta']);
    await directory.mark('lever', ['gamma']);
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const tokens = async (userId: string, ats: string): Promise<string[]> =>
    (await watchlist.listBoards(userId, ats)).map((b) => b.token);

  it('an empty Watchlist means every marked board, and never an unmarked one', async () => {
    expect(await watchlist.list(ME)).toEqual([]);
    expect(await tokens(ME, 'greenhouse')).toEqual(['alpha', 'beta']);
    expect(await tokens(ME, 'lever')).toEqual(['gamma']);
    expect(await tokens(ME, 'ashby')).toEqual([]); // delta is not marked
  });

  it('a non-empty Watchlist narrows every ATS to the watched boards', async () => {
    await watchlist.add(ME, [{ ats: 'greenhouse', token: 'beta' }]);
    expect(await watchlist.list(ME)).toEqual([{ ats: 'greenhouse', token: 'beta' }]);
    expect(await tokens(ME, 'greenhouse')).toEqual(['beta']);
    expect(await tokens(ME, 'lever')).toEqual([]); // watching something elsewhere excludes the rest
  });

  it('a watched board that is not marked is still not fetched', async () => {
    await watchlist.add(ME, [{ ats: 'ashby', token: 'delta' }]);
    expect(await tokens(ME, 'ashby')).toEqual([]);
    await watchlist.remove(ME, [{ ats: 'ashby', token: 'delta' }]);
  });

  it('is per user: another user keeps the full marked list', async () => {
    expect(await watchlist.list(OTHER)).toEqual([]);
    expect(await tokens(OTHER, 'greenhouse')).toEqual(['alpha', 'beta']);
  });

  it('adding is idempotent, keeps the Lever host, and removing the last board widens it again', async () => {
    await watchlist.add(ME, [
      { ats: 'greenhouse', token: 'beta' },
      { ats: 'lever', token: 'gamma' },
    ]);
    expect((await watchlist.list(ME)).map((b) => b.token)).toEqual(['beta', 'gamma']);
    expect((await watchlist.listBoards(ME, 'lever'))[0]).toMatchObject({ host: 'eu' });
    await watchlist.remove(ME, [
      { ats: 'greenhouse', token: 'beta' },
      { ats: 'lever', token: 'gamma' },
      { ats: 'lever', token: 'not-there' },
    ]);
    expect(await watchlist.list(ME)).toEqual([]);
    expect(await tokens(ME, 'greenhouse')).toEqual(['alpha', 'beta']);
  });

  it('refuses a board that is not in the directory and changes nothing', async () => {
    await expect(
      watchlist.add(ME, [
        { ats: 'greenhouse', token: 'alpha' },
        { ats: 'greenhouse', token: 'nope' },
      ]),
    ).rejects.toThrow(BoardsError);
    await expect(watchlist.add(ME, [{ ats: 'greenhouse', token: 'nope' }])).rejects.toThrow(
      /not in the Board directory: greenhouse\/nope/,
    );
    expect(await watchlist.list(ME)).toEqual([]);
  });

  it('addMarked puts a new board in the directory marked, and marks a listed one without renaming it', async () => {
    expect(
      await directory.addMarked({ ats: 'ashby', token: 'newco', name: 'newco' }),
    ).toMatchObject({
      token: 'newco',
      marked: true,
    });
    expect(
      await directory.addMarked({ ats: 'ashby', token: 'delta', name: 'Renamed' }),
    ).toMatchObject({
      name: 'Delta',
      marked: true,
    });
    expect((await directory.listMarked('ashby')).map((b) => b.token)).toEqual(['delta', 'newco']);
  });

  it('addMarked updates the host of a listed board (Lever EU versus US) but not its name', async () => {
    await directory.importBoards([{ ats: 'lever', token: 'moved', name: 'Moved' }]);
    expect(
      await directory.addMarked({ ats: 'lever', token: 'moved', name: 'Other', host: 'eu' }),
    ).toMatchObject({ name: 'Moved', host: 'eu', marked: true });
    expect(
      await directory.addMarked({ ats: 'lever', token: 'moved', name: 'Other' }),
    ).toMatchObject({ name: 'Moved', host: null });
  });

  describe('addMarkedBoard: the directory row and the watch in one transaction', () => {
    const NEW = '00000000-0000-4000-8000-000000000003';

    it('adds the board marked, watches it, and says the Watchlist was empty only the first time', async () => {
      const first = await watchlist.addMarkedBoard(NEW, {
        ats: 'ashby',
        token: 'txfirst',
        name: 'txfirst',
      });
      expect(first).toMatchObject({ wasEmpty: true, board: { token: 'txfirst', marked: true } });
      const second = await watchlist.addMarkedBoard(NEW, {
        ats: 'ashby',
        token: 'txsecond',
        name: 'txsecond',
      });
      expect(second.wasEmpty).toBe(false);
      expect(await watchlist.list(NEW)).toEqual([
        { ats: 'ashby', token: 'txfirst' },
        { ats: 'ashby', token: 'txsecond' },
      ]);
    });

    it('rolls the directory row back when the watch cannot be written', async () => {
      await expect(
        watchlist.addMarkedBoard('not-a-uuid', { ats: 'ashby', token: 'txghost', name: 'txghost' }),
      ).rejects.toThrow();
      expect((await directory.listMarked('ashby')).map((b) => b.token)).not.toContain('txghost');
    });
  });
});
