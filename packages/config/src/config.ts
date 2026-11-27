import { z } from 'zod';
import { CLAUDE_EFFORTS, type ClaudeEffort } from '@job-portal/ai';
import { LOG_LEVELS } from '@job-portal/shared';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** An empty variable counts as unset. */
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);

// An optional interval in minutes: unset or empty means the source is not scheduled.
const optionalInterval = z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).optional());

const optionalText = z.preprocess(emptyToUndefined, z.string().min(1).optional());

// The webhook address is a secret: the message never echoes the value.
const httpUrl = z.string().refine((v) => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}, 'must be an http or https URL');

// JSEARCH_API_KEYS is a secret: split without ever echoing the value in an error.
const keyList = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k !== '')
      : v,
  z.array(z.string()).optional(),
);

// Unset means linkedin and indeed, `any` means no publisher filter, an empty list is a mistake.
const DEFAULT_PUBLISHERS = ['linkedin', 'indeed'];
const publisherList = z
  .string()
  .optional()
  .transform((raw, ctx): string[] => {
    if (raw === undefined) return DEFAULT_PUBLISHERS;
    const list = raw
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p !== '');
    if (list.length === 0)
      ctx.addIssue({ code: 'custom', message: 'must name at least one publisher, or any' });
    if (list.length > 1 && list.includes('any'))
      ctx.addIssue({ code: 'custom', message: 'any cannot be combined with other publishers' });
    return list.length === 1 && list[0] === 'any' ? [] : list;
  });
// An ISO 3166 country or ISO 639 language code, lower case.
const isoCode = (what: string) =>
  z
    .string()
    .regex(/^[a-zA-Z]{2}$/, `must be a two-letter ${what} code`)
    .transform((v) => v.toLowerCase());

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    // Secrets come from env only, never from a file in the repo.
    MCP_BEARER_TOKEN: z.string().min(16),
    // Placeholder by default; the real address lives in the local .env only.
    SEED_USER_EMAIL: z.string().min(1).default('user@example.invalid'),
    // Loopback by default; set 0.0.0.0 only when something in front of it needs the port.
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    // The Bundesagentur search comes from the active Targets; the source is scheduled when its interval is set.
    BUNDESAGENTUR_INTERVAL_MINUTES: optionalInterval,
    // Bambase needs no search criteria, so it is scheduled when its interval is set (empty counts as unset).
    BAMBASE_INTERVAL_MINUTES: optionalInterval,
    // JSearch (LinkedIn, Indeed and more through Google for Jobs): scheduled when the interval is set and at
    // least one API key is. The keys are secrets; several keys let the Source switch to the next one when one is out of quota.
    JSEARCH_INTERVAL_MINUTES: optionalInterval,
    JSEARCH_API_KEYS: keyList,
    JSEARCH_PUBLISHERS: publisherList,
    JSEARCH_COUNTRY: z.preprocess(emptyToUndefined, isoCode('country').default('de')),
    JSEARCH_LANGUAGE: z.preprocess(emptyToUndefined, isoCode('language').optional()),
    // How many postings per Target per run the prerank passes on when neither the Target nor the Global defaults set it.
    PRERANK_TOP_N: z.coerce.number().int().min(1).default(20),
    // Company boards: each ATS is scheduled when its interval is set. Only marked boards of the
    // Board directory are fetched, at most this many requests per second to each ATS host.
    GREENHOUSE_INTERVAL_MINUTES: optionalInterval,
    LEVER_INTERVAL_MINUTES: optionalInterval,
    ASHBY_INTERVAL_MINUTES: optionalInterval,
    BOARD_REQUESTS_PER_SECOND: z.coerce.number().positive().default(2),
    // The AI runner for fit scoring; unset means no scoring. No fallback between runners.
    AI_RUNNER: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.enum(['openrouter', 'claude']).optional(),
    ),
    // Secret: from env only.
    OPENROUTER_API_KEY: optionalText,
    OPENROUTER_MODEL: optionalText,
    CLAUDE_BINARY_PATH: optionalText,
    CLAUDE_MODEL: optionalText,
    CLAUDE_EFFORT: z.preprocess(emptyToUndefined, z.enum(CLAUDE_EFFORTS).default('low')),
    // Score at or above this tags the Job with the Target, when neither the Target nor the Global defaults set one.
    // Most AI calls one run makes. A throughput limit, not a spend cap: pairs left over wait for the next run.
    AI_MAX_CALLS_PER_RUN: z.coerce.number().int().min(1).default(50),
    // Two Jobs of one company and city whose titles share at least this fraction of their words (Jaccard) go to the AI merge check.
    AI_MERGE_JACCARD: z.coerce.number().min(0).max(1).default(0.6),
    // Most AI merge checks one run makes. A throughput limit, not a spend cap: pairs left over wait for the next run.
    AI_MERGE_MAX_CALLS_PER_RUN: z.coerce.number().int().min(1).default(20),
    // Gmail reply reading: one inbox, read-only, with its own OAuth refresh token. All three secrets come from
    // env only, together or not at all; unset means the mail poll is skipped.
    GMAIL_CLIENT_ID: optionalText,
    GMAIL_CLIENT_SECRET: optionalText,
    GMAIL_REFRESH_TOKEN: optionalText,
    GMAIL_INTERVAL_MINUTES: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).default(15),
    ),
    // Mail received before this date is never read; unset means the first poll's time.
    GMAIL_START_DATE: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD')
        .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a real date')
        .optional(),
    ),
    // Most mail AI calls one poll makes. A throughput limit, not a spend cap: the rest waits for the next poll.
    AI_MAIL_MAX_CALLS_PER_RUN: z.coerce.number().int().min(1).default(20),
    GMAIL_MAX_READ_FAILURES: z.coerce.number().int().min(1).default(3),
    ALERT_THRESHOLD: z.coerce.number().int().min(0).max(100).default(70),
    // How often the Gone cold check runs, in minutes (default daily). The check itself is idempotent.
    GONE_COLD_INTERVAL_MINUTES: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).default(1440),
    ),
    // Digest and failure alerts go through the n8n webhook into a Telegram topic. Both are secrets or
    // private ids, from env only, with no default: unset means nothing is sent.
    NOTIFY_WEBHOOK_URL: z.preprocess(emptyToUndefined, httpUrl.optional()),
    NOTIFY_TOPIC_ID: optionalText,
    // Sends per message before it stays unsent, and the wait before the second send (it doubles after that).
    NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
    NOTIFY_BACKOFF_MS: z.coerce.number().int().min(0).default(1000),
  })
  .superRefine((e, ctx) => {
    const need = (name: keyof typeof e): void => {
      if (e[name] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `required when AI_RUNNER is ${e.AI_RUNNER ?? ''}`,
        });
    };
    if (e.AI_RUNNER === 'openrouter')
      (['OPENROUTER_API_KEY', 'OPENROUTER_MODEL'] as const).forEach(need);
    if (e.AI_RUNNER === 'claude') need('CLAUDE_MODEL');
    // Settings that only make sense together: when one is set the others are required.
    const together = (keys: readonly (keyof typeof e)[]): void => {
      const set = keys.find((k) => e[k] !== undefined);
      if (set === undefined) return;
      for (const k of keys)
        if (e[k] === undefined)
          ctx.addIssue({ code: 'custom', path: [k], message: `required when ${set} is set` });
    };
    together(['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']);
    together(['NOTIFY_WEBHOOK_URL', 'NOTIFY_TOPIC_ID']);
  });

export interface IntervalConfig {
  intervalMinutes: number;
}

const interval = (minutes: number | undefined): IntervalConfig | null =>
  minutes === undefined ? null : { intervalMinutes: minutes };

/** The configured AI runner, with only the settings that runner needs. */
export type AiConfig =
  | { runner: 'openrouter'; apiKey: string; model: string }
  | { runner: 'claude'; binaryPath: string; model: string; effort: ClaudeEffort };

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  mcpBearerToken: string;
  seedUserEmail: string;
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  /** One entry per source; null means the source is not configured and is never scheduled. */
  sources: {
    bundesagentur: IntervalConfig | null;
    bambase: IntervalConfig | null;
    greenhouse: IntervalConfig | null;
    lever: IntervalConfig | null;
    ashby: IntervalConfig | null;
    jsearch: JsearchConfig | null;
  };
  /** Minutes between Gone cold checks, an integer of at least 1. */
  goneColdIntervalMinutes: number;
  /** Default prerank_top_n, an integer of at least 1. */
  prerankTopN: number;
  /** Requests per second to each ATS host, a positive number. */
  boardRequestsPerSecond: number;
  /** null means no AI runner is configured and nothing is scored. */
  ai: AiConfig | null;
  /** Most AI calls one run makes, an integer of at least 1; the rest wait for the next run. */
  aiMaxCallsPerRun: number;
  /** Title word overlap (Jaccard, 0 to 1) that sends two Jobs to the AI merge check. */
  aiMergeJaccard: number;
  /** Most AI merge checks one run makes, an integer of at least 1. */
  aiMergeMaxCallsPerRun: number;
  /** null means Gmail is not configured and the mail poll is skipped. */
  gmail: GmailConfig | null;
  /** Most mail AI calls one poll makes, an integer of at least 1. */
  aiMailMaxCallsPerRun: number;
  /** Failed reads of one Gmail message before it is given up on. */
  gmailMaxReadFailures: number;
  /** Default alert threshold, 0 to 100. */
  alertThreshold: number;
  /** null means no webhook is configured and nothing is sent. */
  notifications: NotificationsConfig | null;
}

export interface JsearchConfig extends IntervalConfig {
  /** At least one. Secrets, named by position everywhere else. */
  apiKeys: string[];
  /** Lower-case publisher names, one search per publisher, empty meaning no publisher filter. */
  publishers: string[];
  /** Lower-case ISO country code. */
  country: string;
  /** Lower-case ISO language code, null when the search sends none. */
  language: string | null;
}

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  intervalMinutes: number;
  /** Mail received before this instant is never read; null means the first poll's time. */
  startDate: Date | null;
}

export interface NotificationsConfig {
  webhookUrl: string;
  topicId: string;
  /** Sends per message before it stays unsent, at least 1. */
  maxAttempts: number;
  /** Wait before the second send in milliseconds; it doubles after that. */
  backoffMs: number;
}

function aiConfig(e: z.infer<typeof envSchema>): AiConfig | null {
  // superRefine has already made sure the settings of the chosen runner are there.
  if (e.AI_RUNNER === 'openrouter') {
    return {
      runner: 'openrouter',
      apiKey: e.OPENROUTER_API_KEY ?? '',
      model: e.OPENROUTER_MODEL ?? '',
    };
  }
  if (e.AI_RUNNER === 'claude') {
    return {
      runner: 'claude',
      binaryPath: e.CLAUDE_BINARY_PATH ?? 'claude',
      model: e.CLAUDE_MODEL ?? '',
      effort: e.CLAUDE_EFFORT,
    };
  }
  return null;
}

/** Validates the environment once at process start; throws ConfigError naming each bad variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment: ${issues}`);
  }
  const e = result.data;
  const jsearchKeys = e.JSEARCH_API_KEYS ?? [];
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    mcpBearerToken: e.MCP_BEARER_TOKEN,
    seedUserEmail: e.SEED_USER_EMAIL,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    sources: {
      bundesagentur: interval(e.BUNDESAGENTUR_INTERVAL_MINUTES),
      bambase: interval(e.BAMBASE_INTERVAL_MINUTES),
      greenhouse: interval(e.GREENHOUSE_INTERVAL_MINUTES),
      lever: interval(e.LEVER_INTERVAL_MINUTES),
      ashby: interval(e.ASHBY_INTERVAL_MINUTES),
      jsearch:
        e.JSEARCH_INTERVAL_MINUTES === undefined || jsearchKeys.length === 0
          ? null
          : {
              intervalMinutes: e.JSEARCH_INTERVAL_MINUTES,
              apiKeys: jsearchKeys,
              publishers: e.JSEARCH_PUBLISHERS,
              country: e.JSEARCH_COUNTRY,
              language: e.JSEARCH_LANGUAGE ?? null,
            },
    },
    goneColdIntervalMinutes: e.GONE_COLD_INTERVAL_MINUTES,
    prerankTopN: e.PRERANK_TOP_N,
    boardRequestsPerSecond: e.BOARD_REQUESTS_PER_SECOND,
    ai: aiConfig(e),
    aiMaxCallsPerRun: e.AI_MAX_CALLS_PER_RUN,
    aiMergeJaccard: e.AI_MERGE_JACCARD,
    aiMergeMaxCallsPerRun: e.AI_MERGE_MAX_CALLS_PER_RUN,
    alertThreshold: e.ALERT_THRESHOLD,
    // superRefine has already made sure the three secrets come together.
    gmail:
      e.GMAIL_CLIENT_ID === undefined ||
      e.GMAIL_CLIENT_SECRET === undefined ||
      e.GMAIL_REFRESH_TOKEN === undefined
        ? null
        : {
            clientId: e.GMAIL_CLIENT_ID,
            clientSecret: e.GMAIL_CLIENT_SECRET,
            refreshToken: e.GMAIL_REFRESH_TOKEN,
            intervalMinutes: e.GMAIL_INTERVAL_MINUTES,
            startDate:
              e.GMAIL_START_DATE === undefined ? null : new Date(`${e.GMAIL_START_DATE}T00:00:00Z`),
          },
    aiMailMaxCallsPerRun: e.AI_MAIL_MAX_CALLS_PER_RUN,
    gmailMaxReadFailures: e.GMAIL_MAX_READ_FAILURES,
    // superRefine has already made sure the two settings come together.
    notifications:
      e.NOTIFY_WEBHOOK_URL === undefined || e.NOTIFY_TOPIC_ID === undefined
        ? null
        : {
            webhookUrl: e.NOTIFY_WEBHOOK_URL,
            topicId: e.NOTIFY_TOPIC_ID,
            maxAttempts: e.NOTIFY_MAX_ATTEMPTS,
            backoffMs: e.NOTIFY_BACKOFF_MS,
          },
  };
}
