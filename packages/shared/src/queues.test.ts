import { describe, expect, it } from 'vitest';
import { ENRICHMENT_QUEUE, SCRAPE_QUEUE, createRedisConnection } from './queues.js';

describe('queue constants', () => {
  it('exposes stable queue names', () => {
    expect(SCRAPE_QUEUE).toBe('scrape');
    expect(ENRICHMENT_QUEUE).toBe('enrichment');
  });
});

describe('createRedisConnection', () => {
  it('sets maxRetriesPerRequest null (required by BullMQ blocking commands)', () => {
    const conn = createRedisConnection('redis://localhost:6379');
    conn.on('error', () => {}); // swallow the async connect attempt in test
    expect(conn.options.maxRetriesPerRequest).toBeNull();
    conn.disconnect();
  });
});
