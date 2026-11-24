import { and, asc, eq, or } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import type { Board, BoardEntry } from './directory';
import { upsertMarked } from './directory';
import { directory, watchlist } from './schema';

/** A refusal whose message is safe to show a user (for example a board that is not in the directory). */
export class BoardsError extends Error {
  override name = 'BoardsError';
}

export interface BoardRef {
  ats: string;
  token: string;
}

export interface Watchlist {
  /** The user's watched boards, ordered by ats then token. */
  list: (userId: string) => Promise<BoardRef[]>;
  /** Watches boards that are in the Board directory; one that is not fails the call and nothing is added. Idempotent. */
  add: (userId: string, boards: BoardRef[]) => Promise<void>;
  /**
   * Adds a verified board to the directory (marked) and watches it, in one transaction: both or
   * neither. wasEmpty is true when the Watchlist was empty before, so from now on only watched
   * boards (of every ATS) are fetched.
   */
  addMarkedBoard: (
    userId: string,
    entry: BoardEntry,
  ) => Promise<{ board: Board; wasEmpty: boolean }>;
  /** Stops watching boards; boards not on the Watchlist are ignored. */
  remove: (userId: string, boards: BoardRef[]) => Promise<void>;
  /**
   * The boards of one ATS a run fetches for this user: marked directory boards, narrowed to the
   * watched ones when the Watchlist is not empty (empty means all marked boards).
   */
  listBoards: (userId: string, ats: string) => Promise<Board[]>;
}

const columns = {
  ats: directory.ats,
  token: directory.token,
  name: directory.name,
  host: directory.host,
  marked: directory.marked,
};

const matching = (boards: BoardRef[]): ReturnType<typeof or> =>
  or(...boards.map((b) => and(eq(directory.ats, b.ats), eq(directory.token, b.token))));

export function createWatchlist(db: Db): Watchlist {
  return {
    list: (userId) =>
      db
        .select({ ats: watchlist.ats, token: watchlist.token })
        .from(watchlist)
        .where(eq(watchlist.userId, userId))
        .orderBy(asc(watchlist.ats), asc(watchlist.token)),

    async add(userId, boards) {
      if (boards.length === 0) return;
      const known = await db
        .select({ ats: directory.ats, token: directory.token })
        .from(directory)
        .where(matching(boards));
      const missing = boards.filter(
        (b) => !known.some((k) => k.ats === b.ats && k.token === b.token),
      );
      if (missing.length > 0) {
        throw new BoardsError(
          `not in the Board directory: ${missing.map((b) => `${b.ats}/${b.token}`).join(', ')}`,
        );
      }
      await db
        .insert(watchlist)
        .values(boards.map((b) => ({ userId, ats: b.ats, token: b.token })))
        .onConflictDoNothing();
    },

    addMarkedBoard: (userId, entry) =>
      db.transaction(async (tx) => {
        const [any] = await tx
          .select({ ats: watchlist.ats })
          .from(watchlist)
          .where(eq(watchlist.userId, userId))
          .limit(1);
        const board = await upsertMarked(tx, entry);
        await tx
          .insert(watchlist)
          .values({ userId, ats: entry.ats, token: entry.token })
          .onConflictDoNothing();
        return { board, wasEmpty: any === undefined };
      }),

    async remove(userId, boards) {
      if (boards.length === 0) return;
      await db
        .delete(watchlist)
        .where(
          and(
            eq(watchlist.userId, userId),
            or(...boards.map((b) => and(eq(watchlist.ats, b.ats), eq(watchlist.token, b.token)))),
          ),
        );
    },

    async listBoards(userId, ats) {
      const [any] = await db
        .select({ ats: watchlist.ats })
        .from(watchlist)
        .where(eq(watchlist.userId, userId))
        .limit(1);
      const marked = and(eq(directory.ats, ats), eq(directory.marked, true));
      if (!any)
        return db.select(columns).from(directory).where(marked).orderBy(asc(directory.token));
      return db
        .select(columns)
        .from(directory)
        .innerJoin(
          watchlist,
          and(
            eq(watchlist.userId, userId),
            eq(watchlist.ats, directory.ats),
            eq(watchlist.token, directory.token),
          ),
        )
        .where(marked)
        .orderBy(asc(directory.token));
    },
  };
}
