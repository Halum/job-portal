import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { JOB_STATUSES } from '@job-portal/shared';
import { getJobById, listJobsWindow, type Database, type Job } from '@job-portal/db';

const EPOCH = new Date(0);

const windowQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).default('matched'),
  source: z.string().min(1).optional(),
  from: z.coerce.date().default(EPOCH),
  to: z.coerce.date().default(() => new Date()),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Maps a drizzle Job row (camelCase) to the snake_case wire contract n8n
 * consumes (PRD §12). List items omit `raw`; the detail view adds it. */
function toJobResponse(job: Job) {
  return {
    id: job.id,
    source: job.source,
    external_id: job.externalId,
    title: job.title,
    company: job.company,
    location: job.location,
    posted_at: job.postedAt,
    apply_url: job.applyUrl,
    enriched_at: job.enrichedAt,
    enrichment_json: job.enrichmentJson,
  };
}

/**
 * Pull API (PRD §12): fixed time-window pagination on `enriched_at` so n8n's
 * stateless offset loop is deterministic within a window. Behind bearer auth.
 */
export function createJobsRouter(auth: RequestHandler, db: Database): Router {
  const router = Router();

  router.get('/api/jobs', auth, async (req, res) => {
    const parsed = windowQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    const rows = await listJobsWindow(db, parsed.data);
    res.status(200).json({ jobs: rows.map(toJobResponse), count: rows.length });
  });

  router.get('/api/jobs/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const job = await getJobById(db, id);
    if (!job) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Full detail: wire contract fields + raw adapter payload (PRD §12).
    res.status(200).json({ ...toJobResponse(job), raw: job.raw, status: job.status });
  });

  return router;
}
