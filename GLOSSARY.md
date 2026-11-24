# Glossary

Terms name things in code, database, tests and issues. Source of truth: the spec in GitHub issue #3.

- **Source**: a place postings come from (bundesagentur, bambase, greenhouse, lever, ashby, manual), implemented as one module behind the Source interface.
- **Posting**: one raw listing from one Source, identified by source id plus the Source's own posting id.
- **Job**: the deduplicated thing the user tracks, made of one or more Postings.
- **Rule merge**: automatic attachment of a Posting to an existing Job when its company key or URL key matches exactly one Job.
- **AI merge**: a merge proposed by the AI check for a near match, stored as an ai_merge Review item and applied only once confirmed.
- **Split**: moving Postings out of a Job into a new Job, which records a Never-merge pair.
- **Board directory**: the shared list of ATS company boards (Greenhouse, Lever, Ashby), with a mark for boards that have posted in Germany or remote EU.
- **Watchlist**: the user's own list of boards that narrows which directory boards are fetched.
- **Target**: a named set of search criteria (keywords, locations, salary floor and so on) that Jobs are scored against.
- **Global defaults**: the criteria every Target falls back to when it leaves a field unset.
- **Criteria resolution**: how a Target field, when set, replaces the Global default, while exclusion words and blocked companies are the union of both.
- **Hard filter**: a per-Target pass or fail check (radius, remote preference) applied before scoring.
- **Prerank**: the keyword score per Target that keeps only the top prerank_top_n Postings for the AI.
- **Fit score**: the AI's 0 to 100 rating of a Job against one Target, with reasons and red flags.
- **AI runner**: the one interface for calling an AI, with an OpenRouter and a `claude -p` implementation.
- **Run**: one execution of the Pipeline for one Source, with its counts and errors.
- **Digest**: the notification message listing Jobs that newly gained a Target tag in a Run.
- **Review item**: a question the system cannot settle alone (ai_merge, ai_fit_rejection, mail_match) that waits for the user's decision.
- **Discovery state**: where a Job stands before applying: New, Shortlisted, Dismissed or Expired.
- **Application status**: where an application stands: Applied, Screening, Interview, Offer, Accepted, Declined, Rejected, Withdrawn or Gone cold.
- **Furthest stage**: the highest of Applied, Screening, Interview, Offer, Accepted a Job has reached; it only moves forward except by undo.
- **Timeline event**: one recorded state change (from, to, actor, evidence, time), the only write path for any state change.
- **Gone cold**: the status the daily check gives an application with no state-changing or Gmail event for N days.
- **Processed-mail ledger**: the record of Gmail message ids already handled, keyed by user id and message id, so a mail is never applied twice.
- **Never-merge pair**: a recorded (Posting, Job) pair that rule and AI merges must skip, created by a Split.
- **Manual job**: a Job the user adds by hand (add_job) as a Posting with source `manual`, which still goes through dedupe.
- **Board URL resolver**: the add_board step that recognises a Greenhouse, Lever or Ashby careers URL, verifies it with one fetch and adds the board to the directory and Watchlist.
