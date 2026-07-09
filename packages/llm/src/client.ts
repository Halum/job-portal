/**
 * OpenRouter client (PRD §11). Uses the OpenAI SDK pointed at OpenRouter's
 * base URL — OpenRouter is API-compatible with the OpenAI chat completions
 * shape.
 */

import OpenAI from 'openai';

export interface FilterPassOutput {
  should_notify: boolean;
  reason: string;
}

export interface SummaryPassOutput {
  summary_en: string;
  key_points: string[];
}

export interface LlmCallInput {
  model: string;
  max_tokens: number;
  temperature: number;
  prompt: string;
}

export interface LlmClient {
  filter(input: LlmCallInput): Promise<FilterPassOutput>;
  summary(input: LlmCallInput): Promise<SummaryPassOutput>;
}

async function callJson(client: OpenAI, input: LlmCallInput): Promise<unknown> {
  const completion = await client.chat.completions.create({
    model: input.model,
    max_tokens: input.max_tokens,
    temperature: input.temperature,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: input.prompt }],
  });
  const content = completion.choices[0]?.message.content ?? '';
  return JSON.parse(content) as unknown;
}

function isFilterPassOutput(value: unknown): value is FilterPassOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FilterPassOutput).should_notify === 'boolean' &&
    typeof (value as FilterPassOutput).reason === 'string'
  );
}

/**
 * Builds the OpenRouter-backed LLM client (PRD §11). `filter` validates the
 * parsed shape strictly — a malformed filter response throws so BullMQ
 * retries the enrichment job. `summary` is returned as-is per PRD §11 step 6
 * (soft convention, no deep validation).
 */
export function createLlmClient({ apiKey }: { apiKey: string }): LlmClient {
  const client = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });

  return {
    async filter(input) {
      const parsed = await callJson(client, input);
      if (!isFilterPassOutput(parsed)) {
        throw new Error('LLM filter response is missing should_notify/reason');
      }
      return parsed;
    },

    async summary(input) {
      return (await callJson(client, input)) as SummaryPassOutput;
    },
  };
}
