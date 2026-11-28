import { loadConfig } from '@job-portal/config';
import { createLogger } from '@job-portal/shared';
import { composeApp } from './compose';
import { smokeRefusal } from './smoke-guard';

// Manual live check: one cycle against the real sources and the configured AI runner for the configured user.
// Read-only toward external services except the AI calls; Gmail is never read. It writes to the configured
// database like a normal run, so its Jobs show up in the next real digest. No digest or alert is sent (notifications are switched off here).
// Prints counts and cost only, never settings or secrets. Not run by CI or any test.
const refusal = smokeRefusal(process.env);
if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}

const config = { ...loadConfig(), notifications: null };
const logger = createLogger({ level: config.logLevel, name: 'smoke' });
const app = await composeApp(config, logger);
try {
  if (app.scheduled.length === 0)
    console.log('no source is configured: set an interval for at least one');
  for (const { sourceId } of app.scheduled) {
    const run = await app.pipeline.execute(app.user.id, sourceId);
    if (run === null) {
      console.log(`${sourceId}: skipped, a run is already active`);
      continue;
    }
    const {
      status,
      fetched,
      newPostings,
      prerankPassed,
      scored,
      tagged,
      aiRejections,
      aiCalls,
      aiCostUsd,
      errors,
    } = run;
    console.log(
      `${sourceId}: ${JSON.stringify({ status, fetched, newPostings, prerankPassed, scored, tagged, aiRejections, aiCalls, aiCostUsd, errorCount: errors.length })}`,
    );
  }
  if (app.jsearchStats) {
    const { requests, slots } = app.jsearchStats();
    console.log(`jsearch: ${String(requests)} requests`);
    for (const { api, keyPosition, requests: n } of slots) {
      console.log(`  ${api} key ${String(keyPosition)}: ${String(n)}`);
    }
  }
  // No mail poll: it would claim real replies in the ledger and change real statuses, and the Telegram line would never be sent.
  console.log('mail: not polled by the smoke run');
  console.log(`ai totals: ${JSON.stringify(await app.aiLog.totals(app.user.id))}`);
} finally {
  await app.close();
}
