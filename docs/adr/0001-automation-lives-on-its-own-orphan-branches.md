# Automation lives on its own orphan branches

The job automation is a separate product from the existing Job Portal, so it lives on the orphan branches `main-automation` and `develop-automation` in the same repo, and `main`/`develop` are never touched. The Bundesagentur and bambase adapters and the OpenRouter transport were copied over, not shared, because the portal's LLM client is built around a filter and summary pass, not scoring. A fix in one copy of an adapter must be ported to the other by hand.
