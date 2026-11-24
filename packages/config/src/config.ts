import { z } from 'zod';
import { LOG_LEVELS } from '@job-portal/shared';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// An optional interval in minutes: unset or empty means the source is not scheduled.
const optionalInterval = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce.number().int().min(1).optional(),
);

const optionalText = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

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
    CLAUDE_EFFORT: z.preprocess((v) => (v === '' ? undefined : v), z.enum(EFFORTS).default('low')),
    // Score at or above this tags the Job with the Target, when neither the Target nor the Global defaults set one.
    ALERT_THRESHOLD: z.coerce.number().int().min(0).max(100).default(70),
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
  });

export interface IntervalConfig {
  intervalMinutes: number;
}

const interval = (minutes: number | undefined): IntervalConfig | null =>
  minutes === undefined ? null : { intervalMinutes: minutes };

/** The configured AI runner, with only the settings that runner needs. */
export type AiConfig =
  | { runner: 'openrouter'; apiKey: string; model: string }
  | { runner: 'claude'; binaryPath: string; model: string; effort: (typeof EFFORTS)[number] };

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
  /** Default prerank_top_n, an integer of at least 1. */
  prerankTopN: number;
  /** Requests per second to each ATS host, a positive number. */
  boardRequestsPerSecond: number;
  /** null means no AI runner is configured and nothing is scored. */
  ai: AiConfig | null;
  /** Default alert threshold, 0 to 100. */
  alertThreshold: number;
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
    prerankTopN: e.PRERANK_TOP_N,
    boardRequestsPerSecond: e.BOARD_REQUESTS_PER_SECOND,
    ai: aiConfig(e),
    alertThreshold: e.ALERT_THRESHOLD,
  };
}
