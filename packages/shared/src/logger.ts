import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Process name (api, worker) attached to every log line. */
  name?: string;
  /** Where lines go; stdout by default. Tests inject a collector. */
  destination?: { write: (line: string) => void };
}

/** Structured JSON logger to stdout. */
export function createLogger({
  level = 'info',
  name,
  destination,
}: CreateLoggerOptions = {}): Logger {
  return pino({ level, name, timestamp: pino.stdTimeFunctions.isoTime }, destination);
}
