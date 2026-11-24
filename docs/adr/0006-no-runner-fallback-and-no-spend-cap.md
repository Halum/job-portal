# No AI runner fallback and no spend cap

There are two AI runners (OpenRouter and `claude -p`) chosen by config, and a failing runner never falls back to the other: the Job and Target pair stays unscored, is retried by a later run oldest first, and the failure raises an alert. A silent fallback would mix models and costs without the user knowing. There is no spend cap in the system; cost is bounded by prerank (only the top N postings per Target reach the AI) and a per-run call limit, and every call is logged with its cost.
