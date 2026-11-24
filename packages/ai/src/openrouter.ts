import { z } from 'zod';
import { AiError, type AiErrorClass, type AiResult, type AiRunner } from './runner';

export interface OpenRouterOptions {
  /** Secret: from env only. */
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 90_000;

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

const classOf = (status: number): AiErrorClass => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'cap';
  if (status === 429) return 'rate_limit';
  return status >= 500 ? 'provider' : 'request';
};

/** OpenRouter's chat completions API over plain HTTP. */
export function createOpenRouterRunner({
  apiKey,
  model,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetch: doFetch = fetch,
}: OpenRouterOptions): AiRunner {
  return {
    name: 'openrouter',
    async complete(prompt): Promise<AiResult> {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        throw new AiError(
          timedOut ? 'timeout' : 'network',
          timedOut ? 'request timed out' : 'request failed',
        );
      }
      if (!res.ok)
        throw new AiError(classOf(res.status), `OpenRouter answered HTTP ${String(res.status)}`);
      let parsed: z.infer<typeof responseSchema>;
      try {
        parsed = responseSchema.parse(await res.json());
      } catch {
        throw new AiError('bad_output', 'OpenRouter answer has an unexpected shape');
      }
      const text = parsed.choices[0]?.message.content;
      if (text === undefined || text === null || text === '') {
        throw new AiError('bad_output', 'OpenRouter answer has no text');
      }
      return {
        text,
        model: parsed.model ?? model,
        inputTokens: parsed.usage?.prompt_tokens ?? null,
        outputTokens: parsed.usage?.completion_tokens ?? null,
        costUsd: parsed.usage?.cost ?? null,
      };
    },
  };
}
