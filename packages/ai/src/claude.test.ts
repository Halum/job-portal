import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeRunner } from './claude';

// The claude binary is faked by a script that answers like `claude -p --output-format json`.
const fake = fileURLToPath(new URL('../test-fixtures/fake-claude.mjs', import.meta.url));
const runner = (timeoutMs?: number, env?: NodeJS.ProcessEnv) =>
  createClaudeRunner({
    binaryPath: fake,
    model: 'sonnet',
    effort: 'low',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(env === undefined ? {} : { env }),
    killGraceMs: 200,
  });

interface Seen {
  args: string[];
  cwd: string;
  env: string[];
}
const seenBy = async (prompt: string, env: NodeJS.ProcessEnv): Promise<Seen> => {
  // The fake appends what it was given to a file named after its parent, this test process.
  const file = path.join(tmpdir(), `fake-claude-seen-${String(process.pid)}.jsonl`);
  rmSync(file, { force: true });
  // TMPDIR is passed so the child finds the same temp directory as this process.
  await runner(undefined, { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env }).complete(
    prompt,
  );
  return JSON.parse(readFileSync(file, 'utf8').trim()) as Seen;
};

describe('claude -p runner', () => {
  it('passes the prompt on stdin, model and effort as flags, and reads text, tokens and cost', async () => {
    const result = await runner().complete('score this job');
    expect(result).toEqual({
      text: 'echo: score this job',
      model: 'sonnet',
      // input 11 + cache creation 3 + cache read 5: all of them are input the model read
      inputTokens: 19,
      outputTokens: 7,
      costUsd: 0.0123,
    });
    const { args } = await seenBy('score this job', {});
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--model',
        'sonnet',
        '--effort',
        'low',
        '--output-format',
        'json',
      ]),
    );
    expect(args).not.toContain('score this job');
    expect(runner().name).toBe('claude');
    expect(runner().model).toBe('sonnet');
  });

  it('isolates the child: no tools, no MCP servers, no settings, no skills', async () => {
    const { args } = await seenBy('p', {});
    expect(args).toEqual(
      expect.arrayContaining(['--strict-mcp-config', '--disable-slash-commands']),
    );
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('runs in an empty directory of its own and passes on only the variables it needs', async () => {
    const seen = await seenBy('p', {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: 'placeholder-auth',
      DATABASE_URL: 'postgres://secret',
      MCP_BEARER_TOKEN: 'secret',
      OPENROUTER_API_KEY: 'secret',
    });
    expect(seen.cwd).not.toBe(process.cwd());
    expect(existsSync(seen.cwd) && readdirSync(seen.cwd)).toEqual([]);
    expect(seen.env).toContain('ANTHROPIC_API_KEY');
    for (const secret of ['DATABASE_URL', 'MCP_BEARER_TOKEN', 'OPENROUTER_API_KEY']) {
      expect(seen.env).not.toContain(secret);
    }
  });

  it('a non-zero exit is an exit error', async () => {
    await expect(runner().complete('FAKE_EXIT')).rejects.toMatchObject({ errorClass: 'exit' });
  });

  it('a logged-out binary is a not_logged_in error', async () => {
    await expect(runner().complete('FAKE_NOT_LOGGED_IN')).rejects.toMatchObject({
      errorClass: 'not_logged_in',
    });
  });

  it('output that is not JSON is a bad_output error', async () => {
    await expect(runner().complete('FAKE_GARBAGE')).rejects.toMatchObject({
      errorClass: 'bad_output',
    });
  });

  it('a missing binary is a spawn error', async () => {
    const missing = createClaudeRunner({
      binaryPath: '/nonexistent/claude',
      model: 'm',
      effort: 'low',
    });
    await expect(missing.complete('p')).rejects.toMatchObject({ errorClass: 'spawn' });
  });

  it('a hung binary is killed and is a timeout error', async () => {
    await expect(runner(200).complete('FAKE_HANG')).rejects.toMatchObject({
      errorClass: 'timeout',
    });
  });

  it('a hung grandchild that keeps the output open does not hang the call', async () => {
    const started = Date.now();
    await expect(runner(300).complete('FAKE_GRANDCHILD')).rejects.toMatchObject({
      errorClass: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
