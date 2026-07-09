import { z } from 'zod';
import { SOURCE_TYPES } from '@job-portal/shared';

/** A single 5-field cron expression, e.g. "0 star-slash-6 * * *". Loose check
 * — full validity (day ranges etc.) is BullMQ/cron-parser's job at
 * registration time. */
const cronSchema = z
  .string()
  .refine((value) => value.trim().split(/\s+/).length === 5, {
    message: 'cron must be a 5-field cron expression',
  });

export const sourceTypeSchema = z.enum(SOURCE_TYPES);

export const sourceEntrySchema = z.object({
  name: z.string().min(1),
  source_type: sourceTypeSchema,
  url: z.string().url(),
  cron: cronSchema,
  enabled: z.boolean(),
});

export const sourcesFileSchema = z.object({
  sources: z.array(sourceEntrySchema).min(1),
});

const llmModelConfigSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
});

const retryConfigSchema = z.object({
  attempts: z.number().int().positive(),
  backoff_ms: z.number().int().nonnegative(),
});

export const appConfigFileSchema = z.object({
  llm: z.object({
    filter: llmModelConfigSchema,
    summary: llmModelConfigSchema,
    global_concurrency: z.number().int().positive(),
    rate_limit: z.object({
      max_per_window: z.number().int().positive(),
      window_ms: z.number().int().positive(),
    }),
  }),
  retries: z.object({
    scrape: retryConfigSchema,
    enrichment: retryConfigSchema,
    webhook_error: retryConfigSchema,
  }),
  n8n: z.object({
    error_webhook_url: z.string().url(),
  }),
  timezone: z.string().min(1),
});

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  OPENROUTER_API_KEY: z.string().default(''),
  API_BEARER_TOKEN: z.string().min(1, 'API_BEARER_TOKEN is required'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type SourceEntry = z.infer<typeof sourceEntrySchema>;
export type SourcesFile = z.infer<typeof sourcesFileSchema>;
export type AppConfigFile = z.infer<typeof appConfigFileSchema>;
export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env;
  sources: SourceEntry[];
  app: AppConfigFile;
}
