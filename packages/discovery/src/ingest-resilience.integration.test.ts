import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createLogger } from '@job-portal/shared';
import {
  createBambaseSource,
  createBundesagenturSource,
  createDiscovery,
  discoveryMigrations,
  type Source,
} from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const fixture = (name: string): string =>
  readFileSync(new URL(`./sources/fixtures/${name}`, import.meta.url), 'utf8');
const serve =
  (body: string): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status: 200 }));

describe('ingest resilience against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [discoveryMigrations]);
    handle = createDb(container.getConnectionUri());
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('merges one job seen on Bundesagentur and on bambase, each written the way its source writes it', async () => {
    const bundesagentur = createBundesagenturSource({
      query: 'wo=Musterstadt',
      fetch: serve(fixture('bundesagentur-search.json')),
    });
    const realBambase = createBambaseSource({
      fetch: serve(fixture('bambase-jobs.html')),
      now: () => new Date('2026-07-10'),
    });
    // The recorded fixtures are scrubbed placeholders, so no listing of one is the same job as a
    // listing of the other. Take the real first bambase listing (its id, url and payload) and give
    // it the identity of the Bundesagentur "Koch" job in bambase's style: no bracket around the
    // gender marker, a legal suffix, and the postcode in front of the city.
    const bambase: Source = {
      id: 'bambase',
      fetch: async () => {
        const { postings, errors } = await realBambase.fetch();
        const first = postings[0];
        if (!first) throw new Error('bambase fixture has no listing');
        return {
          postings: [
            {
              ...first,
              title: 'Koch m/w/d',
              company: 'Beispiel Firma B GmbH',
              location: '12345 Musterstadt',
            },
          ],
          errors,
        };
      },
    };
    const d = createDiscovery(handle.db, [bundesagentur, bambase]);
    await d.poll(USER, 'bundesagentur');
    await d.poll(USER, 'bambase');

    const { jobs } = await d.listJobs(USER, {});
    const koch = jobs.filter((j) => j.postings.some((p) => p.title === 'Koch (m/w/d)'));
    expect(koch).toHaveLength(1);
    expect(koch[0]?.postings.map((p) => p.sourceId).sort()).toEqual(['bambase', 'bundesagentur']);
    expect(jobs).toHaveLength(5); // five Bundesagentur jobs, the bambase one merged into one of them
  });

  it('one Posting that cannot be stored is an error line and the rest of the poll goes on', async () => {
    const nul = String.fromCharCode(0); // Postgres text cannot hold a NUL byte
    const posting = (id: string, title: string) => ({
      sourcePostingId: id,
      title,
      company: 'Beispiel GmbH',
      location: 'Musterstadt',
      url: `https://jobs.example.invalid/${id}`,
      raw: { id },
    });
    const source: Source = {
      id: 'odd',
      fetch: () =>
        Promise.resolve({
          postings: [posting('1', 'Koch'), posting('2', `Bad${nul}title`), posting('3', 'Kellner')],
          errors: ['source note'],
        }),
    };
    const lines: string[] = [];
    const logger = createLogger({ destination: { write: (l) => lines.push(l) } });
    const d = createDiscovery(handle.db, [source], logger);
    const result = await d.poll(USER, 'odd');
    expect(result).toMatchObject({ fetched: 3, newPostings: 2 });
    expect(result.errors).toEqual(['source note', 'posting 2 could not be stored']);
    const titles = (await d.listJobs(USER, {})).jobs.flatMap((j) => j.postings.map((p) => p.title));
    expect(titles).toEqual(expect.arrayContaining(['Koch', 'Kellner']));
    // The stored line stays short; the cause goes to the log.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"sourcePostingId":"2"');
    expect(lines[0]).toContain('posting not stored');
  });

  it('a lost database connection fails the poll instead of becoming an error line', async () => {
    const lost = createDb(container.getConnectionUri());
    await lost.close();
    const source: Source = {
      id: 'lost',
      fetch: () =>
        Promise.resolve({
          postings: [
            {
              sourcePostingId: '1',
              title: 'Koch',
              company: 'Beispiel GmbH',
              location: 'Musterstadt',
              url: 'https://jobs.example.invalid/1',
              raw: {},
            },
          ],
          errors: [],
        }),
    };
    await expect(createDiscovery(lost.db, [source]).poll(USER, 'lost')).rejects.toThrow();
  });
});
