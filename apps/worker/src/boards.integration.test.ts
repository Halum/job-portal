import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createBoardDirectory, type BoardDirectory } from '@job-portal/boards';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createAtsSource, createDiscovery, type Discovery } from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline, type Pipeline } from '@job-portal/pipeline';

const USER = '00000000-0000-4000-8000-000000000001';
const greenhouseBoard = readFileSync(
  new URL(
    '../../../packages/discovery/src/sources/fixtures/greenhouse-board.json',
    import.meta.url,
  ),
  'utf8',
);

describe('company board runs against real Postgres', () => {
  let pg: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let directory: BoardDirectory;
  let discovery: Discovery;
  let pipeline: Pipeline;
  const requested: string[] = [];

  // Recorded response for the good board; the stale board answers 404. Nothing reaches the network.
  const fakeFetch: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    return Promise.resolve(
      url.includes('/goodboard/')
        ? new Response(greenhouseBoard, { status: 200 })
        : new Response('not found', { status: 404 }),
    );
  };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(pg.getConnectionUri(), allMigrations);
    handle = createDb(pg.getConnectionUri());
    directory = createBoardDirectory(handle.db);
    await directory.importBoards([
      { ats: 'greenhouse', token: 'goodboard', name: 'Good Board' },
      { ats: 'greenhouse', token: 'staleboard', name: 'Stale Board' },
      { ats: 'greenhouse', token: 'unmarkedboard', name: 'Unmarked Board' },
    ]);
    await directory.mark('greenhouse', ['goodboard', 'staleboard']);
    discovery = createDiscovery(handle.db, [
      createAtsSource('greenhouse', {
        listBoards: () => directory.listMarked('greenhouse'),
        fetch: fakeFetch,
      }),
    ]);
    pipeline = createPipeline(handle.db, discovery);
  });

  afterAll(async () => {
    await handle.close();
    await pg.stop();
  });

  it('ends completed with errors, lists the failing board, still stores the other boards, and never fetches an unmarked board', async () => {
    const run = await pipeline.execute(USER, 'greenhouse');

    expect(run).toMatchObject({
      sourceId: 'greenhouse',
      status: 'completed_with_errors',
      fetched: 2,
      newPostings: 2,
      errors: ['greenhouse board staleboard: HTTP 404'],
    });
    expect((await discovery.listJobs(USER, {})).jobs).toHaveLength(2);
    expect(requested.some((u) => u.includes('unmarkedboard'))).toBe(false);
    expect(requested.filter((u) => u.includes('goodboard'))).toHaveLength(1);
  });

  it('a second run of the same source records a second run with the same board error', async () => {
    const run = await pipeline.execute(USER, 'greenhouse');
    expect(run).toMatchObject({ status: 'completed_with_errors', newPostings: 0 });
    expect((await pipeline.listRuns(USER, 10)).map((r) => r.status)).toEqual([
      'completed_with_errors',
      'completed_with_errors',
    ]);
  });
});
