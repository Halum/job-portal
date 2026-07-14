import { describe, expect, it, vi } from 'vitest';

const create = vi.fn();

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create } };
  },
}));

const { createLlmClient, shouldNotify } = await import('../src/client.js');

const input = { model: 'm', max_tokens: 100, temperature: 0.2, prompt: 'p' };

function completionWith(content: string, usage?: Record<string, unknown>) {
  return { choices: [{ message: { content } }], usage };
}

describe('createLlmClient.filter', () => {
  it('parses a well-formed filter response', async () => {
    create.mockResolvedValueOnce(
      completionWith(
        JSON.stringify({
          german_phrase: 'Deutsch (Wort und Schrift)',
          german_requirement: 'REQUIRED',
          reason: 'German is listed under requirements',
        }),
      ),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).resolves.toEqual({
      output: {
        german_phrase: 'Deutsch (Wort und Schrift)',
        german_requirement: 'REQUIRED',
        reason: 'German is listed under requirements',
      },
      cost: {
        model: 'm',
        cost: null,
        upstream_inference_cost: null,
        upstream_inference_prompt_cost: null,
        upstream_inference_completions_cost: null,
      },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'm',
        max_tokens: 100,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'p' }],
      }),
    );
  });

  it('accepts a null german_phrase when nothing was found', async () => {
    create.mockResolvedValueOnce(
      completionWith(
        JSON.stringify({ german_phrase: null, german_requirement: 'NONE', reason: 'no mention' }),
      ),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    const { output } = await llm.filter(input);
    expect(output.german_requirement).toBe('NONE');
    expect(output.german_phrase).toBeNull();
  });

  it('strips a markdown fence before parsing', async () => {
    create.mockResolvedValueOnce(
      completionWith(
        '```json\n{"german_phrase":null,"german_requirement":"NONE","reason":"none"}\n```',
      ),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    const { output } = await llm.filter(input);
    expect(output.german_requirement).toBe('NONE');
  });

  it('throws when german_requirement is missing', async () => {
    create.mockResolvedValueOnce(
      completionWith(JSON.stringify({ german_phrase: null, reason: 'no verdict' })),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).rejects.toThrow();
  });

  it('throws when german_requirement is not one of the three enum values', async () => {
    create.mockResolvedValueOnce(
      completionWith(
        JSON.stringify({ german_phrase: null, german_requirement: 'MAYBE', reason: 'r' }),
      ),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).rejects.toThrow();
  });

  it('rejects the old should_notify shape — the model must not decide the verdict', async () => {
    create.mockResolvedValueOnce(
      completionWith(JSON.stringify({ should_notify: true, reason: 'matches criteria' })),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).rejects.toThrow();
  });

  it('throws on unparsable content', async () => {
    create.mockResolvedValueOnce(completionWith('not json'));
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).rejects.toThrow();
  });
});

describe('shouldNotify', () => {
  const base = { german_phrase: null, reason: 'r' };

  it('REQUIRED means do not notify', () => {
    expect(shouldNotify({ ...base, german_requirement: 'REQUIRED' })).toBe(false);
  });

  // The regression that motivated moving the verdict out of the model: it quoted
  // "Deutsch (Wort und Schrift)", reasoned German WAS required, then returned
  // should_notify: true. Deriving the boolean here makes that unrepresentable.
  it('OPTIONAL and NONE both notify', () => {
    expect(shouldNotify({ ...base, german_requirement: 'OPTIONAL' })).toBe(true);
    expect(shouldNotify({ ...base, german_requirement: 'NONE' })).toBe(true);
  });
});

describe('createLlmClient.summary', () => {
  it('returns the parsed response as-is, no validation', async () => {
    create.mockResolvedValueOnce(
      completionWith(JSON.stringify({ summary_en: 'a summary', key_points: ['a', 'b'] })),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.summary(input)).resolves.toEqual({
      output: { summary_en: 'a summary', key_points: ['a', 'b'] },
      cost: {
        model: 'm',
        cost: null,
        upstream_inference_cost: null,
        upstream_inference_prompt_cost: null,
        upstream_inference_completions_cost: null,
      },
    });
  });

  it('extracts OpenRouter cost_details and the routed model when present', async () => {
    create.mockResolvedValueOnce({
      ...completionWith(JSON.stringify({ summary_en: 's', key_points: [] }), {
        cost: 0.0001,
        cost_details: {
          upstream_inference_cost: 0.0001,
          upstream_inference_prompt_cost: 0.00002,
          upstream_inference_completions_cost: 0.00008,
        },
      }),
      model: 'meta-llama/llama-3.1-8b-instruct',
    });
    const llm = createLlmClient({ apiKey: 'k' });
    const result = await llm.summary(input);
    expect(result.cost).toEqual({
      model: 'meta-llama/llama-3.1-8b-instruct',
      cost: 0.0001,
      upstream_inference_cost: 0.0001,
      upstream_inference_prompt_cost: 0.00002,
      upstream_inference_completions_cost: 0.00008,
    });
  });
});
