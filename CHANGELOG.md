# Changelog

## Unreleased

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
