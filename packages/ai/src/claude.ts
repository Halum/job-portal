import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AiError, type AiResult, type AiRunner, type ClaudeEffort } from './runner';

export interface ClaudeOptions {
  /** Path of the claude binary, from config; tests point it at a fake. */
  binaryPath: string;
  model: string;
  effort: ClaudeEffort;
  timeoutMs?: number;
  /** The environment the child is built from; only the variables in PASS_ENV reach it. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** How long a child gets to leave after SIGTERM before SIGKILL. */
  killGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

/** What claude needs to run and to log in; the worker's database URL and tokens never reach it. */
const PASS_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TMPDIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
];

const outputSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
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
 * `claude -p` with the prompt on stdin (never in the argument list). The posting text in the prompt
 * is untrusted, so the child gets no tools, no MCP servers, no settings files and no skills, runs in an
 * empty directory of its own (no CLAUDE.md of this repo) and sees only the variables it needs. Locally
 * it uses the host's Claude login; in a container the auth is mounted.
 */
export function createClaudeRunner({
  binaryPath,
  model,
  effort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
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
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
  ];
  const childEnv = Object.fromEntries(
    PASS_ENV.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
  let workDir: string | undefined;
  return {
    name: 'claude',
    model,
    complete(prompt): Promise<AiResult> {
      workDir ??= mkdtempSync(path.join(tmpdir(), 'claude-run-'));
      return new Promise((resolve, reject) => {
        // Its own process group, so a timeout takes the whole tree down, not just the direct child.
        const child = spawn(binaryPath, args, {
          cwd: workDir,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
        let stdout = '';
        let settled = false;
        const settle = (finish: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          finish();
        };
        const killTree = (): void => {
          const { pid } = child;
          if (pid === undefined) return;
          const signal = (sig: NodeJS.Signals): void => {
            try {
              process.kill(-pid, sig);
            } catch {
              // already gone
            }
          };
          signal('SIGTERM');
          setTimeout(() => {
            signal('SIGKILL');
          }, killGraceMs).unref();
        };
        const timer = setTimeout(() => {
          killTree();
          settle(() => {
            reject(new AiError('timeout', 'claude run timed out'));
          });
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
          if (settled) return;
          stdout += chunk.toString('utf8');
          if (stdout.length > MAX_OUTPUT_CHARS) {
            killTree();
            settle(() => {
              reject(new AiError('bad_output', 'claude output is too large'));
            });
          }
        });
        child.stderr.resume();
        child.stdin.on('error', () => undefined); // the child may exit before it reads the prompt
        child.on('error', (err: NodeJS.ErrnoException) => {
          settle(() => {
            reject(
              new AiError('spawn', `could not start the claude binary (${err.code ?? 'error'})`),
            );
          });
        });
        child.on('close', (code) => {
          settle(() => {
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
              const u = parsed.usage;
              resolve({
                text: parsed.result,
                model,
                // Cached input is input the model read too; leaving it out would log far too few tokens.
                inputTokens:
                  u === undefined
                    ? null
                    : (u.input_tokens ?? 0) +
                      (u.cache_creation_input_tokens ?? 0) +
                      (u.cache_read_input_tokens ?? 0),
                outputTokens: u?.output_tokens ?? null,
                costUsd: parsed.total_cost_usd ?? null,
              });
            }
          });
        });
        child.stdin.end(prompt);
      });
    },
  };
}
