import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import { BoardsError, type Watchlist } from '@job-portal/boards';
import {
  ATS_IDS,
  BoardFetchError,
  DiscoveryError,
  RateLimitError,
  fetchBoardPostings,
  resolveBoardUrl,
} from '@job-portal/discovery';
import type { Logger } from '@job-portal/shared';

export interface BoardToolDeps {
  watchlist: Watchlist;
  /** The one verification fetch of add_board: pass the rate-limited fetch (there is no unthrottled default). */
  fetch: typeof fetch;
  /** Counts an add_board attempt for the user; false once they are over their limit. */
  allowAddBoard: (userId: string) => Promise<boolean>;
}

const LIMITS = { token: 100, boards: 100, url: 2048, name: 200 };
const boardRef = z.object({ ats: z.enum(ATS_IDS), token: z.string().min(1).max(LIMITS.token) });
const boardList = z.array(boardRef).max(LIMITS.boards);
const boardsOut = { boards: z.array(boardRef) };

const ok = (out: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(out) }],
  structuredContent: out,
});
const refusal = (message: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: message }],
});

// Errors whose message is written by us for the user; anything else (Drizzle, ioredis, network) is
// logged and shown as a fixed text.
const SAFE = [DiscoveryError, BoardsError, BoardFetchError, RateLimitError];
const fail = (err: unknown, fallback: string, logger: Logger) => {
  if (err instanceof Error && SAFE.some((c) => err instanceof c)) return refusal(err.message);
  logger.error({ err }, fallback);
  return refusal(fallback);
};

export function registerBoardTools(
  mcp: McpServer,
  user: User,
  { watchlist, fetch: fetchImpl, allowAddBoard }: BoardToolDeps,
  logger: Logger,
): void {
  mcp.registerTool(
    'get_watchlist',
    {
      description:
        'List the boards on your Watchlist. An empty Watchlist means every marked board of the Board directory is fetched; a non-empty one limits fetching to these boards.',
      outputSchema: boardsOut,
    },
    async () => ok({ boards: await watchlist.list(user.id) }),
  );

  mcp.registerTool(
    'update_watchlist',
    {
      description:
        'Add and remove Watchlist boards (at most 100 of each per call; boards must be in the Board directory, use add_board for a new company). Returns the new Watchlist. Removing every board makes the Watchlist empty again, which fetches all marked boards.',
      inputSchema: { add: boardList.optional(), remove: boardList.optional() },
      outputSchema: boardsOut,
    },
    async ({ add, remove }) => {
      try {
        // add first: it validates every board and writes nothing when one is unknown
        await watchlist.add(user.id, add ?? []);
        await watchlist.remove(user.id, remove ?? []);
        return ok({ boards: await watchlist.list(user.id) });
      } catch (err) {
        return fail(err, 'update_watchlist failed', logger);
      }
    },
  );

  mcp.registerTool(
    'add_board',
    {
      description:
        'Add a company by its Greenhouse, Lever or Ashby careers page URL: the board id is extracted, verified with one fetch, added to the shared Board directory (marked) and put on your Watchlist. Limited per user per hour. Note: a Watchlist that was empty becomes non-empty, so only watched boards (of every ATS) are fetched from then on; the result says so. An unknown URL or a board that fails verification returns an error and changes nothing.',
      inputSchema: { url: z.string().min(1).max(LIMITS.url) },
      outputSchema: {
        ats: z.enum(ATS_IDS),
        token: z.string(),
        name: z.string(),
        postings: z.number(),
        narrowedWatchlist: z.boolean(),
        note: z.string().optional(),
      },
    },
    async ({ url }) => {
      const board = resolveBoardUrl(url);
      if (!board) {
        return refusal(
          'Not a Greenhouse, Lever or Ashby careers URL (for example https://boards.greenhouse.io/<board>, https://jobs.lever.co/<board> or https://jobs.ashbyhq.com/<board>)',
        );
      }
      try {
        // counted before the fetch, so a loop of bad boards is limited too
        if (!(await allowAddBoard(user.id))) {
          return refusal('add_board limit reached for now, try again later');
        }
        let postings;
        try {
          postings = await fetchBoardPostings(
            board.ats,
            { token: board.token, name: board.token, host: board.host },
            fetchImpl,
          );
        } catch (err) {
          if (err instanceof BoardFetchError) {
            return refusal(`${board.ats} board ${board.token}: ${err.message}`);
          }
          if (err instanceof RateLimitError) throw err;
          logger.warn({ err }, 'add_board verification fetch failed');
          return refusal(`${board.ats} board ${board.token} could not be fetched`);
        }
        // ponytail: the ATS gives no company name for Lever and Ashby, so the board id stands in for it
        const name = (postings[0]?.company ?? board.token).slice(0, LIMITS.name);
        const { wasEmpty } = await watchlist.addMarkedBoard(user.id, {
          ats: board.ats,
          token: board.token,
          name,
          host: board.host,
        });
        return ok({
          ats: board.ats,
          token: board.token,
          name,
          postings: postings.length,
          narrowedWatchlist: wasEmpty,
          ...(wasEmpty && {
            note: 'The Watchlist was empty, so only watched boards (of every ATS) are fetched from now on. Remove this board from the Watchlist to fetch all marked boards again.',
          }),
        });
      } catch (err) {
        return fail(err, 'add_board failed', logger);
      }
    },
  );
}
