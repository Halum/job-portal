import type { NotificationsConfig } from '@job-portal/config';
import type { Db } from '@job-portal/db';
import type { Discovery } from '@job-portal/discovery';
import type { Matching } from '@job-portal/matching';
import { createNotifications, type Notifications } from '@job-portal/notifications';
import type { Review } from '@job-portal/review';
import type { Logger } from '@job-portal/shared';

/**
 * Wires Notifications to the modules it reads, through their exported functions only: new tags from
 * Matching, Job title and links from Discovery, the waiting count from Review. Returns null when no
 * webhook is configured: the step is then skipped and the Pipeline never sends anything.
 */
export function buildNotifications(
  db: Db,
  config: NotificationsConfig | null,
  deps: {
    matching: Pick<Matching, 'listNewTags'>;
    discovery: Pick<Discovery, 'getJob'>;
    review: Pick<Review, 'countPending'>;
    log: Logger;
    fetch?: typeof fetch;
  },
): Notifications | null {
  if (config === null) {
    deps.log.info('no webhook configured: digests and failure alerts are skipped');
    return null;
  }
  return createNotifications(db, {
    newTags: (userId, since) => deps.matching.listNewTags(userId, since),
    jobInfo: async (userId, jobId) => {
      const job = await deps.discovery.getJob(userId, jobId);
      if (job === null) return null;
      return {
        title: job.title,
        company: job.company,
        links: job.postings.map((p) => p.url),
        active: job.discoveryState === 'new' || job.discoveryState === 'shortlisted',
      };
    },
    pendingReviews: (userId) => deps.review.countPending(userId),
    webhook: { url: config.webhookUrl, topicId: config.topicId },
    maxAttempts: config.maxAttempts,
    backoffMs: config.backoffMs,
    log: deps.log,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
