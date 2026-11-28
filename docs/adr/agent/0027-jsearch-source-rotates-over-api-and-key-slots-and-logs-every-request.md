# The JSearch Source rotates over API and key slots and logs every request

Issue #35, spec #28. The `jsearch` Source also searches through OpenWeb Ninja's Real-Time LinkedIn Data and Real-Time Indeed Data APIs, so each free quota (one per API per key) is used in turn. The Source id stays `jsearch`. The decisions below are the owner's from the ticket, except where marked as made while building.

## Pools and slots

A slot is one API and one key position. A search for publisher linkedin rotates over JSearch key 1 to n, then LinkedIn key 1 to n. A search for indeed rotates over JSearch key 1 to n, then Indeed key 1 to n. Any other publisher, or `any` (no publisher), rotates over the JSearch slots only. Each search goes to the next usable slot of its pool after the last slot that pool used. The dedicated APIs are used whenever the configured publishers include linkedin or indeed, with no new switch. `JSEARCH_API_KEYS` is renamed `OPENWEBNINJA_API_KEYS` because one key serves all three APIs. The other `JSEARCH_*` settings keep their names and drive all three.

## Request log

Table `discovery.request_log` records every request: time, API, key position (from 1), publisher as configured, the query text sent, HTTP status or a fixed failure reason (timeout, network error, unusable response), and the number of jobs returned. Never the key. The position of each pool is read from the newest row whose publisher belongs to the pool, so rotation survives a worker restart and replaces the in-memory current key of ADR agent 0026. Rows are not per user, because the keys belong to the installation and the Source has no user.

Made while building: a failure to read or write the log fails the run and is not counted as a failed search, because the rotation depends on it and a database fault would otherwise show as a network error. `recent` reads the newest rows back for tests and for a later view, no MCP tool shows them yet.

## Refusals

HTTP 429, 401 or 403 marks that slot unusable for the rest of the fetch, for every pool, because a refused key is refused for its whole API. The same search moves to the next usable slot of its pool. A pool with every slot refused throws the keys-exhausted error, the run fails and `source:jsearch` alerts, as before. The unusable set is cleared at the start of each fetch.

## Requests and postings

JSearch is unchanged. LinkedIn sends the keyword (`jobs` when the pair has none) and the location as `<location>, <country name>` or the country name alone, with `date_posted=week`. The country name comes from `JSEARCH_COUNTRY` through `Intl.DisplayNames`. LinkedIn gets no radius, because a radius needs a LinkedIn geo id and is otherwise a 400, and no language. Indeed sends the keyword (or `jobs`), the location, the country, the optional language and `date_posted=week`, and a radius only with a location.

Made while building: the two dedicated APIs answer with `data` as the list of jobs, where JSearch answers with `data.jobs`, so each has its own response check. A LinkedIn posting gets source posting id `linkedin:<job_uid>`, URL `https://www.linkedin.com/jobs/view/<job_uid>` and publisher LinkedIn. An Indeed posting gets `indeed:<job_uid>`, URL `https://<country>.indeed.com/viewjob?jk=<job_uid>` (`www` for us) and publisher Indeed, whatever publisher the result names, so it merges with the JSearch posting of the same job by site job id (ADR agent 0024). The Indeed host `<country>.indeed.com` is right for de, the only country in use, and may not open for countries such as gb, whose Indeed site is uk.indeed.com. Merging still works through the site job id. A result without `job_uid` is an error line, like a JSearch result without a job id.

The request log stores the Target query as searched (keyword, place and publisher, the text JSearch gets), the same for every API, so a LinkedIn or Indeed row shows which Target query it ran. A failed log read or write fails the run with a fixed message, never the database error, which would carry the query text.

## Smoke run

The smoke run prints the request count per slot (API and key position), never a key.
