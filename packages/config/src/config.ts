import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Secrets come from env only, never from a file in the repo.
  MCP_BEARER_TOKEN: z.string().min(16),
  // Placeholder by default; the real address lives in the local .env only.
  SEED_USER_EMAIL: z.string().min(1).default('user@example.invalid'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  mcpBearerToken: string;
  seedUserEmail: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
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
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
  };
}
