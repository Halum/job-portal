#!/usr/bin/env node
/* global process, setTimeout */
// Stands in for the claude binary in tests: reads the prompt from stdin and answers like
// `claude -p --output-format json`. The prompt text picks the behaviour.
import { readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prompt = readFileSync(0, 'utf8');
const args = process.argv.slice(2);
// The test (the parent) reads what the child was given: arguments, directory, variable names.
// Not through an environment variable, because the runner strips those.
appendFileSync(
  join(tmpdir(), `fake-claude-seen-${String(process.ppid)}.jsonl`),
  JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env) }) + '\n',
);
const reply = (body) => process.stdout.write(JSON.stringify(body));

if (prompt.includes('FAKE_EXIT')) {
  process.stderr.write('boom');
  process.exit(3);
}
if (prompt.includes('FAKE_NOT_LOGGED_IN')) {
  reply({ type: 'result', is_error: true, result: 'Not logged in. Please run /login' });
  process.exit(1);
}
if (prompt.includes('FAKE_GRANDCHILD')) {
  // A child that keeps stdout open and outlives this process, as a hung tool would.
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], { stdio: 'inherit' });
} else if (prompt.includes('FAKE_HANG')) {
  setTimeout(() => undefined, 60_000);
} else if (prompt.includes('FAKE_GARBAGE')) {
  process.stdout.write('not json at all');
} else {
  reply({
    type: 'result',
    is_error: false,
    result: 'echo: ' + prompt.trim(),
    total_cost_usd: 0.0123,
    duration_ms: 5,
    usage: {
      input_tokens: 11,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 5,
      output_tokens: 7,
    },
  });
}
