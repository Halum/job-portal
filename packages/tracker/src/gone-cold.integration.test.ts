import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, discoveryMigrations, type Discovery } from '@job-portal/discovery';
import { createTracker, TrackerError, trackerMigrations, type Tracker } from './index';

const TZ = 'Europe/Berlin';
const USER = '00000000-0000-4000-8000-000000000011';
const OTHER = '00000000-0000-4000-8000-000000000012';
const N = 14;

describe('gone cold against real Postgres and a controlled clock', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let discovery: Discovery;
  let tracker: Tracker;
  let clock = new Date();
  let n = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [
      discoveryMigrations,
      trackerMigrations,
    ]);
    handle = createDb(container.getConnectionUri());
    discovery = createDiscovery(handle.db, []);
    tracker = createTracker(handle.db, discovery, () => clock);
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const at = (iso: string): void => {
    clock = new Date(iso);
  };
  const newJob = async (user = USER): Promise<string> =>
    (
      await discovery.addJob(user, {
        title: 'Koch',
        url: `https://t.example.invalid/${String(++n)}`,
      })
    ).jobId;
  const status = async (jobId: string, user = USER): Promise<string | null> =>
    (await tracker.getStates(user, [jobId])).get(jobId)?.applicationStatus ?? null;
  const apply = (jobId: string, user = USER) =>
    tracker.setApplicationStatus(user, jobId, { to: 'applied', actor: 'user', timezone: TZ });
  const run = (user = USER, days = N) => tracker.goneCold(user, { days, timezone: TZ });
  const appliedAt = async (iso: string, user = USER): Promise<string> => {
    at(iso);
    const jobId = await newJob(user);
    await apply(jobId, user);
    return jobId;
  };

  it('leaves a Job N days minus one in place and moves it on day N, with the rule as evidence', async () => {
    const jobId = await appliedAt('2026-03-01T10:00:00Z');
    at('2026-03-14T10:00:00Z');
    expect(await run()).toEqual([]);
    expect(await status(jobId)).toBe('applied');

    at('2026-03-15T10:00:00Z');
    expect(await run()).toEqual([{ jobId, daysSilent: 14, from: 'applied' }]);
    expect(await status(jobId)).toBe('gone_cold');
    const { events } = await tracker.getTimeline(USER, jobId);
    expect(events.at(-1)).toMatchObject({ to: 'gone_cold', from: 'applied', actor: 'system' });
    expect(events.at(-1)?.evidence).toContain('14 days');
  });

  it('counts calendar days in the user timezone, whatever the hour', async () => {
    // 23:30 UTC on 1 Nov is already 2 Nov in Berlin: day D is 2 Nov, so it goes cold on 16 Nov Berlin time.
    const late = await appliedAt('2026-11-01T23:30:00Z');
    at('2026-11-15T12:00:00Z');
    expect(await run()).toEqual([]);
    at('2026-11-15T23:30:00Z');
    expect(await run()).toEqual([{ jobId: late, daysSilent: 14, from: 'applied' }]);

    // 23:10 UTC on 31 Oct is 00:10 on 1 Nov in Berlin: it goes cold on 15 Nov, even at 23:50 that evening.
    const early = await appliedAt('2026-10-31T23:10:00Z');
    at('2026-11-15T22:50:00Z');
    expect(await run()).toEqual([{ jobId: early, daysSilent: 14, from: 'applied' }]);
  });

  it('is not reset by notes, but a later status change moves the clock on', async () => {
    const noted = await appliedAt('2026-04-01T10:00:00Z');
    await tracker.addNote(USER, noted, 'called the office');
    const moved = await appliedAt('2026-04-01T10:00:00Z');
    at('2026-04-11T10:00:00Z');
    await tracker.setApplicationStatus(USER, moved, {
      to: 'screening',
      actor: 'gmail',
      timezone: TZ,
    });

    at('2026-04-15T10:00:00Z');
    expect((await run()).map((m) => m.jobId)).toEqual([noted]);
    expect(await status(moved)).toBe('screening');

    at('2026-04-25T10:00:00Z');
    expect(await run()).toEqual([{ jobId: moved, daysSilent: 14, from: 'screening' }]);
  });

  it('is idempotent: a Job already Gone cold is not moved or written again', async () => {
    const jobId = await appliedAt('2026-05-01T10:00:00Z');
    at('2026-06-01T10:00:00Z');
    expect(await run()).toHaveLength(1);
    expect(await run()).toEqual([]);
    const { events } = await tracker.getTimeline(USER, jobId);
    expect(events.filter((e) => e.to === 'gone_cold')).toHaveLength(1);
  });

  it('touches only open applications of this user: final statuses, no application, other users stay', async () => {
    const rejected = await appliedAt('2026-07-01T10:00:00Z');
    await tracker.setApplicationStatus(USER, rejected, {
      to: 'rejected',
      actor: 'gmail',
      timezone: TZ,
    });
    const none = await newJob();
    const theirs = await appliedAt('2026-07-01T10:00:00Z', OTHER);
    const offer = await appliedAt('2026-07-01T10:00:00Z');
    await tracker.setApplicationStatus(USER, offer, { to: 'offer', actor: 'user', timezone: TZ });
    at('2026-08-01T10:00:00Z');
    expect((await run()).map((m) => m.jobId)).toEqual([offer]);
    expect(await status(rejected)).toBe('rejected');
    expect(await status(none)).toBeNull();
    expect(await status(theirs, OTHER)).toBe('applied');
  });

  it('never touches a Job an AI merge folded into another', async () => {
    const shell = await appliedAt('2026-09-01T10:00:00Z');
    const survivor = await newJob();
    await handle.db.execute(
      sql`update discovery.jobs set merged_into = ${survivor} where id = ${shell}`,
    );
    at('2026-10-01T10:00:00Z');
    expect(await run()).toEqual([]);
    expect(await status(shell)).toBe('applied');
  });

  it('rejects a stale candidate under the Job lock: a status change committed meanwhile wins', async () => {
    const jobId = await appliedAt('2026-01-01T10:00:00Z');
    at('2026-02-01T10:00:00Z');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A writer holds the Job lock and commits Interview with a fresh event while the check is waiting for it.
    const writer = handle.db.transaction(async (tx) => {
      await discovery.lockJob(tx, USER, jobId);
      locked();
      await held;
      await tx.execute(sql`insert into tracker.timeline_events (user_id, job_id, field, from_value, to_value, actor, created_at)
        values (${USER}, ${jobId}, 'application', 'applied', 'interview', 'user', ${clock.toISOString()}::timestamptz)`);
      await tx.execute(
        sql`update tracker.job_state set application_status = 'interview' where user_id = ${USER} and job_id = ${jobId}`,
      );
    });
    await holding;
    const running = run();
    for (let i = 0; i < 100; i += 1) {
      const waiting = await handle.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`,
      );
      if ((waiting[0]?.n ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();
    await writer;
    expect(await running).toEqual([]);
    expect(await status(jobId)).toBe('interview');
    const { events } = await tracker.getTimeline(USER, jobId);
    expect(events.some((ev) => ev.to === 'gone_cold')).toBe(false);
  });

  it('counts across the spring DST switch of 29 March in Berlin', async () => {
    const user = randomUUID();
    const jobId = await appliedAt('2026-03-20T12:00:00Z', user);
    // 21:30 UTC on 2 April is 23:30 in Berlin (CEST): still 2 April, 13 days.
    at('2026-04-02T21:30:00Z');
    expect(await run(user)).toEqual([]);
    // 22:30 UTC is 00:30 on 3 April in Berlin: day 14.
    at('2026-04-02T22:30:00Z');
    expect(await run(user)).toEqual([{ jobId, daysSilent: 14, from: 'applied' }]);
  });

  it('refuses days that are not an integer of at least 1', async () => {
    for (const days of [0, -1, 1.5, Number.NaN]) {
      await expect(run(USER, days)).rejects.toBeInstanceOf(TrackerError);
    }
  });
});
