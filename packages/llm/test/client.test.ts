import { describe, expect, it, vi } from 'vitest';

const create = vi.fn();

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create } };
  },
}));

const { createLlmClient } = await import('../src/client.js');

const input = { model: 'm', max_tokens: 100, temperature: 0.2, prompt: 'p' };

function completionWith(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('createLlmClient.filter', () => {
  it('parses a well-formed filter response', async () => {
    create.mockResolvedValueOnce(
      completionWith(JSON.stringify({ should_notify: true, reason: 'matches criteria' })),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).resolves.toEqual({
      should_notify: true,
      reason: 'matches criteria',
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

  it('throws when should_notify is missing', async () => {
    create.mockResolvedValueOnce(completionWith(JSON.stringify({ reason: 'no should_notify' })));
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).rejects.toThrow();
  });

  it('throws when reason is missing', async () => {
    create.mockResolvedValueOnce(completionWith(JSON.stringify({ should_notify: false })));
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).rejects.toThrow();
  });

  it('throws on unparsable content', async () => {
    create.mockResolvedValueOnce(completionWith('not json'));
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.filter(input)).rejects.toThrow();
  });
});

describe('createLlmClient.summary', () => {
  it('returns the parsed response as-is, no validation', async () => {
    create.mockResolvedValueOnce(
      completionWith(JSON.stringify({ summary_en: 'a summary', key_points: ['a', 'b'] })),
    );
    const llm = createLlmClient({ apiKey: 'k' });
    await expect(llm.summary(input)).resolves.toEqual({
      summary_en: 'a summary',
      key_points: ['a', 'b'],
    });
  });
});
