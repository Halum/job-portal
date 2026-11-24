import { spawn } from 'node:child_process';
import { z } from 'zod';
import { AiError, type AiResult, type AiRunner } from './runner';

export interface ClaudeOptions {
  /** Path of the claude binary, from config; tests point it at a fake. */
  binaryPath: string;
  model: string;
  effort: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const outputSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
});

/** The JSON `claude -p` printed, or null when it is not the expected shape. */
function readOutput(stdout: string): z.infer<typeof outputSchema> | null {
  try {
    return outputSchema.parse(JSON.parse(stdout));
  } catch {
    return null;
  }
}

/**
 * `claude -p` with the prompt on stdin (never in the argument list), no tools and no saved session.
 * Locally it uses the host's Claude login; in a container the auth is mounted.
 */
export function createClaudeRunner({
  binaryPath,
  model,
  effort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ClaudeOptions): AiRunner {
  const args = [
    '-p',
    '--model',
    model,
    '--effort',
    effort,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--tools',
    '',
  ];
  return {
    name: 'claude',
    complete(prompt): Promise<AiResult> {
      return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: timeoutMs,
        });
        let stdout = '';
        let overflow = false;
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.length > MAX_OUTPUT_BYTES) {
            overflow = true;
            child.kill();
          }
        });
        child.stderr.resume();
        child.stdin.on('error', () => undefined); // the child may exit before it reads the prompt
        child.on('error', (err: NodeJS.ErrnoException) => {
          reject(
            new AiError('spawn', `could not start the claude binary (${err.code ?? 'error'})`),
          );
        });
        child.on('close', (code, signal) => {
          if (signal === 'SIGTERM' && !overflow) {
            reject(new AiError('timeout', 'claude run timed out'));
            return;
          }
          const parsed = readOutput(stdout);
          if (parsed?.is_error === true) {
            const notLoggedIn = /not logged in|\/login/i.test(parsed.result ?? '');
            reject(
              new AiError(
                notLoggedIn ? 'not_logged_in' : 'exit',
                notLoggedIn ? 'claude is not logged in' : 'claude reported an error',
              ),
            );
          } else if (code !== 0) {
            reject(new AiError('exit', `claude exited with code ${String(code)}`));
          } else if (parsed?.result === undefined) {
            reject(new AiError('bad_output', 'claude output is not the expected JSON'));
          } else {
            resolve({
              text: parsed.result,
              model,
              inputTokens: parsed.usage?.input_tokens ?? null,
              outputTokens: parsed.usage?.output_tokens ?? null,
              costUsd: parsed.total_cost_usd ?? null,
            });
          }
        });
        child.stdin.end(prompt);
      });
    },
  };
}
