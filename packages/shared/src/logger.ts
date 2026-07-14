import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export interface CreateLoggerOptions {
  /** Value of LOG_LEVEL: debug | info | warn | error. Defaults to 'info'. */
  level?: string;
  /** Logical name of the process (api, worker, ...) attached to every log line. */
  name?: string;
}

/**
 * Creates a pino logger configured for structured JSON logging to stdout.
 * Docker captures stdout; we deliberately never write to files here.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { level = 'info', name } = options;

  const opts: LoggerOptions = {
    level,
    name,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return pino(opts);
}
