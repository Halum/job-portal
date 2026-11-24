import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { ATS_IDS, createRateLimitedFetch, fetchBoardPostings } from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createLogger } from '@job-portal/shared';
import { createBoardDirectory, loadBundledBoards, markBoards } from '@job-portal/boards';

// Thin entrypoint (it lives in the worker app because the migrations package depends on boards): `import` loads the bundled company lists, `mark` marks boards that posted in
// Germany or remote EU. Both can be run again at any time.
const command = process.argv[2];
const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'boards' });
await runMigrationsWithLock(config.databaseUrl, allMigrations, logger);
const { db, close } = createDb(config.databaseUrl);
const directory = createBoardDirectory(db);

if (command === 'import') {
  const added = await directory.importBoards(loadBundledBoards());
  logger.info({ added }, 'board directory imported');
} else if (command === 'mark') {
  const limited = createRateLimitedFetch(config.boardRequestsPerSecond);
  for (const ats of ATS_IDS) {
    const result = await markBoards(directory, ats, async (board) =>
      (await fetchBoardPostings(ats, board, limited)).map((p) => p.location),
    );
    logger.info({ ats, ...result, failed: result.failed.length }, 'boards marked');
  }
} else {
  logger.error('usage: main.ts import | mark');
  process.exitCode = 1;
}
await close();
