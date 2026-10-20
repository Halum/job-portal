import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@job-portal/shared';
import { createWatchdog } from '../src/watchdog.js';

const MIN = 60_000;
let t: number;
let status: string;
const notify = vi.fn(async () => {});
const exit = vi.fn();

function make() {
  return createWatchdog({
    redisStatus: () => status,
    notify,
    logger: createLogger({ level: 'silent' }),
    exit,
    now: () => t,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  t = 0;
  status = 'ready';
});

describe('createWatchdog', () => {
  it('stays quiet while Redis is ready and scrapes complete', async () => {
    const w = make();
    for (let i = 0; i < 20; i++) {
      t += 60 * MIN;
      w.markScrapeOk();
      await w.check();
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it('tolerates a short Redis blip', async () => {
    const w = make();
    status = 'reconnecting';
    await w.check();
    t += 9 * MIN;
    await w.check();
    status = 'ready';
    await w.check();
    status = 'reconnecting';
    t += 9 * MIN;
    await w.check();
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits and notifies after 10 min of Redis not ready', async () => {
    const w = make();
    status = 'reconnecting';
    await w.check();
    t += 10 * MIN;
    await w.check();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker.stalled', stage: 'scrape' }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits after 8h without a successful scrape, only once', async () => {
    const w = make();
    t += 8 * 60 * MIN;
    await w.check();
    await w.check();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].error).toMatch(/no successful scrape for 8 h/);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
