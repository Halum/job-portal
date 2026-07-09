import { Redis } from 'ioredis';

/** Queue names — single source of truth shared by producers and consumers. */
export const SCRAPE_QUEUE = 'scrape';
export const ENRICHMENT_QUEUE = 'enrichment';

/** BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection
 * used by Workers/QueueEvents (blocking commands). */
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
