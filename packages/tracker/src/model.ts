import type { DiscoveryState } from '@job-portal/discovery';

export const APPLICATION_STATUSES = [
  'applied',
  'screening',
  'interview',
  'offer',
  'accepted',
  'declined',
  'rejected',
  'withdrawn',
  'gone_cold',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const FINAL_STATUSES: readonly ApplicationStatus[] = [
  'accepted',
  'declined',
  'rejected',
  'withdrawn',
];

/** The stages the furthest stage is measured over, in order. */
export const STAGES = ['applied', 'screening', 'interview', 'offer', 'accepted'] as const;
export type Stage = (typeof STAGES)[number];

export const ACTORS = ['user', 'skill', 'gmail', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

const END: ApplicationStatus[] = ['declined', 'rejected', 'withdrawn'];
const FROM_OFFER: ApplicationStatus[] = ['accepted', ...END, 'gone_cold'];
const FROM_INTERVIEW: ApplicationStatus[] = ['offer', ...FROM_OFFER];
const FROM_SCREENING: ApplicationStatus[] = ['interview', ...FROM_INTERVIEW];

/** Statuses a non-final status may move to. Applied is never a target: it starts an application. */
const ALLOWED: Partial<Record<ApplicationStatus, ApplicationStatus[]>> = {
  applied: ['screening', ...FROM_SCREENING],
  screening: FROM_SCREENING,
  interview: FROM_INTERVIEW,
  offer: FROM_OFFER,
  // Gone cold is not final: a late reply moves the Job on.
  gone_cold: ['screening', 'interview', 'offer', 'accepted', ...END],
};

const humanActors = (actor: Actor): boolean => actor === 'user' || actor === 'skill';

/** Returns why the change is refused, or null when it is allowed. */
export function checkApplicationChange(
  current: { status: ApplicationStatus | null; appliedOn: string | null },
  to: ApplicationStatus,
  actor: Actor,
): string | null {
  if (to === 'applied') {
    if (current.status !== null) {
      return `already applied on ${current.appliedOn ?? 'an unknown date'}`;
    }
    return humanActors(actor) ? null : 'only the user or the skill can set Applied';
  }
  if (current.status === null) return 'not applied to yet: set Applied first';
  if (FINAL_STATUSES.includes(current.status)) {
    return `${current.status} is final: only undo_last_change can change it`;
  }
  if (to === 'gone_cold' && actor !== 'system') return 'only the system sets Gone cold';
  if (!ALLOWED[current.status]?.includes(to)) {
    return `cannot go from ${current.status} to ${to}`;
  }
  return null;
}

export function checkDiscoveryChange(
  current: DiscoveryState,
  to: DiscoveryState,
  applicationStatus: ApplicationStatus | null,
  actor: Actor,
): string | null {
  if (applicationStatus !== null) {
    return 'the Job has an application status, so its discovery state no longer changes';
  }
  if (current === to) return `already ${to}`;
  if (to === 'expired' && !humanActors(actor)) return 'only the user or the skill can set Expired';
  return null;
}

/** The furthest stage never moves backwards (undo restores the stored earlier value). */
export function nextFurthest(furthest: Stage | null, to: ApplicationStatus): Stage | null {
  const rank = (s: string | null): number => (s === null ? -1 : STAGES.indexOf(s as Stage));
  return rank(to) > rank(furthest) ? (to as Stage) : furthest;
}
