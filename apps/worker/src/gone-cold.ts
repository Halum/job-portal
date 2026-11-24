import type { Discovery } from '@job-portal/discovery';
import type { Matching } from '@job-portal/matching';
import type { Notifications } from '@job-portal/notifications';
import type { Logger } from '@job-portal/shared';
import type { Tracker } from '@job-portal/tracker';

export interface GoneColdCheck {
  /** One pass of the check; returns how many Jobs went Gone cold. */
  run: () => Promise<number>;
}

/**
 * The daily Gone cold check. The number of days is a Global default (null disables the check), the timezone
 * is the user's; the Tracker moves the Jobs, and each one gets a short Telegram line through Notifications
 * (null when no webhook is configured: the line is skipped, the move still happens). A line that cannot be
 * stored or sent is logged and never undoes a move.
 */
export function createGoneColdCheck(deps: {
  tracker: Pick<Tracker, 'goneCold'>;
  matching: Pick<Matching, 'getGlobalDefaults'>;
  discovery: Pick<Discovery, 'getJob'>;
  notifications: Pick<Notifications, 'sendLines'> | null;
  user: { id: string; timezone: string };
  log: Logger;
}): GoneColdCheck {
  const { tracker, matching, discovery, notifications, user, log } = deps;
  return {
    async run() {
      const { goneColdDays: days } = await matching.getGlobalDefaults(user.id);
      if (days === null) return 0;
      const moves = await tracker.goneCold(user.id, { days, timezone: user.timezone });
      if (moves.length === 0) return 0;
      log.info({ moved: moves.length, days }, 'jobs went gone cold');
      if (notifications === null) return moves.length;
      try {
        const lines: string[] = [];
        for (const move of moves) {
          const job = await discovery.getJob(user.id, move.jobId);
          if (job === null) continue;
          const at = job.company === null ? '' : ` at ${job.company}`;
          lines.push(`Gone cold: ${job.title}${at}, ${String(move.daysSilent)} days silent`);
        }
        await notifications.sendLines(user.id, lines);
      } catch (err) {
        log.error({ err }, 'gone cold lines not sent');
      }
      return moves.length;
    },
  };
}
