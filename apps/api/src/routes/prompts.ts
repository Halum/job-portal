import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { PROMPT_ROLES, SOURCE_TYPES } from '@job-portal/shared';
import { getPrompt, upsertPrompt, type Database } from '@job-portal/db';

const listQuerySchema = z.object({
  source: z.enum(SOURCE_TYPES),
  role: z.enum(PROMPT_ROLES),
});

const upsertBodySchema = z.object({
  source: z.enum(SOURCE_TYPES),
  role: z.enum(PROMPT_ROLES),
  template: z.string().min(1),
});

/**
 * Admin prompt CRUD (PRD §11/§12, destructive: one row per source+role).
 * Behind bearer auth. Routes call the db repository directly — no service
 * layer yet (route → service → repository is the documented growth path).
 */
export function createPromptsRouter(auth: RequestHandler, db: Database): Router {
  const router = Router();

  router.get('/api/prompts', auth, async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    const row = await getPrompt(db, parsed.data.source, parsed.data.role);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(200).json(row);
  });

  router.post('/api/prompts', auth, async (req, res) => {
    const parsed = upsertBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }
    const row = await upsertPrompt(db, parsed.data);
    res.status(200).json(row);
  });

  return router;
}
