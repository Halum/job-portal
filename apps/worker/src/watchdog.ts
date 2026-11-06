import type { Logger } from '@job-portal/shared';
import type { ErrorNotifier } from './notify.js';

export interface WatchdogDeps {
  /** Live ioredis status ('ready' when usable). */
  redisStatus: () => string;
  notify: ErrorNotifier;
  logger: Logger;
  exit: (code: number) => void;
  now?: () => number;
  redisDownMs?: number;
  scrapeStaleMs?: number;
}

/**
 * Self-heal for silent stalls: the process stays "Up" while doing nothing, so
 * Docker's restart policy never fires. On 2026-10-01 a Redis restart left
 * ioredis in a reconnect loop (ETIMEDOUT) for 19 days while fresh connections
 * worked. `check()` records an errors row (Telegram via n8n) and exits so
 * `restart: unless-stopped` brings up a fresh worker.
 */
export function createWatchdog(deps: WatchdogDeps) {
  const {
    redisStatus,
    notify,
    logger,
    exit,
    now = Date.now,
    redisDownMs = 10 * 60_000,
    // Bamberg/Coburg/Frankfurt each run every 6h, so 8h without any
    // successful scrape means something is wrong.
    scrapeStaleMs = 8 * 60 * 60_000,
  } = deps;

  let lastScrapeOk = now();
  let redisDownSince: number | null = null;
  let tripped = false;

  async function trip(reason: string): Promise<void> {
    tripped = true;
    logger.fatal({ reason }, 'watchdog: worker stalled, exiting for restart');
    await notify({
      event: 'worker.stalled',
      source: null,
      stage: 'scrape',
      attempts: 0,
      error: reason,
    });
    exit(1);
  }

  return {
    markScrapeOk(): void {
      lastScrapeOk = now();
    },
    async check(): Promise<void> {
      if (tripped) return;
      const t = now();
      if (redisStatus() === 'ready') redisDownSince = null;
      else redisDownSince ??= t;

      if (redisDownSince !== null && t - redisDownSince >= redisDownMs) {
        return trip(
          `Redis connection not ready for ${Math.round((t - redisDownSince) / 60_000)} min`,
        );
      }
      if (t - lastScrapeOk >= scrapeStaleMs) {
        return trip(`no successful scrape for ${Math.round((t - lastScrapeOk) / 3_600_000)} h`);
      }
    },
  };
}
