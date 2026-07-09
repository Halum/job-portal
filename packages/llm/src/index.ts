/**
 * OpenRouter client + two-pass enrichment pipeline (PRD §11). Deliberately a
 * stub in S0 (Foundations) — lands in phase 7 of the phased build plan
 * (PRD §18).
 */

export interface FilterPassOutput {
  should_notify: boolean;
  reason: string;
}

export interface SummaryPassOutput {
  summary_en: string;
  key_points: string[];
}
