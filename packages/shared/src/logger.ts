import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Process name (api, worker) attached to every log line. */
  name?: string;
}

/** Structured JSON logger to stdout. */
export function createLogger({ level = 'info', name }: CreateLoggerOptions = {}): Logger {
  return pino({ level, name, timestamp: pino.stdTimeFunctions.isoTime });
}
