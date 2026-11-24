# Discovery stores one Job per Posting until dedupe lands

Postings are unique on (user, source, source posting id) and re-polling updates the row. Each new Posting gets its own Job, and the Job list is paged by Job id. A poll inserts a spare Job before the posting upsert and deletes it when the Posting already existed, so two concurrent polls cannot create a second row. Dedupe (rule merges, AI merges, split) will attach Postings to existing Jobs in a later ticket. Tables carry a plain user id with no foreign key into the accounts schema, so modules stay separable.
