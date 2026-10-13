# Architecture

Loom owns the agent loop, permissions, durable sessions, cancellation and delegation. Pi supplies model protocols and terminal components; Zustand supplies transient UI state. All clients share the same core.

## Boundaries

```text
TerminalApp / headless CLI / SDK
                 │ input, approval, events
                 ▼
Agent ── Context and budgets ── Gateway model adapters
  │
  ├── Dispatcher: validate → authorize → persist intent → execute → settle
  │      ├── File tools and checkpoints
  │      ├── ShellExecutor → OS sandbox and output artifacts
  │      ├── History and explicit memory tools → SQLite Workers
  │      └── Read-only delegated agents
  │
  └── Session: ordered JSONL, fsync, projections and crash recovery
```

| Module | Responsibility |
| --- | --- |
| `src/core/` | Execution lifecycle, sessions, budgets, context, skills and completion evaluation |
| `src/model/` | Independent chat and classifier adapters through Vercel AI Gateway |
| `src/tools/` | Tool declarations, authorization, file changes and source-linked recall |
| `src/execution/` | Sandbox policy, shell lifecycle and cancellation |
| `src/storage/` | Worker request lifecycle, rebuildable history index and authoritative memory |
| `src/ui/` | Terminal components, commands, translations and ephemeral state |

UI code supplies input and approval callbacks; it does not invoke tool implementations. Model adapters do not run the execution loop. Tools always pass through Dispatcher, including user controls such as `/undo` and `/memory`.

## Execution and persistence

1. `inbox.delivered` consumes input and carries its user message in one event.
2. `tool.started` is synced before execution; `tool.finished` carries both status and model-visible result.
3. Rejected, invalid, truncated, failed and cancelled calls still receive paired results. Only complete assistant responses admit tools.
4. A live process holds each session's writer lock; Agent admits one execution chain at a time.
5. Recovery settles unfinished calls as unknown and requires inspection plus explicit continuation. It never automatically replays effects.
6. User controls record user-visible results rather than inventing orphan tool responses.
7. Compaction preserves original journals, artifacts and file checkpoints.
8. `task.finished` commits before optional completion evaluation, so evaluation failure cannot reopen completed work.

The guarantee ends at successful writes and fsync. It does not provide distributed ownership, external exactly-once execution, protection against filesystem corruption, or immunity to local races and PID reuse.

Steering inputs reach the next model step after the current tool batch. Queued tasks wait for the current task to finish. Idle settlement rechecks the inbox to avoid missed wakeups. Cancellation propagates to model requests, tools and child agents; remaining cancelled calls are settled as well.

Children use independent read-only sessions and share the workspace, budget and cancellation chain. They cannot write, execute shell, change permissions, access project memory or delegate further. Parallel reads are not snapshot isolation. A batch runs in parallel only when every tool declares itself parallel-safe.

## Context and budgets

Context functions require the session interface (`events`, `messages`, `latestEvent`); internal evidence snapshots use the explicit read-only `contextView` projection. There is no implicit events-only adapter. Each request projects the journal into model context. Prompt estimates reserve the smallest of 8192 tokens, 20% of the context window and the model output limit, plus 10% of the window for safety. Compaction starts at the smaller of 65% of the window and the remaining input allowance. These are estimates, not tokenizer counts or billed usage.

Compaction retains recent complete exchanges and chooses a user-message boundary. An oversized retained exchange fails before a summary request; unsuccessful or cancelled summaries preserve the original context. Automatic compaction must reduce estimated input before committing its checkpoint.

Task facts come from delivered inputs and tool outcomes, not assistant claims. The projection preserves the first input and latest seven corrections, plus the latest twelve tool-outcome references. Long inputs and omitted records retain source references. Compacted current-task facts accompany the generated handoff so a lossy summary cannot silently replace user requirements; `read_history` retrieves original evidence.

Chat calls, children, compaction and adapter retries share the run budget. Retries occur only for eligible errors before text has streamed. A new explicitly resumed run gets a new budget; compaction does not replenish it.

## Storage

| Store | Authority | Lifecycle |
| --- | --- | --- |
| `.loom/sessions/ID/events.jsonl` | Execution and original source events | Append-only; retained across compaction |
| `.loom/sessions/ID/checkpoints/` and artifacts | Before-edit contents and full tool output | Retained for inspection and restoration |
| `.loom/history.sqlite` | Rebuildable search cache | Created lazily; may be deleted while Loom is closed |
| `.loom/memory.sqlite` | Explicit project memory and revisions | Authoritative; never delete as cache maintenance |

SQLite runs in Workers through fixed operations, without SQL or extension access from tools. Requests have a ten-second deadline; cancellation terminates the Worker and close waits for termination. Database failure is a tool error, not permission to repair journals or replay effects. Regular-file, directory and workspace checks reject common redirects but do not eliminate local filesystem races.

**History:** FTS5 trigram search tracks source fingerprints, watermarks and prefix hashes. Changed prefixes rebuild that session's index; unchanged sources avoid reads. Searches default to the current session; roots may search other root sessions in the same workspace, while children can only recall their own. Recall results are excluded from indexing to avoid recursive copies. `read_history` reads source events independently of index health. Resume listing remains a read-only journal scan.

History limits: 16 MiB per journal, at most 1000 sessions and 64 MiB of changed logs per workspace refresh, 65536 database pages, twenty search results with 700-character excerpts, and 12000-character source pages. Queries shorter than three Unicode characters use literal substring matching. The cache uses DELETE journals and NORMAL synchronization.

**Memory:** immutable `revisions`, current `heads` and atomic `operations` receipts support source-backed saves, version-checked updates and invalidation. Only original user input or completed successful non-recall tool results with `executed: true` can serve as sources. `get_memory` checks event IDs and hashes; changed, missing or expired evidence becomes stale in the returned view. Listings leave provenance unchecked. Path scopes apply to a relative subtree; project scopes apply across this workspace.

`remember` and `forget_memory` use normal write permissions. Explicit-request-only saving is a model instruction, not a semantic security guarantee. There is no background extraction, global/worktree sharing or automatic full-memory prompt injection. Archives retain earlier revisions. The database uses DELETE journals and EXTRA synchronization, with a 4000-character text limit, 1–8 sources, at most 64 MiB of source reads, twenty results per page and 10000 memory IDs. Revision history and receipts have no total disk quota.

Memory and JSONL are not one atomic transaction. A crash may occur after a mutation commits but before its result is recorded. Same-session/call receipts deduplicate identical mutations; new call identities do not. Inspect unknown outcomes before retrying. See [SECURITY.md](../SECURITY.md) for privacy and retention boundaries.

## Tools and UI

File writes sync a checkpoint before replacement and check the observed content version. Existing files use exclusive temporary replacements, with cleanup on conflict or cancellation. Restoration refuses to overwrite later changes. Shared file IO rejects oversized text, final symlinks and special files; it does not eliminate parent-directory or hard-link races.

| Input | Limit |
| --- | --- |
| Workspace text | 2 MiB |
| Search file | 256 KiB |
| Tool-output artifact | 10 MiB |
| Checkpoint JSON / session journal | 16 MiB |
| Directory listing | 5000 files |
| Skill / lock / UI settings | 32000 bytes / 4 KiB / 64 KiB |

Each TerminalApp owns a Zustand vanilla store. Pure event transitions project display state; Agent owns execution and Dispatcher owns authorization. Terminal components, promises and cancellation handles stay outside the store. Streaming updates only the affected message; closing settles execution before disposal and ignores late updates after closure. Commands, aliases, help and completion share one registry. Permission changes go through Agent; language preferences commit before display updates.

## Optional completion evaluation

The separate classifier adapter observes coverage, unsupported completion claims and missing verification after root-task completion. `--verify shadow` allows at most three calls per run, each with a five-second deadline and no transport retry. Evidence and questions are bounded to 64 KiB. Started/finished events preserve inputs, hashes, judgments, timing and reported usage; interrupted evaluations settle as unknown without replay.

Judgments do not enter chat context, change permissions or trigger retries. Unknown usage is not fabricated as zero cost. Live accuracy requires human labels and real tests; offline protocol tests do not establish it.

## Traversal costs

Session incrementally projects committed events into inbox, message and latest-event indexes. Views process only new events; returned pending/message arrays still cost proportional to their result sizes. Replacing or shortening the event array rebuilds projections; direct mutation of old event types is unsupported. Use `append` for changes.

Compacted context scans only the retained tail. Task-state allocation is bounded, although accurate omission counts still require scanning the selected task. Compaction and session listing merge repeated passes; prompt budgets serialize each component once and reuse byte counts. File traversal reuses a directory-exclusion Set. Changed history logs still undergo full prefix validation. Tests assert event-access counts and boundary equivalence rather than machine-dependent timing.

## Design references

Research used local snapshots of Pi `c661bc5`, Codex `a9b0815` and OpenCode `3e78cd5` in October 2026. Claude Code references describe public behavior; its private runtime was not inspected or incorporated. These references explain design provenance, not a claim that current upstream code is identical.

| Reference | Adopted mechanism |
| --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/c661bc5) | Model envelopes, terminal components, steering/queue separation, original-history/context separation |
| [Codex](https://github.com/openai/codex/tree/a9b0815) | Central authorization, cancellation pairing, read/write scheduling |
| [OpenCode](https://github.com/anomalyco/opencode/tree/3e78cd5) | Durable-input execution, single-session coordination and evidence-based recovery |
| Claude Code [working model](https://code.claude.com/docs/en/how-claude-code-works), [permissions](https://code.claude.com/docs/en/permissions), [subagents](https://code.claude.com/docs/en/sub-agents) | Interactive steering, approval UX, lazy skills and child-context isolation |

Shell policy and operating requirements are documented separately in [sandbox.md](sandbox.md). Extension work must preserve these interfaces and persistence invariants.
