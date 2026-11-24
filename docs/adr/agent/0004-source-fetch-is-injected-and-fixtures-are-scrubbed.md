# Sources take their HTTP client as a parameter, and fixtures are scrubbed

A Source factory takes `fetch` (default the global one), so tests feed recorded responses without a network or a mocking library; undici from the old portal is not needed. The Bundesagentur fixture is the old portal's recorded response with the search city replaced by a placeholder, employers renamed, coordinates generalised, and the employer hash, reference ids and external links replaced, because this repo is public.
