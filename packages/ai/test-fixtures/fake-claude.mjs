#!/usr/bin/env node
// Stands in for the claude binary in tests: reads the prompt from stdin and answers like
// `claude -p --output-format json`. The prompt text picks the behaviour.
import { readFileSync, appendFileSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args) + '\n');
}
const reply = (body) => process.stdout.write(JSON.stringify(body));

if (prompt.includes('FAKE_EXIT')) {
  process.stderr.write('boom');
  process.exit(3);
}
if (prompt.includes('FAKE_NOT_LOGGED_IN')) {
  reply({ type: 'result', is_error: true, result: 'Not logged in. Please run /login' });
  process.exit(1);
}
if (prompt.includes('FAKE_HANG')) {
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
    usage: { input_tokens: 11, output_tokens: 7 },
  });
}
