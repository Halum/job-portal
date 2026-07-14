import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { ZodError, ZodTypeAny, z } from 'zod';
import { ConfigError } from '@job-portal/shared';
import {
  appConfigFileSchema,
  envSchema,
  sourcesFileSchema,
  type AppConfig,
} from './schema.js';

function formatZodError(context: string, error: ZodError): string {
  const issues = error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  return `Invalid ${context}:\n${issues}`;
}

function parseWithSchema<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  context: string,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(formatZodError(context, result.error), { cause: result.error });
  }
  return result.data;
}

function readYamlFile(path: string, context: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Could not read ${context} at ${path}: ${(cause as Error).message}`, {
      cause,
    });
  }
  try {
    return parseYaml(raw);
  } catch (cause) {
    throw new ConfigError(`Could not parse ${context} at ${path} as YAML: ${(cause as Error).message}`, {
      cause,
    });
  }
}

export interface LoadConfigOptions {
  /** Path to the sources YAML file. Defaults to config/sources.yaml. */
  sourcesPath?: string;
  /** Path to the app YAML file. Defaults to config/app.yaml. */
  appConfigPath?: string;
  /** Env object to validate. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Loads and validates all process configuration: sources.yaml, app.yaml, and
 * environment variables. Throws ConfigError with a human-readable message on
 * any failure — callers at the process entrypoint should catch this, log it,
 * and exit(1) rather than let the process start half-configured.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const {
    sourcesPath = 'config/sources.yaml',
    appConfigPath = 'config/app.yaml',
    env = process.env,
  } = options;

  const parsedEnv = parseWithSchema(envSchema, env, 'environment variables');

  const sourcesRaw = readYamlFile(sourcesPath, 'sources config');
  const sourcesFile = parseWithSchema(sourcesFileSchema, sourcesRaw, 'config/sources.yaml');

  const appRaw = readYamlFile(appConfigPath, 'app config');
  const appFile = parseWithSchema(appConfigFileSchema, appRaw, 'config/app.yaml');

  return {
    env: parsedEnv,
    sources: sourcesFile.sources,
    app: appFile,
  };
}

/**
 * Loads config and, on failure, prints a clear error to stderr and exits the
 * process with code 1. Intended for use at process entrypoints (apps/api,
 * apps/worker) where a misconfigured process must fail fast and loud.
 */
export function loadConfigOrExit(options: LoadConfigOptions = {}): AppConfig {
  try {
    return loadConfig(options);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    console.error(`[config] fatal: ${message}`);
    process.exit(1);
  }
}
