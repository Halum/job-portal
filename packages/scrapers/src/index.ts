import type { JobAdapter, SourceType } from './types.js';
import { arbeitsagenturAdapter } from './arbeitsagentur.js';
import { fekiAdapter } from './feki.js';

export * from './types.js';
export { arbeitsagenturAdapter } from './arbeitsagentur.js';
export { fekiAdapter } from './feki.js';

/** Resolve the adapter for a configured source_type (PRD §9 switch). */
export function getAdapter(sourceType: SourceType): JobAdapter {
  switch (sourceType) {
    case 'arbeitsagentur':
      return arbeitsagenturAdapter;
    case 'feki':
      return fekiAdapter;
  }
}
