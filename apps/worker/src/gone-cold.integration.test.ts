import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, type Discovery } from '@job-portal/discovery';
import { createMatching, type Matching } from '@job-portal/matching';
import { allMigrations } from '@job-portal/migrations';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker, type Tracker } from '@job-portal/tracker';
import { createGoneColdCheck } from './gone-cold';
import { buildNotifications } from './notifications';

const TZ = 'Europe/Berlin';

describe('the daily Gone cold check through Tracker, Matching defaults and Notifications', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let discovery: Discovery;
  let matching: Matching;
  let tracker: Tracker;
  let clock = new Date();
  let status = 200;
  let posted: { kind: string; text: string; topicId: string }[] = [];
  const log = createLogger({ level: 'silent' });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    discovery = createDiscovery(handle.db, []);
    matching = createMatching(handle.db, { loadJobs: (u, ids) => discovery.listMatchable(u, ids) });
    tracker = createTracker(handle.db, discovery, () => clock);
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const notifications = (on: boolean) =>
    on
      ? buildNotifications(
          handle.db,
          {
            webhookUrl: 'http://hook.example.invalid/x',
            topicId: 'topic-placeholder',
            maxAttempts: 1,
            backoffMs: 0,
          },
          {
            matching,
            discovery,
            review: createReview(handle.db),
            log,
            fetch: ((_url: string, init: { body: string }) => {
              if (status === 200) posted.push(JSON.parse(init.body) as (typeof posted)[number]);
              return Promise.resolve(new Response(null, { status }));
            }) as unknown as typeof fetch,
          },
        )
      : null;
  const setup = async (days: number | null, webhook = true) => {
    const user = { id: randomUUID(), timezone: TZ };
    if (days !== null) await matching.updateGlobalDefaults(user.id, { goneColdDays: days });
    clock = new Date('2026-03-01T10:00:00Z');
    const { jobId } = await discovery.addJob(user.id, {
      title: 'Koch',
      company: 'Beispiel Firma GmbH',
      url: `https://t.example.invalid/${user.id}`,
    });
    await tracker.setApplicationStatus(user.id, jobId, {
      to: 'applied',
      actor: 'user',
      timezone: TZ,
    });
    const check = createGoneColdCheck({
      tracker,
      matching,
      discovery,
      notifications: notifications(webhook),
      user,
      log,
    });
    const statusOf = async (): Promise<string | null> =>
      (await tracker.getStates(user.id, [jobId])).get(jobId)?.applicationStatus ?? null;
    return { check, statusOf };
  };

  it('does nothing while the Global default is null', async () => {
    posted = [];
    const { check, statusOf } = await setup(null);
    clock = new Date('2027-03-01T10:00:00Z');
    expect(await check.run()).toBe(0);
    expect(await statusOf()).toBe('applied');
    expect(posted).toEqual([]);
  });

  it('moves a Job N days silent, sends one short line, and does neither again on the next run', async () => {
    posted = [];
    status = 200;
    const { check, statusOf } = await setup(14);
    clock = new Date('2026-03-14T10:00:00Z');
    expect(await check.run()).toBe(0);
    clock = new Date('2026-03-15T10:00:00Z');
    expect(await check.run()).toBe(1);
    expect(await statusOf()).toBe('gone_cold');
    expect(posted).toEqual([
      {
        kind: 'line',
        topicId: 'topic-placeholder',
        text: 'Gone cold: Koch at Beispiel Firma GmbH, 14 days silent',
      },
    ]);
    expect(await check.run()).toBe(0);
    expect(posted).toHaveLength(1);
  });

  it('still moves the Job when no webhook is configured', async () => {
    const { check, statusOf } = await setup(14, false);
    clock = new Date('2026-03-20T10:00:00Z');
    expect(await check.run()).toBe(1);
    expect(await statusOf()).toBe('gone_cold');
  });

  it('still moves the Job when the webhook is down', async () => {
    posted = [];
    status = 503;
    const { check, statusOf } = await setup(14);
    clock = new Date('2026-03-20T10:00:00Z');
    expect(await check.run()).toBe(1);
    expect(await statusOf()).toBe('gone_cold');
    status = 200;
    expect(posted).toEqual([]);
  });
});
