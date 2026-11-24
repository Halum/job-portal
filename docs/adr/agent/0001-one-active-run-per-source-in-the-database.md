# One active run per source is enforced by a database index

The spec says the BullMQ job id is the source id. A BullMQ Job Scheduler generates its own job ids (`repeat:<scheduler id>:<time>`), so the scheduler id is the source id instead, and the guarantee itself is a partial unique index on pipeline runs (user, source) where status is running. A second run that finds the index taken is skipped without polling. The worker also runs with concurrency 1, which is a convenience, not the guard.

Consequence: `failStaleRuns` on worker start assumes one worker process; with several workers it would fail another worker's live run.
