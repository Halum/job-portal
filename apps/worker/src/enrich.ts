import {
  getJobById,
  getPrompt,
  markEnrichmentFailed,
  markFilteredOut,
  markMatched,
  type Database,
} from '@job-portal/db';
import type { LlmClient } from '@job-portal/llm';
import { renderTemplate } from '@job-portal/llm';
import type { AppConfigFile } from '@job-portal/config';
import type { Logger, SourceType } from '@job-portal/shared';
import type { EnrichmentPayload } from './scrape.js';

export type { EnrichmentPayload } from './scrape.js';

export interface EnrichmentHandlerDeps {
  db: Database;
  llm: LlmClient;
  config: { app: AppConfigFile };
  logger: Logger;
}

/**
 * Enrichment job handler — two-pass LLM pipeline (PRD §11 steps 1–7).
 * Missing-prompt failures are terminal (return without throwing, so BullMQ
 * doesn't retry a condition retrying can't fix); LLM call failures propagate
 * so BullMQ retries per `retries.enrichment`.
 */
export function createEnrichmentHandler(deps: EnrichmentHandlerDeps) {
  return async function handleEnrichment(payload: EnrichmentPayload): Promise<void> {
    const start = Date.now();
    const { db, llm, config, logger } = deps;

    // 1. Load the job.
    const job = await getJobById(db, payload.jobId);
    if (!job) {
      logger.warn({ job_id: payload.jobId }, 'enrichment: job not found, skipping');
      return;
    }

    // jobs.source is a free-text column (any adapter can register a source),
    // but prompts are only ever configured for the known SourceType set.
    const source = job.source as SourceType;

    // 2. Load the filter prompt for this source.
    const filterPrompt = await getPrompt(db, source, 'filter');
    if (!filterPrompt) {
      // S3: write an errors-table row + fire the n8n error webhook here.
      await markEnrichmentFailed(db, job.id);
      logger.error(
        { job_id: job.id, source: job.source },
        'enrichment: no filter prompt configured',
      );
      return;
    }

    // 3. Render the filter template. ponytail: there is no `description`
    // column on jobs (it only lives inside source-specific `raw`), so
    // `{{description}}` always resolves to '' — upgrade if a source's filter
    // prompt actually needs it.
    const vars = {
      title: job.title,
      company: job.company ?? '',
      location: job.location ?? '',
      apply_url: job.applyUrl,
      source: job.source,
    };
    const renderedFilterPrompt = renderTemplate(filterPrompt.template, vars);

    // 4. Filter pass. Throws propagate → BullMQ retries.
    const filterOutput = await llm.filter({
      model: config.app.llm.filter.model,
      max_tokens: config.app.llm.filter.max_tokens,
      temperature: config.app.llm.filter.temperature,
      prompt: renderedFilterPrompt,
    });

    // 5. Not a match — done.
    if (!filterOutput.should_notify) {
      await markFilteredOut(db, job.id, filterOutput);
      logger.info(
        {
          job_id: job.id,
          source: job.source,
          status: 'filtered_out',
          duration_ms: Date.now() - start,
        },
        'enrichment: filtered out',
      );
      return;
    }

    // 6. Match — run the summary pass.
    const summaryPrompt = await getPrompt(db, source, 'summary');
    if (!summaryPrompt) {
      // S3: write an errors-table row + fire the n8n error webhook here.
      await markEnrichmentFailed(db, job.id);
      logger.error(
        { job_id: job.id, source: job.source },
        'enrichment: no summary prompt configured',
      );
      return;
    }
    const summaryOutput = await llm.summary({
      model: config.app.llm.summary.model,
      max_tokens: config.app.llm.summary.max_tokens,
      temperature: config.app.llm.summary.temperature,
      prompt: renderTemplate(summaryPrompt.template, vars),
    });

    // 7. Matched.
    await markMatched(db, job.id, filterOutput, summaryOutput);
    logger.info(
      { job_id: job.id, source: job.source, status: 'matched', duration_ms: Date.now() - start },
      'enrichment: matched',
    );
  };
}
