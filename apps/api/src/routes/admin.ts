import { Router, type RequestHandler } from 'express';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { ERROR_STAGES, JOB_STATUSES, PROMPT_ROLES, type ScrapePayload } from '@job-portal/shared';
import type { SourceEntry } from '@job-portal/config';
import { listErrorsWindow, selectJobIds, type Database, type ErrorRow } from '@job-portal/db';

const EPOCH = new Date(0);

const reenrichBodySchema = z.object({
  source: z.string().min(1).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  // ponytail: prompt_role is vestigial — reenrich always re-runs both passes.
  // Accepted so old callers don't 400, then ignored. Drop from the schema if
  // no client ever sends it.
  prompt_role: z.enum(PROMPT_ROLES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  job_ids: z.array(z.number().int()).optional(),
});

const rescrapeBodySchema = z.object({
  source: z.string().min(1).optional(),
});

const errorsQuerySchema = z.object({
  stage: z.enum(ERROR_STAGES).optional(),
  from: z.coerce.date().default(EPOCH),
  to: z.coerce.date().default(() => new Date()),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Maps a drizzle ErrorRow (camelCase) to the snake_case audit wire shape. */
function toErrorResponse(row: ErrorRow) {
  return {
    id: row.id,
    source: row.source,
    job_id: row.jobId,
    stage: row.stage,
    attempts: row.attempts,
    error_message: row.errorMessage,
    error_stack: row.errorStack,
    payload: row.payload,
    webhook_delivered: row.webhookDelivered,
    created_at: row.createdAt,
  };
}

export interface AdminRouterDeps {
  auth: RequestHandler;
  db: Database;
  enrichmentQueue: Pick<Queue, 'add'>;
  scrapeQueue: Pick<Queue, 'add'>;
  sources: SourceEntry[];
}

/**
 * Admin API (PRD §12): reenrich producer, in-memory source listing, and the
 * errors audit view. Behind bearer auth.
 */
export function createAdminRouter(deps: AdminRouterDeps): Router {
  const { auth, db, enrichmentQueue, scrapeQueue, sources } = deps;
  const router = Router();

  router.post('/api/admin/rescrape', auth, async (req, res) => {
    const parsed = rescrapeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }
    const { source } = parsed.data;
    const targets = source ? sources.filter((s) => s.name === source) : sources.filter((s) => s.enabled);
    if (source && targets.length === 0) {
      res.status(404).json({ error: `Unknown source: ${source}` });
      return;
    }
    // No `repeat` block — a one-off run alongside the worker's existing cron
    // registration (registerScrapeJobs), same job name/payload shape so the
    // running worker's handleScrape picks it up unchanged.
    for (const s of targets) {
      const payload: ScrapePayload = { sourceName: s.name, sourceType: s.source_type, url: s.url };
      await scrapeQueue.add(s.name, payload);
    }
    res.status(200).json({ queued: targets.map((s) => s.name) });
  });

  router.post('/api/admin/reenrich', auth, async (req, res) => {
    const parsed = reenrichBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }
    const { job_ids, ...filter } = parsed.data;
    const ids = job_ids ?? (await selectJobIds(db, filter));
    for (const jobId of ids) {
      await enrichmentQueue.add('enrich', { jobId });
    }
    res.status(200).json({ queued: ids.length });
  });

  router.get('/api/sources', auth, (_req, res) => {
    res.status(200).json(sources);
  });

  router.get('/api/errors', auth, async (req, res) => {
    const parsed = errorsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    const rows = await listErrorsWindow(db, parsed.data);
    res.status(200).json({ errors: rows.map(toErrorResponse), count: rows.length });
  });

  return router;
}
