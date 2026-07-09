/** Job lifecycle status, mirrors the `jobs.status` enum in packages/db. */
export type JobStatus = 'unenriched' | 'matched' | 'filtered_out' | 'enrichment_failed';

/** Prompt role, mirrors the `prompts.role` enum in packages/db. */
export type PromptRole = 'filter' | 'summary';

/** Failure stage, mirrors the `errors.stage` enum in packages/db. */
export type ErrorStage = 'scrape' | 'enrichment' | 'webhook';

/** Source types supported by the scraper adapters (PRD §9). Single source of
 * truth — the config zod enum and the scrapers package both derive from this. */
export const SOURCE_TYPES = ['arbeitsagentur', 'feki'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface FilterPassOutput {
  should_notify: boolean;
  reason: string;
}

export interface SummaryPassOutput {
  summary_en: string;
  key_points: string[];
}

export interface EnrichmentJson {
  filter?: FilterPassOutput;
  summary?: SummaryPassOutput;
}

export interface PromptVersions {
  filter?: number;
  summary?: number;
}
