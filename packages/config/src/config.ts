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

const envSchema = z.object({
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
  // API parameters for the Bundesagentur search (for example `wo=Musterstadt&umkreis=25`). The
  // source is scheduled only when this is set; the real value lives in the local .env only.
  BUNDESAGENTUR_QUERY: z.string().optional(),
  BUNDESAGENTUR_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(60),
  // Bambase needs no search criteria, so it is scheduled when its interval is set (empty counts as unset).
  BAMBASE_INTERVAL_MINUTES: optionalInterval,
  // Company boards: each ATS is scheduled when its interval is set. Only marked boards of the
  // Board directory are fetched, at most this many requests per second to each ATS host.
  GREENHOUSE_INTERVAL_MINUTES: optionalInterval,
  LEVER_INTERVAL_MINUTES: optionalInterval,
  ASHBY_INTERVAL_MINUTES: optionalInterval,
  BOARD_REQUESTS_PER_SECOND: z.coerce.number().positive().default(2),
});

export interface SourceConfig {
  query: string;
  intervalMinutes: number;
}

export interface IntervalConfig {
  intervalMinutes: number;
}

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
    bundesagentur: SourceConfig | null;
    bambase: IntervalConfig | null;
    greenhouse: IntervalConfig | null;
    lever: IntervalConfig | null;
    ashby: IntervalConfig | null;
  };
  /** Requests per second to each ATS host, a positive number. */
  boardRequestsPerSecond: number;
}

const interval = (minutes: number | undefined): IntervalConfig | null =>
  minutes === undefined ? null : { intervalMinutes: minutes };

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
      bundesagentur:
        e.BUNDESAGENTUR_QUERY === undefined || e.BUNDESAGENTUR_QUERY === ''
          ? null
          : { query: e.BUNDESAGENTUR_QUERY, intervalMinutes: e.BUNDESAGENTUR_INTERVAL_MINUTES },
      bambase: interval(e.BAMBASE_INTERVAL_MINUTES),
      greenhouse: interval(e.GREENHOUSE_INTERVAL_MINUTES),
      lever: interval(e.LEVER_INTERVAL_MINUTES),
      ashby: interval(e.ASHBY_INTERVAL_MINUTES),
    },
    boardRequestsPerSecond: e.BOARD_REQUESTS_PER_SECOND,
  };
}
