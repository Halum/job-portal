# One active run per source is enforced by a database index

The spec says the BullMQ job id is the source id. A BullMQ Job Scheduler generates its own job ids (`repeat:<scheduler id>:<time>`), so the scheduler id is the source id instead, and the guarantee itself is a partial unique index on pipeline runs (user, source) where status is running. A second run that finds the index taken is skipped without polling, so the guarantee holds across any number of workers. The worker's concurrency of 1 is a convenience, not the guard.

A run that never finishes (its worker died, or its status write failed) would hold the index forever, so a run still running after a time bound (`staleAfterMs`, default one hour) counts as lost. The next run of the same source fails it first, and the sweep on worker start fails lost runs only, never a fresh run that may belong to another live worker. A run failed this way keeps its failed row even if its process finishes later.

Consequence: every worker removes scheduler entries for sources missing from its own config on start, so all workers must share the same source config.
