# LinkedIn and Indeed links are keyed by the site's own job id

A LinkedIn or Indeed job link reached through a Source, a browser search or a pasted link must give one URL key, so copies of one job merge by rule merge (spec #28). `siteJobId` in `packages/discovery/src/site-job.ts` is the one pure function that reads the site's job id from a URL: LinkedIn `/jobs/view/<slug>-<id>`, `/jobs/view/<id>`, `/comm/jobs/view/<id>` and a `/jobs` page with `currentJobId` on linkedin.com or any subdomain, and Indeed `jk` (then `vjk`) on indeed.com, its subdomains and the country hosts (`indeed.co.uk`, `indeed.com.au`, `indeed.fr`). The host match is exact on the registrable domain, so `notindeed.com` and `indeed.com.example.org` give null. Anything else gives null.

`urlKey` calls it first and builds the key from `linkedin.com/jobs/view/<id>` or `indeed.com/viewjob?jk=<id>`, then applies its usual normalisation. Every other URL keeps exactly the key it had. Stored keys are not backfilled, so a link added by hand before this change may become a second Job, which split or AI merge resolves (spec #28, Out of Scope 6).

`add_job` uses the same function to take the site job id as the source posting id (ticket #31), so the two never disagree on what a job link is.
