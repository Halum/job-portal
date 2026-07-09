/**
 * Adapter interface + per-source adapters (PRD §9). Deliberately a stub in
 * S0 (Foundations) — the Arbeitsagentur and feki adapters land in phases 4-5
 * of the phased build plan (PRD §18).
 */

export type SourceType = 'arbeitsagentur' | 'feki';

export interface RawJob {
  externalId: string;
  title: string;
  company?: string;
  location?: string;
  postedAt?: Date;
  applyUrl: string;
  description: string;
  raw: unknown;
}

export interface JobAdapter {
  sourceType: SourceType;
  fetch(url: string): Promise<RawJob[]>;
}
