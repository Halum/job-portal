import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type Logger } from '@job-portal/shared';
import type { LlmClient } from '@job-portal/llm';
import type { AppConfigFile, SourceEntry } from '@job-portal/config';
import type { Job, Prompt } from '@job-portal/db';

const getJobById = vi.fn();
const getPrompt = vi.fn();
const markFilteredOut = vi.fn();
const markMatched = vi.fn();
const markEnrichmentFailed = vi.fn();
const setJobDescription = vi.fn();

vi.mock('@job-portal/db', () => ({
  getJobById,
  getPrompt,
  markFilteredOut,
  markMatched,
  markEnrichmentFailed,
  setJobDescription,
}));

const fetchDescription = vi.fn();
const getAdapter = vi.fn(() => ({ fetchDescription }));

vi.mock('@job-portal/scrapers', () => ({
  getAdapter,
}));

const { createEnrichmentHandler } = await import('../src/enrich.js');

const sourceEntry: SourceEntry = {
  name: 'feki',
  source_type: 'feki',
  url: 'https://example.test/jobs',
  cron: '0 * * * *',
  enabled: true,
};

const config = {
  app: {
    llm: {
      filter: { model: 'filter-model', max_tokens: 100, temperature: 0 },
      summary: { model: 'summary-model', max_tokens: 200, temperature: 0.3 },
    },
  } as AppConfigFile,
  sources: [sourceEntry],
};

const silentLogger: Logger = createLogger({ level: 'silent' });
const notify = vi.fn();

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 1,
    source: 'feki',
    externalId: 'ext-1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Bamberg',
    applyUrl: 'https://e/1',
    postedAt: null,
    description: null,
    raw: {},
    status: 'unenriched',
    enrichmentJson: null,
    createdAt: new Date(),
    firstSeenAt: new Date(),
    enrichedAt: null,
    ...over,
  };
}

function makePrompt(role: 'filter' | 'summary', template: string): Prompt {
  return {
    id: 1,
    source: 'feki',
    role,
    template,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeLlm(over: Partial<LlmClient> = {}): LlmClient {
  return {
    filter: vi.fn(),
    summary: vi.fn(),
    ...over,
  };
}

function makeCost(model: string) {
  return {
    model,
    cost: 0.00001,
    upstream_inference_cost: 0.00001,
    upstream_inference_prompt_cost: null,
    upstream_inference_completions_cost: null,
  };
}

describe('createEnrichmentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchDescription.mockResolvedValue('');
    setJobDescription.mockResolvedValue(undefined);
  });

  it('job not found: logs and returns without touching the llm', async () => {
    getJobById.mockResolvedValueOnce(null);
    const llm = makeLlm();
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 999 });

    expect(llm.filter).not.toHaveBeenCalled();
    expect(markEnrichmentFailed).not.toHaveBeenCalled();
  });

  it('resolves prompt lookup by source_type, not the raw job.source name', async () => {
    // job.source is the sources.yaml `name` (can differ from source_type,
    // e.g. "arbeitsagentur-bamberg" vs source_type "arbeitsagentur") — the
    // handler must resolve source_type via config.sources, not cast job.source.
    const namedConfig = {
      ...config,
      sources: [
        { name: 'arbeitsagentur-bamberg', source_type: 'arbeitsagentur', url: 'https://x', cron: '0 * * * *', enabled: true } satisfies SourceEntry,
      ],
    };
    getJobById.mockResolvedValueOnce(makeJob({ source: 'arbeitsagentur-bamberg' }));
    getPrompt
      .mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}'))
      .mockResolvedValueOnce(makePrompt('summary', 'Summarize {{title}}'));
    const llm = makeLlm({
      filter: vi.fn().mockResolvedValue({ output: { german_phrase: null, german_requirement: 'NONE' as const, reason: 'ok' }, cost: makeCost('filter-model') }),
      summary: vi.fn().mockResolvedValue({ output: { summary_en: 's', key_points: [] }, cost: makeCost('summary-model') }),
    });
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config: namedConfig,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(getPrompt).toHaveBeenNthCalledWith(1, {}, 'arbeitsagentur', 'filter');
    expect(getPrompt).toHaveBeenNthCalledWith(2, {}, 'arbeitsagentur', 'summary');
  });

  it('job source not in configured sources: marks enrichment_failed, notifies', async () => {
    getJobById.mockResolvedValueOnce(makeJob({ source: 'unknown-source' }));
    const llm = makeLlm();
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(getPrompt).not.toHaveBeenCalled();
    expect(llm.filter).not.toHaveBeenCalled();
    expect(markEnrichmentFailed).toHaveBeenCalledWith({}, 1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'enrichment.failed',
        source: 'unknown-source',
        jobId: 1,
        stage: 'enrichment',
      }),
    );
  });

  it('missing filter prompt: marks enrichment_failed, returns without calling llm', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt.mockResolvedValueOnce(null);
    const llm = makeLlm();
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(llm.filter).not.toHaveBeenCalled();
    expect(markEnrichmentFailed).toHaveBeenCalledWith({}, 1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'enrichment.failed',
        source: 'feki',
        jobId: 1,
        stage: 'enrichment',
      }),
    );
  });

  it('german_requirement REQUIRED: marks filtered_out, never runs the summary pass', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt.mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}} at {{company}}'));
    const filterOutput = {
      german_phrase: 'Deutsch fliessend',
      german_requirement: 'REQUIRED' as const,
      reason: 'German is required',
    };
    const filterCost = makeCost('filter-model');
    const llm = makeLlm({ filter: vi.fn().mockResolvedValue({ output: filterOutput, cost: filterCost }) });
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(llm.filter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'filter-model', prompt: 'Filter Backend Engineer at Acme' }),
    );
    expect(markFilteredOut).toHaveBeenCalledWith({}, 1, filterOutput, filterCost);
    expect(llm.summary).not.toHaveBeenCalled();
  });

  // Regression: a real posting said "Gute Deutschkenntnisse wünschenswert" —
  // German is merely desirable, so it must still notify. The old prompt rejected
  // it, which is precisely the false positive the OPTIONAL class exists to prevent.
  it('german_requirement OPTIONAL: still matches — desirable German is not a blocker', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt
      .mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}'))
      .mockResolvedValueOnce(makePrompt('summary', 'Summarize {{title}}'));
    const filterOutput = {
      german_phrase: 'Gute Deutschkenntnisse wünschenswert',
      german_requirement: 'OPTIONAL' as const,
      reason: 'German is desirable, not required',
    };
    const llm = makeLlm({
      filter: vi.fn().mockResolvedValue({ output: filterOutput, cost: makeCost('filter-model') }),
      summary: vi.fn().mockResolvedValue({
        output: { title_en: 'Cleaner', summary_en: 's', key_points: [] },
        cost: makeCost('summary-model'),
      }),
    });
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(markFilteredOut).not.toHaveBeenCalled();
    expect(llm.summary).toHaveBeenCalled();
    expect(markMatched).toHaveBeenCalled();
  });

  it('german_requirement NONE: runs summary pass and marks matched', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt
      .mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}'))
      .mockResolvedValueOnce(makePrompt('summary', 'Summarize {{title}}'));
    const filterOutput = {
      german_phrase: null,
      german_requirement: 'NONE' as const,
      reason: 'no German mentioned',
    };
    const summaryOutput = { summary_en: 'a summary', key_points: ['a'] };
    const filterCost = makeCost('filter-model');
    const summaryCost = makeCost('summary-model');
    const llm = makeLlm({
      filter: vi.fn().mockResolvedValue({ output: filterOutput, cost: filterCost }),
      summary: vi.fn().mockResolvedValue({ output: summaryOutput, cost: summaryCost }),
    });
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(llm.summary).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'summary-model', prompt: 'Summarize Backend Engineer' }),
    );
    expect(markMatched).toHaveBeenCalledWith({}, 1, filterOutput, summaryOutput, filterCost, summaryCost);
  });

  it('missing summary prompt after a match: marks enrichment_failed', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt
      .mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}'))
      .mockResolvedValueOnce(null);
    const filterOutput = {
      german_phrase: null,
      german_requirement: 'NONE' as const,
      reason: 'no German mentioned',
    };
    const llm = makeLlm({ filter: vi.fn().mockResolvedValue({ output: filterOutput, cost: makeCost('filter-model') }) });
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(llm.summary).not.toHaveBeenCalled();
    expect(markEnrichmentFailed).toHaveBeenCalledWith({}, 1);
    expect(markMatched).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'enrichment.failed',
        source: 'feki',
        jobId: 1,
        stage: 'enrichment',
        error: 'no summary prompt for source feki',
      }),
    );
  });

  it('description empty: fetches via adapter and caches it, then includes it in the prompt vars', async () => {
    getJobById.mockResolvedValueOnce(makeJob({ description: null }));
    getPrompt.mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}: {{description}}'));
    fetchDescription.mockResolvedValueOnce('Fetched job body text.');
    const filterOutput = {
      german_phrase: 'Deutsch fliessend',
      german_requirement: 'REQUIRED' as const,
      reason: 'German is required',
    };
    const llm = makeLlm({ filter: vi.fn().mockResolvedValue({ output: filterOutput, cost: makeCost('filter-model') }) });
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(getAdapter).toHaveBeenCalledWith('feki');
    expect(fetchDescription).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, externalId: 'ext-1', applyUrl: 'https://e/1' }),
    );
    expect(setJobDescription).toHaveBeenCalledWith({}, 1, 'Fetched job body text.');
    expect(llm.filter).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Filter Backend Engineer: Fetched job body text.' }),
    );
  });

  it('description already populated: skips the adapter fetch entirely', async () => {
    getJobById.mockResolvedValueOnce(makeJob({ description: 'Already cached.' }));
    getPrompt.mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}: {{description}}'));
    const filterOutput = {
      german_phrase: 'Deutsch fliessend',
      german_requirement: 'REQUIRED' as const,
      reason: 'German is required',
    };
    const llm = makeLlm({ filter: vi.fn().mockResolvedValue({ output: filterOutput, cost: makeCost('filter-model') }) });
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await handler({ jobId: 1 });

    expect(fetchDescription).not.toHaveBeenCalled();
    expect(setJobDescription).not.toHaveBeenCalled();
    expect(llm.filter).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Filter Backend Engineer: Already cached.' }),
    );
  });

  it('llm.filter throw propagates (BullMQ retries), no status mutation', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt.mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}'));
    const llm = makeLlm({ filter: vi.fn().mockRejectedValue(new Error('rate limited')) });
    const handler = createEnrichmentHandler({
      db: {} as never,
      llm,
      config,
      logger: silentLogger,
      notify,
    });

    await expect(handler({ jobId: 1 })).rejects.toThrow('rate limited');
    expect(markEnrichmentFailed).not.toHaveBeenCalled();
    expect(markFilteredOut).not.toHaveBeenCalled();
  });
});
