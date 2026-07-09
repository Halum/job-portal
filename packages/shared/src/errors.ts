/**
 * Base class for all application errors. Carries a machine-readable `code`
 * and an `isOperational` flag distinguishing expected failures (bad input,
 * upstream timeout) from programmer errors that should crash the process.
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly isOperational: boolean;
  public override readonly cause?: unknown;

  constructor(
    message: string,
    options: { code?: string; isOperational?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code ?? 'APP_ERROR';
    this.isOperational = options.isOperational ?? true;
    this.cause = options.cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/** Thrown when process configuration (env vars, YAML) fails validation. */
export class ConfigError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: 'CONFIG_ERROR', isOperational: true, cause: options.cause });
  }
}

/** Thrown when a request fails authentication or authorization checks. */
export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, { code: 'AUTH_ERROR', isOperational: true });
  }
}

/** Thrown when a requested resource does not exist. */
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, { code: 'NOT_FOUND', isOperational: true });
  }
}

/** Thrown when a dependency (Postgres, Redis, OpenRouter) is unreachable. */
export class DependencyError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: 'DEPENDENCY_ERROR', isOperational: true, cause: options.cause });
  }
}
