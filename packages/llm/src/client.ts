/**
 * OpenRouter client (PRD §11). Uses the OpenAI SDK pointed at OpenRouter's
 * base URL — OpenRouter is API-compatible with the OpenAI chat completions
 * shape.
 */

import OpenAI from 'openai';

export const GERMAN_REQUIREMENT = ['NONE', 'OPTIONAL', 'REQUIRED'] as const;
export type GermanRequirement = (typeof GERMAN_REQUIREMENT)[number];

/**
 * The filter pass EXTRACTS, it does not decide. It reports what the posting says
 * about the candidate's German, and the caller derives should_notify from
 * `german_requirement`.
 *
 * Asking the model for the boolean directly was measurably unreliable: on a real
 * posting it quoted "Deutsch (Wort und Schrift)", correctly reasoned that German
 * was required, then returned should_notify: true anyway. Extraction it can do;
 * polarity it cannot. Deriving the boolean in code makes that contradiction
 * unrepresentable.
 */
export interface FilterPassOutput {
  german_phrase: string | null;
  german_requirement: GermanRequirement;
  reason: string;
}

/** The filter's verdict — German demanded of the candidate means don't notify. */
export function shouldNotify(output: FilterPassOutput): boolean {
  return output.german_requirement !== 'REQUIRED';
}

export interface SummaryPassOutput {
  // Source postings are German; the summary pass translates. `jobs.title` keeps
  // the original German title (needed to search/apply) — this is display-only.
  title_en: string;
  summary_en: string;
  key_points: string[];
}

export interface LlmCallInput {
  model: string;
  max_tokens: number;
  temperature: number;
  prompt: string;
}

/** OpenRouter's `usage.cost_details` extension — not in the OpenAI SDK's types. */
export interface LlmCostDetails {
  model: string;
  cost: number | null;
  upstream_inference_cost: number | null;
  upstream_inference_prompt_cost: number | null;
  upstream_inference_completions_cost: number | null;
}

export interface LlmClient {
  filter(input: LlmCallInput): Promise<{ output: FilterPassOutput; cost: LlmCostDetails }>;
  summary(input: LlmCallInput): Promise<{ output: SummaryPassOutput; cost: LlmCostDetails }>;
}

async function callJson(
  client: OpenAI,
  input: LlmCallInput,
): Promise<{ parsed: unknown; cost: LlmCostDetails }> {
  const completion = await client.chat.completions.create({
    model: input.model,
    max_tokens: input.max_tokens,
    temperature: input.temperature,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: input.prompt }],
  });
  const content = completion.choices[0]?.message.content ?? '';
  const usage = completion.usage as
    | (OpenAI.CompletionUsage & {
        cost?: number;
        cost_details?: {
          upstream_inference_cost?: number | null;
          upstream_inference_prompt_cost?: number | null;
          upstream_inference_completions_cost?: number | null;
        };
      })
    | undefined;
  const cost: LlmCostDetails = {
    // completion.model is what OpenRouter actually routed to, which can
    // differ from the requested model on provider fallback.
    model: completion.model || input.model,
    cost: usage?.cost ?? null,
    upstream_inference_cost: usage?.cost_details?.upstream_inference_cost ?? null,
    upstream_inference_prompt_cost: usage?.cost_details?.upstream_inference_prompt_cost ?? null,
    upstream_inference_completions_cost:
      usage?.cost_details?.upstream_inference_completions_cost ?? null,
  };
  return { parsed: JSON.parse(stripFence(content)) as unknown, cost };
}

/** Models sometimes wrap JSON in a ```json fence despite response_format. */
function stripFence(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function isFilterPassOutput(value: unknown): value is FilterPassOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as FilterPassOutput;
  const phrase = v.german_phrase;
  return (
    (typeof phrase === 'string' || phrase === null) &&
    GERMAN_REQUIREMENT.includes(v.german_requirement) &&
    typeof v.reason === 'string'
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
      const { parsed, cost } = await callJson(client, input);
      if (!isFilterPassOutput(parsed)) {
        throw new Error(
          'LLM filter response must have german_requirement (NONE|OPTIONAL|REQUIRED), german_phrase, reason',
        );
      }
      return { output: parsed, cost };
    },

    async summary(input) {
      const { parsed, cost } = await callJson(client, input);
      return { output: parsed as SummaryPassOutput, cost };
    },
  };
}
