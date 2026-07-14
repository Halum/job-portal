import { insertError, markWebhookDelivered, type Database } from '@job-portal/db';
import type { ErrorStage, Logger } from '@job-portal/shared';
import type { AppConfigFile } from '@job-portal/config';

export interface NotifyInput {
  event: 'scraper.failed' | 'enrichment.failed' | 'webhook.failed';
  source: string | null;
  jobId?: number | null;
  stage: ErrorStage;
  attempts: number;
  error: string;
}

export interface ErrorNotifierDeps {
  db: Database;
  config: { app: AppConfigFile };
  logger: Logger;
}

/** The best-effort notify function returned by `createErrorNotifier` (never
 * throws — safe to call and await from any failure path). */
export type ErrorNotifier = ReturnType<typeof createErrorNotifier>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Error-notify path (PRD §13): best-effort write an `errors` row, then POST the
 * failure to the n8n error webhook with its own retry budget. Non-2xx counts
 * as failure; only a 2xx flips `webhook_delivered = true`. On exhaustion the
 * row stays `false` — that's the terminal state, no infinite loop.
 */
export function createErrorNotifier(deps: ErrorNotifierDeps) {
  const { db, config, logger } = deps;
  const { error_webhook_url } = config.app.n8n;
  const { attempts, backoff_ms } = config.app.retries.webhook_error;

  return async function notify(input: NotifyInput): Promise<void> {
    const jobId = input.jobId ?? null;

    // 1. Best-effort errors-table row. A DB failure must not crash the caller.
    let errorId: number | undefined;
    try {
      errorId = await insertError(db, {
        source: input.source,
        jobId,
        stage: input.stage,
        attempts: input.attempts,
        errorMessage: input.error,
      });
    } catch (err) {
      logger.error({ err, event: input.event }, 'failed to write errors row');
    }

    // 2. No webhook configured — the errors row above is the whole contract,
    // and n8n reads it via GET /api/errors. Skip the push (and its 5-attempt
    // retry budget) rather than POSTing at nothing.
    if (!error_webhook_url) return;

    // 3. POST the webhook with exponential-backoff retries.
    const body = JSON.stringify({
      event: input.event,
      source: input.source,
      job_id: jobId,
      stage: input.stage,
      attempts: input.attempts,
      error: input.error,
      timestamp: new Date().toISOString(),
    });

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(error_webhook_url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (res.ok) {
          // 4. Delivered.
          if (errorId !== undefined) await markWebhookDelivered(db, errorId, true);
          return;
        }
        logger.warn({ status: res.status, attempt, event: input.event }, 'error webhook non-2xx');
      } catch (err) {
        logger.warn({ err, attempt, event: input.event }, 'error webhook POST failed');
      }
      if (attempt < attempts) await sleep(backoff_ms * 2 ** (attempt - 1));
    }

    // 5. Exhausted — leave webhook_delivered = false (terminal, PRD §13 step 4).
    logger.error({ event: input.event, errorId }, 'error webhook undelivered after retries');
  };
}
