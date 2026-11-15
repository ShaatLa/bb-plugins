# Tokenomos plugin overview

Shows token usage and API-equivalent cost across BB threads for Claude Code, Codex, local models and Antigravity: usage-limit windows with what burned them, four ranges, compaction and local-model savings as estimates, and top threads. Everything runs in the BB server process; there is no host entry.

- `server.ts`: factory. Five settings, database migrations, the daily prune (04:17), source wiring, scheduler, RPC and CLI registration.
- `contract.ts`: public `costs.threads` and `costs.sum` schemas, UI RPC schemas, internal row types and prompt-size band edges.
- `rpc.ts`: RPC handlers. Usage limits are cached for 60 s.
- `cli.ts`: `bb tokenomos status` and `bb tokenomos summary`.
- `store/`: append-only migrations, delta upserts, read aggregates, prune.
- `ingest/`: Claude and Codex transcript sources with cursors, BB-events fallback, local-models and Antigravity `usage.list`, Idle Compact `compactions.list`, and the scheduler (5 s flush, 60 s external poll, 5 min outside-BB scan).
- `pricing/`: versioned price table and a pure cost function. Anthropic and OpenAI are verified; Gemini is not.
- `app.tsx` and `components/`: the Tokenomos page and its settings section.
- `skills/tokenomos/`: agent guide for the CLI and the public RPCs.
- `README.md`: user documentation in Russian.
