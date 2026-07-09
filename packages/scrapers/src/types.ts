export type { SourceType } from '@job-portal/shared';
import type { SourceType } from '@job-portal/shared';

export interface RawJob {
  externalId: string; // adapter-computed, stable across polls
  title: string;
  company?: string;
  location?: string;
  postedAt?: Date;
  applyUrl: string;
  description: string;
  raw: unknown; // full source payload, stored as JSONB
}

export interface JobAdapter {
  sourceType: SourceType;
  fetch(url: string): Promise<RawJob[]>;
}
