import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, discoveryMigrations, type Discovery } from '@job-portal/discovery';
import { createTracker, TrackerError, trackerMigrations, type Tracker } from './index';

const TZ = 'Europe/Berlin';
// 23:30 UTC on 20 Nov is already 21 Nov in Berlin.
const NOW = new Date('2026-11-20T23:30:00Z');
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

describe('tracker against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let discovery: Discovery;
  let tracker: Tracker;
  let n = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [
      discoveryMigrations,
      trackerMigrations,
    ]);
    handle = createDb(container.getConnectionUri());
    discovery = createDiscovery(handle.db, []);
    tracker = createTracker(handle.db, discovery, () => NOW);
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const newJob = async (user = USER): Promise<string> =>
    (
      await discovery.addJob(user, {
        title: 'Koch',
        url: `https://t.example.invalid/${String(++n)}`,
      })
    ).jobId;
  const state = async (jobId: string, user = USER) => ({
    ...(await tracker.getStates(user, [jobId])).get(jobId),
    discoveryState: (await discovery.getJob(user, jobId))?.discoveryState,
  });
  const apply = (jobId: string, extra: { appliedOn?: string; applyBy?: string } = {}) =>
    tracker.setApplicationStatus(USER, jobId, {
      to: 'applied',
      actor: 'user',
      timezone: TZ,
      ...extra,
    });
  const move = (
    jobId: string,
    to: 'screening' | 'interview' | 'offer' | 'rejected',
    actor: 'gmail' | 'user' = 'user',
  ) => tracker.setApplicationStatus(USER, jobId, { to, actor, timezone: TZ });

  it('reports a new Job as new with no application', async () => {
    expect(await state(await newJob())).toEqual({
      discoveryState: 'new',
      applicationStatus: null,
      furthestStage: null,
      appliedOn: null,
      applyBy: null,
    });
  });

  it('refuses a Job that does not exist or belongs to someone else', async () => {
    const job = await newJob();
    await expect(
      tracker.setDiscoveryState(USER, '00000000-0000-4000-8000-0000000000ff', 'dismissed', 'user'),
    ).rejects.toThrow(/No Job/);
    await expect(tracker.setDiscoveryState(OTHER, job, 'dismissed', 'user')).rejects.toThrow(
      /No Job/,
    );
    expect(await tracker.getTimeline(OTHER, job)).toEqual({ events: [], notes: [] });
    expect((await state(job)).discoveryState).toBe('new');
  });

  it('changes the discovery state on the Job freely until an application starts, and records each change', async () => {
    const job = await newJob();
    await tracker.setDiscoveryState(USER, job, 'shortlisted', 'user');
    expect(
      await tracker.setDiscoveryState(USER, job, 'dismissed', 'skill', 'not a fit'),
    ).toMatchObject({
      discoveryState: 'dismissed',
    });
    expect((await state(job)).discoveryState).toBe('dismissed');
    await expect(tracker.setDiscoveryState(USER, job, 'dismissed', 'user')).rejects.toBeInstanceOf(
      TrackerError,
    );

    await apply(job); // Applied can be set from any discovery state
    await expect(tracker.setDiscoveryState(USER, job, 'new', 'user')).rejects.toThrow(
      /application status/,
    );

    const { events } = await tracker.getTimeline(USER, job);
    expect(events.map((e) => [e.field, e.from, e.to, e.actor, e.evidence])).toEqual([
      ['discovery', 'new', 'shortlisted', 'user', null],
      ['discovery', 'shortlisted', 'dismissed', 'skill', 'not a fit'],
      ['application', null, 'applied', 'user', null],
    ]);
  });

  it('undo of a discovery change restores the state on the Job', async () => {
    const job = await newJob();
    await tracker.setDiscoveryState(USER, job, 'shortlisted', 'user');
    expect(await tracker.undoLastChange(USER, job, 'user')).toMatchObject({
      discoveryState: 'new',
    });
    expect((await state(job)).discoveryState).toBe('new');
  });

  it('Applied takes today in the user timezone or the given dates, and a second Applied is refused with the date', async () => {
    const a = await newJob();
    expect(await apply(a)).toMatchObject({
      applicationStatus: 'applied',
      appliedOn: '2026-11-21',
      applyBy: null,
    });
    await expect(apply(a)).rejects.toThrow(/already applied on 2026-11-21/);

    const b = await newJob();
    expect(await apply(b, { appliedOn: '2026-11-01', applyBy: '2026-12-01' })).toMatchObject({
      appliedOn: '2026-11-01',
      applyBy: '2026-12-01',
    });
    await expect(apply(await newJob(), { appliedOn: '2026-02-30' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      tracker.setApplicationStatus(USER, await newJob(), {
        to: 'applied',
        actor: 'gmail',
        timezone: TZ,
      }),
    ).rejects.toThrow(/user or the skill/);
    await expect(
      tracker.setApplicationStatus(USER, b, {
        to: 'screening',
        actor: 'user',
        timezone: TZ,
        appliedOn: '2026-11-02',
      }),
    ).rejects.toThrow(/Applied only/);
  });

  it('keeps the furthest stage monotonic and undo restores it', async () => {
    const job = await newJob();
    await apply(job);
    await move(job, 'interview', 'gmail');
    expect(await move(job, 'offer')).toMatchObject({
      applicationStatus: 'offer',
      furthestStage: 'offer',
    });
    expect(await move(job, 'rejected', 'gmail')).toMatchObject({
      applicationStatus: 'rejected',
      furthestStage: 'offer',
    });

    // A final status changes only by undo.
    await expect(move(job, 'screening')).rejects.toThrow(/final/);
    expect(await tracker.undoLastChange(USER, job, 'user')).toMatchObject({
      applicationStatus: 'offer',
      furthestStage: 'offer',
    });
    // The last event is now an undo, so a second undo in a row is refused.
    await expect(tracker.undoLastChange(USER, job, 'user')).rejects.toThrow(/already an undo/);
    const { events } = await tracker.getTimeline(USER, job);
    expect(events.filter((e) => e.undoes).map((e) => [e.from, e.to])).toEqual([
      ['rejected', 'offer'],
    ]);
  });

  it('undo of a forward step lowers the furthest stage again, and undo of Applied clears the application', async () => {
    const job = await newJob();
    await apply(job, { applyBy: '2026-12-01' });
    await move(job, 'interview');
    expect(await tracker.undoLastChange(USER, job, 'user')).toMatchObject({
      applicationStatus: 'applied',
      furthestStage: 'applied',
    });

    const job2 = await newJob();
    await apply(job2, { applyBy: '2026-12-01' });
    expect(await tracker.undoLastChange(USER, job2, 'user')).toEqual({
      discoveryState: 'new',
      applicationStatus: null,
      furthestStage: null,
      appliedOn: null,
      applyBy: null,
    });
    expect(await apply(job2)).toMatchObject({ applicationStatus: 'applied' });
  });

  it('refuses an undo with nothing to undo, and notes never count as a change', async () => {
    const job = await newJob();
    await expect(tracker.undoLastChange(USER, job, 'user')).rejects.toThrow(/nothing to undo/);
    await apply(job);
    const note = await tracker.addNote(USER, job, 'called, back on Monday');
    expect(note.text).toBe('called, back on Monday');
    expect((await tracker.undoLastChange(USER, job, 'user')).applicationStatus).toBeNull();
    const { events, notes } = await tracker.getTimeline(USER, job);
    expect(events).toHaveLength(2);
    expect(notes.map((x) => x.text)).toEqual(['called, back on Monday']);
  });

  it('finds the Jobs matching application filters', async () => {
    const early = await newJob();
    const late = await newJob();
    await apply(early, { applyBy: '2026-12-01' });
    await apply(late, { applyBy: '2027-03-01' });
    await move(late, 'screening');
    const ids = async (f: Parameters<Tracker['findJobIds']>[1]) =>
      (await tracker.findJobIds(USER, f)).sort();
    expect(await ids({ applicationStatus: 'screening' })).toContain(late);
    expect(await ids({ applicationStatus: 'screening' })).not.toContain(early);
    expect(await ids({ applyByOnOrBefore: '2026-12-31' })).toContain(early);
    expect(await ids({ applyByOnOrBefore: '2026-12-31' })).not.toContain(late);
    expect(await tracker.findJobIds(OTHER, {})).toEqual([]);
  });

  it('a filtered Jobs page is full when enough rows match, with the cursor continuing it', async () => {
    const user = '00000000-0000-4000-8000-000000000003';
    const jobs: string[] = [];
    for (let i = 0; i < 12; i += 1) jobs.push(await newJob(user));
    // Interleave matches with non-matches so a filter applied after paging would return short pages.
    for (const [i, id] of jobs.entries()) {
      if (i % 2 === 0) await tracker.setDiscoveryState(user, id, 'shortlisted', 'user');
      if (i % 3 === 0) {
        await tracker.setApplicationStatus(user, id, {
          to: 'applied',
          actor: 'user',
          timezone: TZ,
        });
      }
    }
    const byState = await discovery.listJobs(user, { discoveryState: 'shortlisted', limit: 4 });
    expect(byState.jobs).toHaveLength(4);
    expect(byState.nextCursor).not.toBeNull();
    const rest = await discovery.listJobs(user, {
      discoveryState: 'shortlisted',
      limit: 4,
      cursor: byState.nextCursor,
    });
    expect(rest.jobs).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();

    const appliedIds = await tracker.findJobIds(user, { applicationStatus: 'applied' });
    const page = await discovery.listJobs(user, { jobIds: appliedIds, limit: 3 });
    expect(page.jobs).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    expect((await discovery.listJobs(user, { jobIds: [] })).jobs).toEqual([]);
  });

  it('two Applied writes at once leave one Applied and one Timeline event', async () => {
    const job = await newJob();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => apply(job)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await tracker.getTimeline(USER, job)).events).toHaveLength(1);
  });

  it('racing status and discovery writes leave a Timeline that chains from one state to the next', async () => {
    for (let round = 0; round < 5; round += 1) {
      const job = await newJob();
      await Promise.allSettled([
        tracker.setDiscoveryState(USER, job, 'shortlisted', 'user'),
        apply(job),
        tracker.setDiscoveryState(USER, job, 'dismissed', 'user'),
        move(job, 'screening'),
        tracker.undoLastChange(USER, job, 'user'),
      ]);
      const { events } = await tracker.getTimeline(USER, job);
      const current = { discovery: 'new' as string | null, application: null as string | null };
      for (const e of events) {
        expect(e.from).toBe(current[e.field]);
        current[e.field] = e.to;
      }
      const final = await state(job);
      expect(final.discoveryState).toBe(current.discovery);
      expect(final.applicationStatus).toBe(current.application);
    }
  });

  it("runs inside the caller's transaction when given one: both commit or both roll back", async () => {
    const job = await newJob();
    await apply(job);
    const boom = new Error('caller failed');
    await expect(
      handle.db.transaction(async (tx) => {
        await tracker.setApplicationStatus(
          USER,
          job,
          { to: 'screening', actor: 'gmail', timezone: TZ },
          tx,
        );
        await tracker.addNote(USER, job, 'rolled back note', tx);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect((await state(job)).applicationStatus).toBe('applied');
    expect((await tracker.getTimeline(USER, job)).notes).toEqual([]);

    await handle.db.transaction(async (tx) => {
      await tracker.setApplicationStatus(
        USER,
        job,
        { to: 'screening', actor: 'gmail', timezone: TZ },
        tx,
      );
      await tracker.addNote(USER, job, 'kept note', tx);
    });
    expect((await state(job)).applicationStatus).toBe('screening');
    expect((await tracker.getTimeline(USER, job)).notes.map((x) => x.text)).toEqual(['kept note']);
  });
});
