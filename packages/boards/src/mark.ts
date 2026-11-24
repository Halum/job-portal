import type { Board, BoardDirectory } from './directory';

const GERMANY =
  /\b(germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|düsseldorf|leipzig|dresden|nuremberg|nürnberg|hannover|bremen|bamberg)\b/i;
const GERMAN_COUNTRY_CODE = /(^|,\s*)DE\s*(,|$)/;
const REMOTE_EU =
  /remote.*\b(europe|emea|eu|eea|european union)\b|\b(europe|emea|eu|eea|european union)\b.*remote/i;

/**
 * True when any location is in Germany or remote within the EU.
 * ponytail: a text heuristic over a short city list; a posting in a German town not listed here is
 * missed until its board posts somewhere that matches. Upgrade path: the bundled city table.
 */
export function postedInGermanyOrRemoteEu(locations: (string | undefined)[]): boolean {
  return locations.some(
    (l) => l !== undefined && (GERMANY.test(l) || GERMAN_COUNTRY_CODE.test(l) || REMOTE_EU.test(l)),
  );
}

export interface MarkResult {
  checked: number;
  marked: number;
  /** One line per board that could not be fetched; its mark is left as it was. */
  failed: string[];
}

/**
 * Re-runnable mark: checks the boards of one ATS that are not marked yet and marks those that
 * posted in Germany or remote EU. A marked board stays marked, a failing board is left alone, and
 * nothing but the mark is written.
 * ponytail: boards with no German posting are checked again on every run; add a checked-at column
 * if the unmarked list gets long.
 */
export async function markBoards(
  directory: BoardDirectory,
  ats: string,
  fetchLocations: (board: Board) => Promise<(string | undefined)[]>,
): Promise<MarkResult> {
  const boards = await directory.listUnmarked(ats);
  const hits: string[] = [];
  const failed: string[] = [];
  for (const board of boards) {
    try {
      if (postedInGermanyOrRemoteEu(await fetchLocations(board))) hits.push(board.token);
    } catch (err) {
      failed.push(
        `${ats} board ${board.token}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await directory.mark(ats, hits);
  return { checked: boards.length, marked: hits.length, failed };
}
