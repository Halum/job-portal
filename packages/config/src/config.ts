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
    ALERT_THRESHOLD: z.coerce.number().int().min(0).max(100).default(70),
    // Digest and failure alerts go through the n8n webhook into a Telegram topic. Both are secrets or
    // private ids, from env only, with no default: unset means nothing is sent.
    // How often the Gone cold check runs, in minutes (default daily). The check itself is idempotent.
    GONE_COLD_INTERVAL_MINUTES: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).default(1440),
    ),
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
    // The webhook URL and the topic id only make sense together.
    for (const [set, missing] of [
      ['NOTIFY_WEBHOOK_URL', 'NOTIFY_TOPIC_ID'],
      ['NOTIFY_TOPIC_ID', 'NOTIFY_WEBHOOK_URL'],
    ] as const)
      if (e[set] !== undefined && e[missing] === undefined)
        ctx.addIssue({ code: 'custom', path: [missing], message: `required when ${set} is set` });
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
  /** Default alert threshold, 0 to 100. */
  alertThreshold: number;
  /** null means no webhook is configured and nothing is sent. */
  notifications: NotificationsConfig | null;
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
    },
    goneColdIntervalMinutes: e.GONE_COLD_INTERVAL_MINUTES,
    prerankTopN: e.PRERANK_TOP_N,
    boardRequestsPerSecond: e.BOARD_REQUESTS_PER_SECOND,
    ai: aiConfig(e),
    aiMaxCallsPerRun: e.AI_MAX_CALLS_PER_RUN,
    aiMergeJaccard: e.AI_MERGE_JACCARD,
    aiMergeMaxCallsPerRun: e.AI_MERGE_MAX_CALLS_PER_RUN,
    alertThreshold: e.ALERT_THRESHOLD,
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
