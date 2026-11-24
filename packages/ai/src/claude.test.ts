import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeRunner } from './claude';

// The claude binary is faked by a script that answers like `claude -p --output-format json`.
const fake = fileURLToPath(new URL('../test-fixtures/fake-claude.mjs', import.meta.url));
const runner = (timeoutMs?: number) =>
  createClaudeRunner({
    binaryPath: fake,
    model: 'sonnet',
    effort: 'low',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

describe('claude -p runner', () => {
  it('passes the prompt on stdin, model and effort as flags, and reads text, tokens and cost', async () => {
    const argsFile = path.join(mkdtempSync(path.join(tmpdir(), 'fake-claude-')), 'args.jsonl');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    try {
      const result = await runner().complete('score this job');
      expect(result).toEqual({
        text: 'echo: score this job',
        model: 'sonnet',
        inputTokens: 11,
        outputTokens: 7,
        costUsd: 0.0123,
      });
      const args = JSON.parse(readFileSync(argsFile, 'utf8').trim()) as string[];
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
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS_FILE;
    }
    expect(runner().name).toBe('claude');
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
});
