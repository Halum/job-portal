# Saved Bundesagentur URLs are a criteria field, parsed in Matching

Issue #27. `bundesagenturSearches` is a nullable list of URLs in the criteria schema, so it resolves like the other fields (a Target list replaces the Global one, null inherits, an empty list is set). Validation is in the zod schema, which is the tool boundary of `update_global_defaults` and `upsert_target`: https, host `www.arbeitsagentur.de`, no port or credentials, path `/jobsuche/suche`, at most 20 URLs of 2000 characters.

Matching parses the URL (`src/search-url.ts`) into a `SearchQuery`, which gained `arbeitszeit`, `angebotsart` and `sort`; only the allowed parameters survive (`umkreis` only as a whole number of up to three digits). The Source stays dumb: it receives query strings from `bundesagenturQuery` as before, so the worker wiring did not change.

Decisions of this ticket: a URL with none of the allowed parameters is refused, because it would fetch the whole country, which ADR 0009 avoids for Targets; `searchQueries` lists URL searches of all active Targets first, then keyword and location searches, dedupes on the sorted parameters (so parameter order in a URL does not matter) and applies the existing cap of 50 to the whole list; the criteria schema is the only validator, and `searchQueries` skips an entry that no longer parses instead of failing the run.
