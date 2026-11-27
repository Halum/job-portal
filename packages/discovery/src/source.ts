/** One posting in the shape every Source returns, whatever its own payload looks like. */
export interface NormalizedPosting {
  /** The Source's own posting id; with the source id it identifies the Posting. */
  sourcePostingId: string;
  title: string;
  company?: string;
  location?: string;
  postedAt?: Date;
  url: string;
  /** The site the posting was listed on, for Sources that aggregate other sites; other Sources omit it. */
  publisher?: string;
  /** The full payload as the Source gave it, stored as is. */
  raw: unknown;
}

export interface FetchResult {
  postings: NormalizedPosting[];
  /** Items the Source could not use (one line each); they end the run "completed with errors". */
  errors: string[];
}

/** A place postings come from. Adding a Source is adding one module that implements this. */
export interface Source {
  id: string;
  fetch: () => Promise<FetchResult>;
  fetchDescription?: (posting: { sourcePostingId: string }) => Promise<string>;
}
