import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiError } from './runner';
import { createOpenRouterRunner } from './openrouter';

// OpenRouter is faked at HTTP level: a local server that answers like the chat completions API.
describe('OpenRouter runner', () => {
  let server: Server;
  let baseUrl: string;
  let seen: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  let respond: (prompt: string) => { status: number; body: unknown; delayMs?: number };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { messages: { content: string }[] };
        seen.push({ auth: req.headers.authorization, body });
        const out = respond(body.messages[0]?.content ?? '');
        setTimeout(() => {
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.body));
        }, out.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const runner = (timeoutMs?: number) =>
    createOpenRouterRunner({
      apiKey: 'placeholder-key',
      model: 'vendor/model-a',
      baseUrl,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

  it('sends the prompt with the key and model, and reads text, tokens and reported cost', async () => {
    seen = [];
    respond = () => ({
      status: 200,
      body: {
        model: 'vendor/model-a-routed',
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 },
      },
    });
    const result = await runner().complete('say hi');
    expect(result).toEqual({
      text: 'hello',
      model: 'vendor/model-a-routed',
      inputTokens: 12,
      outputTokens: 3,
      costUsd: 0.0004,
    });
    expect(runner().name).toBe('openrouter');
    expect(seen[0]?.auth).toBe('Bearer placeholder-key');
    expect(seen[0]?.body).toMatchObject({
      model: 'vendor/model-a',
      messages: [{ role: 'user', content: 'say hi' }],
    });
  });

  it('reports null for tokens and cost the provider leaves out (a cost of 0 stays 0)', async () => {
    respond = () => ({
      status: 200,
      body: { choices: [{ message: { content: 'x' } }], usage: { cost: 0 } },
    });
    expect(await runner().complete('p')).toEqual({
      text: 'x',
      model: 'vendor/model-a',
      inputTokens: null,
      outputTokens: null,
      costUsd: 0,
    });
  });

  it.each([
    [401, 'auth'],
    [402, 'cap'],
    [429, 'rate_limit'],
    [500, 'provider'],
    [400, 'request'],
  ])('HTTP %i is an AiError of class %s, and the message holds no key', async (status, cls) => {
    respond = () => ({ status, body: { error: { message: 'nope' } } });
    const err = await runner()
      .complete('p')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).errorClass).toBe(cls);
    expect((err as AiError).message).not.toContain('placeholder-key');
  });

  it('an answer without text is a bad_output error', async () => {
    respond = () => ({ status: 200, body: { choices: [] } });
    await expect(runner().complete('p')).rejects.toMatchObject({ errorClass: 'bad_output' });
  });

  it('a slow answer is a timeout error', async () => {
    respond = () => ({ status: 200, body: {}, delayMs: 300 });
    await expect(runner(50).complete('p')).rejects.toMatchObject({ errorClass: 'timeout' });
  });

  it('an unreachable host is a network error', async () => {
    const dead = createOpenRouterRunner({ apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:1' });
    await expect(dead.complete('p')).rejects.toMatchObject({ errorClass: 'network' });
  });
});
