---
name: job-hunter
description: Use the job automation system through its MCP tools. Use when the user asks about new jobs, their applications, their searches (Targets), the boards the system watches, items waiting for their decision, how the system has been running, or mails it could not match.
---

# Job hunter

The job system polls job sources on a schedule, merges copies of one job, scores each job against the user's Targets (saved searches) and tells the user about the good ones. You work with it through the MCP tools below. Call `whoami` first if you are not sure the connection works.

Never invent a job, a status, a date or a score: read it with a tool. Ids are UUIDs that tools return; pass them back as they are. Lists are paged: pass `nextCursor` back as `cursor` until it is null.

## Jobs

- `list_jobs`: the stored Jobs with their postings and tracking. Filters apply before paging. Use `targetId` for the candidates of one Target, `minScore` or `tagged` with it to keep the good ones.
- `get_job`: one Job in full: all postings, tracking, Timeline, notes and, per Target, the AI score, reasons, red flags and tag. Read it before saying anything about a single job.
- `add_job`: add a job the user found by hand (title, URL, optional company and city). The same URL again returns the same Job.
- `split_job`: undo a wrong merge by moving postings (ids from `get_job`) into a new Job. Ask the user first: merges never come back on their own.

## Tracking and notes

- `set_status`: change one thing per call, either the discovery state (new, shortlisted, dismissed, expired) or the application status (applied, screening, interview, offer, accepted, declined, rejected, withdrawn). Pass `actor: skill` when you make the change for the user.
  - Applied needs the user's word that they applied. Ask for the date if it is not today (`appliedOn`) and for the deadline if they have one (`applyBy`). A second Applied is refused.
  - A final status (accepted, declined, rejected, withdrawn) changes only through `undo_last_change`.
- `undo_last_change`: undo the last state change of a Job. It is itself a Timeline event and cannot be repeated. Confirm with the user before using it on a final status.
- `add_note`: a free-text note on a Job (who called, what was said). Notes are not state changes.

## Targets and Global defaults

- `list_targets`: the Targets with their own criteria and the criteria they end up using.
- `upsert_target`: create a Target or change the one with that name. Only the keys you pass change and null clears one. The Target is matched over all stored Jobs at once. Editing criteria never rescores a scored Job; only the alert threshold changes what is tagged.
- `get_global_defaults` and `update_global_defaults`: the settings every Target falls back to, including `goneColdDays` (days of silence before an application goes Gone cold; null turns it off). Changing a default changes every Target that inherits it, so say so to the user first.
- `bundesagenturSearches` (a criteria field of Global defaults and of a Target): a list of up to 20 saved Bundesagentur search URLs, for example `https://www.arbeitsagentur.de/jobsuche/suche?wo=Musterstadt&umkreis=15&arbeitszeit=tz&angebotsart=1`. Every run fetches each one with its own town, radius and work-time filter, before the searches built from keywords and locations (50 searches at most per run). A Target that sets its own list replaces the Global one, null inherits, and a Target with only URLs still searches. Only https URLs on `www.arbeitsagentur.de` under `/jobsuche/suche` are accepted, only the parameters `was`, `wo`, `umkreis`, `arbeitszeit`, `angebotsart` and `sort` are kept, and a URL with none of them is refused. Ask the user for the URLs; never invent one.

## Watchlist and boards

- `get_watchlist`: the company boards the user watches. An empty Watchlist means every marked board of the directory is fetched.
- `update_watchlist`: add and remove boards that are already in the directory.
- `add_board`: add a company by its Greenhouse, Lever or Ashby careers page URL. The first board turns an empty Watchlist into a restricting one, so only watched boards are fetched from then on; tell the user.

## Reviews

The system raises a Review item when it is not sure: an AI fit rejection (a job the AI scored below the threshold), an AI merge (two jobs that may be one) or a mail match (a reply it could not apply safely).

- `list_reviews`: pending items by default, with the posting links, the Target, the score and the reasons. Show these to the user in plain words.
- `decide_review`: confirm or disagree. This is the user's decision, never yours: read the item to them and wait for their answer. Confirm agrees with the AI (an AI merge then merges the two Jobs, a mail match applies the mail through the Timeline). Disagree tags the rejected Job or keeps two Jobs apart. For a mail match the user may pick another Job from the item's `possibleJobIds` with `jobId`. An item can be decided once.
- `review_stats`: how often the user agreed with the AI, per kind and model, and how many items are still pending.

## Career bank (resume and cover letter material)

The Career bank holds the user's Master resume as Work experiences with Experience points. Files never travel through MCP. Upload one with curl (the same bearer token as the MCP endpoint) and pass the returned id to a tool:

`curl -sS -X POST -H "Authorization: Bearer $TOKEN" --data-binary @cv.pdf "$BASE/files?kind=master_resume&filename=cv.pdf"`

`kind` is `master_resume`, `master_cover_letter` or `photo`. PDF, DOCX, Markdown and UTF-8 text are accepted for the Master files and PNG or JPEG for the photo, up to 10 MB; the type is checked from the content. `GET $BASE/files/<id>` returns the stored file again. Replacing a Master keeps the older upload.

- `register_master_document`: mark an uploaded file id as the current Master resume or Master cover letter.
- `save_career_bank`: import a parse of the Master resume (Work experiences with role, organisation, start, end or null, place, and their Experience points with skills). Parse the file yourself, show the result to the user and call this only after they reviewed it. It adds to what is stored, so do not import the same resume twice.
- `get_career_bank`: the current Master files and the Work experiences in order, each with its Experience points.

## How the system is running

- `get_run_history`: recent Runs per source with counts, errors and the AI totals (calls, failures, tokens, cost). Use it when the user asks why nothing new arrived or what the AI costs.
- `list_unmatched_mails`: job-like mails from the inbox that matched none of the user's Jobs, so nothing is dropped silently. If one belongs to a job, offer to `add_job` it or `add_note` on the right Job.
