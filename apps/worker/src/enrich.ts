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
import type { AppConfigFile, SourceEntry } from '@job-portal/config';
import type { Logger } from '@job-portal/shared';
import type { EnrichmentPayload } from './scrape.js';
import type { ErrorNotifier } from './notify.js';

export type { EnrichmentPayload } from './scrape.js';

export interface EnrichmentHandlerDeps {
  db: Database;
  llm: LlmClient;
  config: { app: AppConfigFile; sources: SourceEntry[] };
  logger: Logger;
  notify: ErrorNotifier;
}

/**
 * Enrichment job handler — two-pass LLM pipeline (PRD §11 steps 1–7).
 * Missing-prompt failures are terminal (mark enrichment_failed + error-notify,
 * then return without throwing, so BullMQ doesn't retry a condition retrying
 * can't fix — PRD §11 step 2); LLM call failures propagate so BullMQ retries
 * per `retries.enrichment`.
 */
export function createEnrichmentHandler(deps: EnrichmentHandlerDeps) {
  return async function handleEnrichment(payload: EnrichmentPayload): Promise<void> {
    const start = Date.now();
    const { db, llm, config, logger, notify } = deps;

    // 1. Load the job.
    const job = await getJobById(db, payload.jobId);
    if (!job) {
      logger.warn({ job_id: payload.jobId }, 'enrichment: job not found, skipping');
      return;
    }

    // jobs.source holds the sources.yaml `name` (e.g. "arbeitsagentur-bamberg"),
    // which is distinct from `source_type` — multiple named sources can share
    // one type (PRD §9: "a second entry with source_type: feki"). Prompts are
    // keyed by source_type, so resolve it via the loaded source config rather
    // than assuming source_type === job.source.
    const sourceEntry = config.sources.find((s) => s.name === job.source);
    if (!sourceEntry) {
      await markEnrichmentFailed(db, job.id);
      logger.error(
        { job_id: job.id, source: job.source },
        'enrichment: job source not found in configured sources',
      );
      await notify({
        event: 'enrichment.failed',
        source: job.source,
        jobId: job.id,
        stage: 'enrichment',
        attempts: 1,
        error: `job source "${job.source}" not found in configured sources`,
      });
      return;
    }
    const source = sourceEntry.source_type;

    // 2. Load the filter prompt for this source.
    const filterPrompt = await getPrompt(db, source, 'filter');
    if (!filterPrompt) {
      await markEnrichmentFailed(db, job.id);
      logger.error(
        { job_id: job.id, source: job.source },
        'enrichment: no filter prompt configured',
      );
      await notify({
        event: 'enrichment.failed',
        source: job.source,
        jobId: job.id,
        stage: 'enrichment',
        attempts: 1,
        error: 'no filter prompt for source ' + job.source,
      });
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
      await markEnrichmentFailed(db, job.id);
      logger.error(
        { job_id: job.id, source: job.source },
        'enrichment: no summary prompt configured',
      );
      await notify({
        event: 'enrichment.failed',
        source: job.source,
        jobId: job.id,
        stage: 'enrichment',
        attempts: 1,
        error: 'no summary prompt for source ' + job.source,
      });
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
