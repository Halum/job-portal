import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import {
  AiError,
  aiMigrations,
  createAi,
  createAiLog,
  type AiResult,
  type AiRunner,
} from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const ok = (over: Partial<AiResult> = {}): AiResult => ({
  text: '{"n":1}',
  model: 'm1',
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.5,
  ...over,
});

describe('AI call log against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let next: () => Promise<AiResult>;
  const runner: AiRunner = { name: 'openrouter', complete: () => next() };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [aiMigrations]);
    handle = createDb(container.getConnectionUri());
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const parse = (text: string): { n: number } => JSON.parse(text) as { n: number };

  it('logs a good call and totals it per user', async () => {
    const log = createAiLog(handle.db);
    const ai = createAi(log, runner);
    next = () => Promise.resolve(ok());
    const out = await ai.run(USER, 'fit_score', 'prompt', parse);
    expect(out).toMatchObject({ value: { n: 1 }, costUsd: 0.5 });
    next = () => Promise.resolve(ok({ costUsd: null, inputTokens: null, outputTokens: null }));
    await ai.run(USER, 'fit_score', 'prompt', parse);
    await ai.run(OTHER, 'fit_score', 'prompt', parse);
    expect(await log.totals(USER)).toEqual({
      calls: 2,
      failures: 0,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
    });
    expect(await log.recent(USER, 1)).toEqual([
      expect.objectContaining({
        runner: 'openrouter',
        model: 'm1',
        feature: 'fit_score',
        outcome: 'ok',
        errorClass: null,
        costUsd: null,
        inputTokens: null,
      }),
    ]);
    expect((await log.recent(USER, 1))[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs a failed call with its error class, rethrows it, and counts it as a failure', async () => {
    const log = createAiLog(handle.db);
    const ai = createAi(log, runner);
    const before = await log.totals(USER);
    next = () => Promise.reject(new AiError('rate_limit', 'slow down'));
    await expect(ai.run(USER, 'fit_score', 'p', parse)).rejects.toMatchObject({
      errorClass: 'rate_limit',
    });
    const [row] = await log.recent(USER, 1);
    expect(row).toMatchObject({ outcome: 'error', errorClass: 'rate_limit', model: null });
    const after = await log.totals(USER);
    expect(after.calls).toBe(before.calls + 1);
    expect(after.failures).toBe(before.failures + 1);
  });

  it('an answer the parser rejects is a logged bad_output failure that still keeps its tokens and cost', async () => {
    const log = createAiLog(handle.db);
    const ai = createAi(log, runner);
    next = () => Promise.resolve(ok({ text: 'not json', costUsd: 0.25 }));
    await expect(ai.run(USER, 'fit_score', 'p', parse)).rejects.toMatchObject({
      errorClass: 'bad_output',
    });
    expect((await log.recent(USER, 1))[0]).toMatchObject({
      outcome: 'error',
      errorClass: 'bad_output',
      costUsd: 0.25,
      model: 'm1',
    });
  });

  it('totals of a user with no calls are zero', async () => {
    expect(await createAiLog(handle.db).totals('00000000-0000-4000-8000-0000000000ff')).toEqual({
      calls: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });
});
