# The Publisher is a nullable column on Postings, written by every ingest

A Source that aggregates other sites (JSearch, spec #28) knows which site a posting was listed on. That fact belongs to the Posting, not the Job: one Job can hold Postings from several Sources, each with its own Publisher. `NormalizedPosting` gets an optional `publisher`, stored in a new nullable `publisher` column of `discovery.postings` (migration `0004`). Sources that do not aggregate leave it unset and the column stays null.

`ingest` writes it in the insert and in the update of a repeated fetch (both use the same value set), so a changed Publisher is corrected on the next poll. Existing rows stay null, no backfill. The column is part of Discovery's posting columns and of the shared MCP posting schema, so `list_jobs`, `get_job` and later the `add_job` answer show it (`publisher` is null for the existing Sources).
