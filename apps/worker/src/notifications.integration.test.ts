import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Ai } from '@job-portal/ai';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createAiMerge, createDiscovery, type Source } from '@job-portal/discovery';
import { createMatching } from '@job-portal/matching';
import { allMigrations } from '@job-portal/migrations';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { buildNotifications } from './notifications';

const source = (id: string, title: string): Source => ({
  id,
  fetch: () =>
    Promise.resolve({
      postings: [
        {
          sourcePostingId: id,
          title,
          company: 'Beispiel Firma GmbH',
          location: 'Bamberg',
          url: `https://jobs.example.invalid/${id}`,
          raw: { id },
        },
      ],
      errors: [],
    }),
});

// Cross-module seam: Notifications reads Jobs through Discovery, so a Job that an AI merge folded into
// another (a hidden shell) never reaches a digest, and its survivor is listed once.
describe('digest candidates and merged-away Jobs', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  /** Two near-duplicate Jobs, both scored above the threshold; optionally merged by a confirmed AI merge. */
  async function digestFor(mergeThem: boolean): Promise<string> {
    // Modules never reference the accounts table, so a fresh id is a fresh user (seedUser is one user only).
    const user = { id: randomUUID() };
    const review = createReview(handle.db);
    const discovery = createDiscovery(handle.db, [
      source('s0', 'Alpha Developer Backend'),
      source('s1', 'Alpha Developer Backend Senior'),
    ]);
    await discovery.poll(user.id, 's0');
    await discovery.poll(user.id, 's1');
    const ai: Ai = {
      run: (_u, feature, _prompt, parse) =>
        Promise.resolve({
          value: parse(
            feature === 'ai_merge'
              ? JSON.stringify({ same: true, reason: 'r' })
              : JSON.stringify({ score: 90, reasons: ['fits'], redFlags: [], languages: [] }),
          ),
          model: 'vendor/model',
          costUsd: null,
        }),
    };
    const matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
      ai,
      review,
      defaultAlertThreshold: 70,
    });
    await matching.upsertTarget(user.id, { name: 'alpha', criteria: { keywords: ['alpha'] } });
    await matching.score(user.id);

    if (mergeThem) {
      const merge = createAiMerge(handle.db, {
        ai,
        review,
        hasApplication: () => Promise.resolve(new Set()),
      });
      await merge.run(user.id);
      const [item] = (await review.list(user.id, { kind: 'ai_merge' })).items;
      await review.decide(user.id, item?.id ?? '', 'confirm', (it, tx, decision) =>
        merge.apply(tx, user.id, it.subject, decision),
      );
      expect((await discovery.listJobs(user.id, {})).jobs).toHaveLength(1);
    }

    const posted: string[] = [];
    const notifications = buildNotifications(
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
        review,
        log: createLogger({ level: 'silent' }),
        fetch: ((_url: string, init: { body: string }) => {
          posted.push((JSON.parse(init.body) as { text: string }).text);
          return Promise.resolve(new Response(null, { status: 200 }));
        }) as unknown as typeof fetch,
      },
    );
    await notifications?.afterRun(user.id, { since: new Date(0), failing: [], checked: [] });
    return posted.join('\n');
  }

  it('lists both Jobs when nothing was merged (control)', async () => {
    const text = await digestFor(false);
    expect(text).toContain('New matches (2)');
  });

  it('lists the survivor once and never the merged-away shell', async () => {
    const text = await digestFor(true);
    expect(text).toContain('New matches (1)');
    expect(text.split(' at Beispiel Firma GmbH').length - 1).toBe(1);
  });
});
