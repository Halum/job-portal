import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import type { BoardDirectory, Watchlist } from '@job-portal/boards';
import { ATS_IDS, fetchBoardPostings, resolveBoardUrl } from '@job-portal/discovery';

export interface BoardToolDeps {
  directory: BoardDirectory;
  watchlist: Watchlist;
  /** Used for the one verification fetch of add_board; pass the rate-limited fetch in production. */
  fetch?: typeof fetch;
}

const boardRef = z.object({ ats: z.enum(ATS_IDS), token: z.string().min(1) });
const boardsOut = { boards: z.array(boardRef) };

const ok = (out: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(out) }],
  structuredContent: out,
});
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
});

export function registerBoardTools(
  mcp: McpServer,
  user: User,
  { directory, watchlist, fetch: fetchImpl = fetch }: BoardToolDeps,
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
        'Add and remove Watchlist boards (boards must be in the Board directory; use add_board for a new company). Returns the new Watchlist. Removing every board makes the Watchlist empty again, which fetches all marked boards.',
      inputSchema: { add: z.array(boardRef).optional(), remove: z.array(boardRef).optional() },
      outputSchema: boardsOut,
    },
    async ({ add, remove }) => {
      try {
        // add first: it validates every board and writes nothing when one is unknown
        await watchlist.add(user.id, add ?? []);
        await watchlist.remove(user.id, remove ?? []);
        return ok({ boards: await watchlist.list(user.id) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'add_board',
    {
      description:
        'Add a company by its Greenhouse, Lever or Ashby careers page URL: the board id is extracted, verified with one fetch, added to the Board directory (marked) and put on your Watchlist. Note: a Watchlist that was empty becomes non-empty, so only watched boards are fetched from then on. An unknown URL or a board that fails verification returns an error and changes nothing.',
      inputSchema: { url: z.string().min(1) },
      outputSchema: {
        ats: z.enum(ATS_IDS),
        token: z.string(),
        name: z.string(),
        postings: z.number(),
      },
    },
    async ({ url }) => {
      const board = resolveBoardUrl(url);
      if (!board) {
        return fail(
          'Not a Greenhouse, Lever or Ashby careers URL (for example https://boards.greenhouse.io/<board>, https://jobs.lever.co/<board> or https://jobs.ashbyhq.com/<board>)',
        );
      }
      try {
        const postings = await fetchBoardPostings(
          board.ats,
          { token: board.token, name: board.token, host: board.host },
          fetchImpl,
        );
        // ponytail: the ATS gives no company name for Lever and Ashby, so the board id stands in for it
        const name = postings[0]?.company ?? board.token;
        await directory.addMarked({ ats: board.ats, token: board.token, name, host: board.host });
        await watchlist.add(user.id, [{ ats: board.ats, token: board.token }]);
        return ok({ ats: board.ats, token: board.token, name, postings: postings.length });
      } catch (err) {
        return fail(
          `${board.ats} board ${board.token}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
