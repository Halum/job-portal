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

vi.mock('@job-portal/db', () => ({
  getJobById,
  getPrompt,
  markFilteredOut,
  markMatched,
  markEnrichmentFailed,
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

describe('createEnrichmentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      filter: vi.fn().mockResolvedValue({ should_notify: true, reason: 'ok' }),
      summary: vi.fn().mockResolvedValue({ summary_en: 's', key_points: [] }),
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

  it('should_notify false: marks filtered_out, never runs the summary pass', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt.mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}} at {{company}}'));
    const filterOutput = { should_notify: false, reason: 'not relevant' };
    const llm = makeLlm({ filter: vi.fn().mockResolvedValue(filterOutput) });
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
    expect(markFilteredOut).toHaveBeenCalledWith({}, 1, filterOutput);
    expect(llm.summary).not.toHaveBeenCalled();
  });

  it('should_notify true: runs summary pass and marks matched', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt
      .mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}'))
      .mockResolvedValueOnce(makePrompt('summary', 'Summarize {{title}}'));
    const filterOutput = { should_notify: true, reason: 'relevant' };
    const summaryOutput = { summary_en: 'a summary', key_points: ['a'] };
    const llm = makeLlm({
      filter: vi.fn().mockResolvedValue(filterOutput),
      summary: vi.fn().mockResolvedValue(summaryOutput),
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
    expect(markMatched).toHaveBeenCalledWith({}, 1, filterOutput, summaryOutput);
  });

  it('missing summary prompt after a match: marks enrichment_failed', async () => {
    getJobById.mockResolvedValueOnce(makeJob());
    getPrompt
      .mockResolvedValueOnce(makePrompt('filter', 'Filter {{title}}'))
      .mockResolvedValueOnce(null);
    const filterOutput = { should_notify: true, reason: 'relevant' };
    const llm = makeLlm({ filter: vi.fn().mockResolvedValue(filterOutput) });
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
