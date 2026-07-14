/**
 * Live smoke test — hits the real source and prints normalized RawJobs.
 * NOT run in CI. Usage: tsx src/smoke.ts <arbeitsagentur|feki> [url]
 */
import { SOURCE_TYPES, type SourceType } from '@job-portal/shared';
import { getAdapter } from './index.js';

const DEFAULT_URL: Record<SourceType, string> = {
  arbeitsagentur: 'https://www.arbeitsagentur.de/jobsuche/suche?wo=Bamberg&umkreis=25',
  feki: 'https://www.feki.de/jobboerse',
};

const sourceType = process.argv[2] as SourceType;
if (!SOURCE_TYPES.includes(sourceType)) {
  console.error('usage: tsx src/smoke.ts <arbeitsagentur|feki> [url]');
  process.exit(1);
}
const url = process.argv[3] ?? DEFAULT_URL[sourceType];

const jobs = await getAdapter(sourceType).fetch(url);
console.log(`${sourceType}: ${jobs.length} jobs from ${url}\n`);
for (const j of jobs.slice(0, 10)) {
  console.log(`- [${j.externalId}] ${j.title}`);
  console.log(`    ${j.company ?? '?'} — ${j.location ?? '?'} — ${j.postedAt?.toISOString() ?? '?'}`);
  console.log(`    ${j.applyUrl}`);
}
