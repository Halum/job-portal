export const AI_ERROR_CLASSES = [
  'auth',
  'cap',
  'rate_limit',
  'provider',
  'request',
  'network',
  'timeout',
  'bad_output',
  'spawn',
  'exit',
  'not_logged_in',
] as const;
export type AiErrorClass = (typeof AI_ERROR_CLASSES)[number];

/** A failed AI call. The message never holds the prompt or a key, so it is safe to store and show. */
export class AiError extends Error {
  override name = 'AiError';
  constructor(
    readonly errorClass: AiErrorClass,
    message: string,
  ) {
    super(message);
  }
}

export interface AiResult {
  text: string;
  /** The model that answered, as the runner reports it (OpenRouter may route elsewhere). */
  model: string;
  /** null when the runner does not report it. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** US dollars; null when the runner does not report a cost (0 is a real cost). */
  costUsd: number | null;
}

/** The one interface behind every AI call: a prompt in, text out, or an AiError. */
export interface AiRunner {
  /** Which implementation this is, for the call log. */
  readonly name: 'openrouter' | 'claude';
  complete: (prompt: string) => Promise<AiResult>;
}
