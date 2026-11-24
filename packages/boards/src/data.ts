import { readFileSync } from 'node:fs';
import type { BoardEntry } from './directory';

export const DATA_ATS = ['greenhouse', 'lever', 'ashby'] as const;

interface DataRow {
  name?: unknown;
  token?: unknown;
  host?: unknown;
}

/** Reads the bundled company lists (JobSync, MIT; see data/NOTICE.md) as directory entries. */
export function loadBundledBoards(dir: URL = new URL('../data/', import.meta.url)): BoardEntry[] {
  return DATA_ATS.flatMap((ats) => {
    const rows = JSON.parse(readFileSync(new URL(`${ats}.json`, dir), 'utf8')) as DataRow[];
    return rows.flatMap((r) =>
      typeof r.token === 'string' && typeof r.name === 'string'
        ? [{ ats, token: r.token, name: r.name, host: typeof r.host === 'string' ? r.host : null }]
        : [],
    );
  });
}
