# Bundesagentur search parameters come from env until Targets exist

Superseded by ADR 0007: the query now comes from Targets; only the interval env var remains.

The real search criteria must not be in the repo, and Targets (the database home of criteria) are a later ticket. Until then the worker reads `BUNDESAGENTUR_QUERY` (API query parameters such as `wo` and `umkreis`) and `BUNDESAGENTUR_INTERVAL_MINUTES` (integer, at least 1, default 60) from the environment. The source is scheduled only when the query is set, and only a fixed allow-list of parameters reaches the API. The Matching ticket replaces the env query with Target criteria.
