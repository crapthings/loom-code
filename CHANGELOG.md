# Changelog

## Unreleased

- Remove legacy gateway aliases, implicit events-only context adapters and optional sandbox-manager capabilities; require affirmative execution evidence for memory sources.

- Consolidate current documentation, remove redundant initial release notes, update the existing-repository release checklist, and include linked guides and environment examples in the source package.
- Incrementally project session inbox/messages and latest events, bound task-state allocation, scan compacted journal tails, merge compaction/listing traversals, and reuse file-tree exclusions; add deterministic traversal and boundary-equivalence checks.
- Add explicit source-backed project memory with independent SQLite storage, immutable revisions, expiry, scoped recall, version-checked mutations, normal dispatcher permissions, and `/memory` browsing.
- Add a rebuildable SQLite/FTS5 history index in a cancellable Worker, source-linked search/read tools, same-workspace recall with child isolation, prefix-validated incremental indexing, and packed-worker coverage.
- Add explicit input/output/safety context budgets, `/status` context diagnostics, source-linked current-task projections across compaction/reopen, and guards against oversized retained exchanges and ineffective automatic compaction.
- Add opt-in completion shadow evaluation with a separate Luna Decisions/Jev classifier adapter, bounded evidence, decision budgets, cancellation/deadlines, durable evaluation records, and offline protocol tests.
- Share bounded file IO across modules, read reopened journals through their owned handles, reject invalid lock owners, make sandbox cleanup idempotent, and clear failed UI streams.
- Share automatic/manual operation ownership and cleanup, handle synchronous failures, and discard cancelled compaction responses while accounting for returned usage.
- Document and regression-test `openai/gpt-6.1-sol` through the bundled Vercel Gateway catalog, including model selection, reasoning, streamed text, and tool-call forwarding.
- Harden tool text reads against special files, final symlinks, and oversized input; clean temporary replacements on conflict/cancellation, enforce tree limits, and validate tool effects/results before model feedback.
- Centralize slash commands, aliases, argument checks, help, and completion in one registry; dispatch UI events through named pure transitions while retaining lifecycle guards.
- Move the offline model to test fixtures and remove the public `--demo` option, demo script, and SDK export; package smoke checks inject the fixture through the SDK.
- Add workspace-scoped `loom resume` selection, explicit IDs, `--last`, and read-only text/JSON session catalogs with lock and child-session filtering.
- Continue only unfinished work or saved inputs; preserve prior tool evidence, resume interrupted work before queued tasks, and coalesce simultaneous resume requests.
- Restrict production model routing and catalog listing to Vercel AI Gateway; remove direct-provider and custom-endpoint CLI options.
- Per-app Zustand vanilla view-state stores with immutable event projections, copied budget counters, scoped rendering, and subscription cleanup.
- English-default UI with centralized English/Chinese catalogs, `/language` / `/lang`, and atomic user-level language preferences.
- Centered framed permission dialogs with visible choices on narrow screens and per-tool approval grants for the current run.
- Mandatory native shell isolation using sandbox-runtime 0.0.79: Seatbelt on macOS and bubblewrap on Linux.
- Default-denied shell networking, protected metadata and credential paths, isolated temporary home/cache, and an environment allowlist.
- Fail-closed dependency and policy checks, explicit `--sandbox off`, and `/sandbox` diagnostics.
- Real native filesystem/socket boundary tests and a sandboxed JavaScript coding-and-test loop.

## 0.1.0 — 2026-10-12
- JavaScript agent loop with steering inputs, queued tasks, shared budgets, and cancellation.
- Durable JSONL sessions, interrupted-call recovery, and explicit handling of unknown effects.
- Version-checked file tools, reversible checkpoints, and bounded shell-output artifacts.
- TUI with streaming Markdown, CJK support, approval dialogs, and `/mode` / `/permissions` controls.
- Read-only research and review subagents with shared budgets and cancellation.
- Project `AGENTS.md`, lazy skill loading, context compaction, and headless JSON events.
- Pi model adapters and TUI components; default Vercel AI Gateway / DeepSeek V4.1 Flash.
- pnpm management, offline behavior tests, and package-content verification.

This release does not include OS sandboxing, an MCP client, persistent OAuth authentication, distributed coordination, or an npm registry publication.
