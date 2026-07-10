import { Redis } from 'ioredis';

/** BullMQ queue names — single source of truth shared by the worker
 * (consumers) and the api (the reenrich producer, PRD §12). Lives in
 * @job-portal/shared so both apps import it without depending on each other. */
export const SCRAPE_QUEUE = 'scrape';
export const ENRICHMENT_QUEUE = 'enrichment';

/** BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection
 * used by Workers/QueueEvents (blocking commands). Producers can share the
 * same setting harmlessly. */
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
