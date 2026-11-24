import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import { directory } from './schema';

export interface BoardEntry {
  ats: string;
  token: string;
  name: string;
  host?: string | null;
}

export interface Board extends BoardEntry {
  host: string | null;
  marked: boolean;
}

export interface BoardDirectory {
  /** Adds boards not yet listed (by ats and token); never changes a listed board or its mark. Returns how many were added. */
  importBoards: (entries: BoardEntry[]) => Promise<number>;
  /** The boards of one ATS that count for runs: marked ones only. */
  listMarked: (ats: string) => Promise<Board[]>;
  /** The boards of one ATS not marked yet, which the mark script checks. */
  listUnmarked: (ats: string) => Promise<Board[]>;
  /** Sets the mark of the given boards; touches nothing else. */
  mark: (ats: string, tokens: string[]) => Promise<void>;
}

const CHUNK = 1000;

const columns = {
  ats: directory.ats,
  token: directory.token,
  name: directory.name,
  host: directory.host,
  marked: directory.marked,
};

export function createBoardDirectory(db: Db): BoardDirectory {
  const list = (ats: string, marked: boolean): Promise<Board[]> =>
    db
      .select(columns)
      .from(directory)
      .where(and(eq(directory.ats, ats), eq(directory.marked, marked)))
      .orderBy(asc(directory.token));

  return {
    async importBoards(entries) {
      let added = 0;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const rows = await db
          .insert(directory)
          .values(entries.slice(i, i + CHUNK).map((e) => ({ ...e, host: e.host ?? null })))
          .onConflictDoNothing()
          .returning({ id: directory.id });
        added += rows.length;
      }
      return added;
    },
    listMarked: (ats) => list(ats, true),
    listUnmarked: (ats) => list(ats, false),
    async mark(ats, tokens) {
      for (let i = 0; i < tokens.length; i += CHUNK) {
        await db
          .update(directory)
          .set({ marked: true })
          .where(and(eq(directory.ats, ats), inArray(directory.token, tokens.slice(i, i + CHUNK))));
      }
    },
  };
}
