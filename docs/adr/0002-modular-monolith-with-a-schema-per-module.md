# Modular monolith with a Postgres schema per module

The system runs as two processes (an API process serving MCP and a worker process) over one codebase of domain modules. Each module owns its own Postgres schema and never queries another module's schema; it calls the other module's interface instead. This keeps one deploy for one user while making a later split of a module into its own container possible without a rewrite.
