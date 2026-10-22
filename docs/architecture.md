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
  │      ├── ProcessManager → per-command ShellExecutor workers → OS sandbox and output artifacts
  │      ├── CuaComputer → MCP Driver → host desktop and screenshot artifacts
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
| `src/execution/` | Sandbox policy, shell lifecycle, Cua connection and cancellation |
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
8. Automatic completion review precedes `task.finished` and can request a bounded corrective continuation; optional shadow evaluation follows settlement without affecting execution. Unverified or blocked outcomes remain explicitly resumable.

The guarantee ends at successful writes and fsync. It does not provide distributed ownership, external exactly-once execution, protection against filesystem corruption, or immunity to local races and PID reuse.

Steering inputs reach the next model step after the current tool batch. Queued tasks wait for the current task to finish. Idle settlement rechecks the inbox to avoid missed wakeups. Cancellation propagates to model requests, tools and child agents; remaining cancelled calls are settled as well.

Shell tool return and process completion are separate events. `process.started` is durable before spawning; a yielded `tool.finished` reports `running`, and `process.finished` records the final exit, output artifact and full-lifetime workspace observation. The task cannot finish while processes remain active. At safe tool boundaries, `process.delivered` admits background evidence exactly once as a user-role notification, without fabricating orphan tool results. With no independent work, Agent waits for completion or a steering input without model calls. `/jobs` and `/stop ID` go through Dispatcher and record control results without inserting messages into an unsettled model tool exchange.

ProcessManager owns at most four active process groups per session, bounded output, optional execution deadlines, and status/wait/stop controls. Each sandbox manager has its own worker and cleanup lifetime, so background processes cannot monopolize a global sandbox lock. An IPC-connected runner terminates its group if the harness disappears; trailing-pipe handling prevents an exited shell from waiting for a quiet descendant until timeout. Recovery marks unfinished processes unknown, delivers recorded but unobserved completions, and never replays a command or kills a PID copied from history. SDK users constructing tool registries directly should retain the injected ProcessManager and close it before closing its Session.

Children use independent read-only sessions and share the workspace, budget and cancellation chain. They cannot write, execute shell, operate the computer, change permissions, access project memory or delegate further. Parallel reads are not snapshot isolation. A batch runs in parallel only when every tool declares itself parallel-safe.

## Computer tools and image evidence

`CuaComputer` is an optional execution interface supplied to the root Agent. The CLI enables it only with `--computer cua`, rejects models without catalog image support and launches `cua-driver mcp` over stdio. `@modelcontextprotocol/client` pins protocol revision `2026-07-28` for Cua Driver 0.28+; there is no legacy negotiation fallback or second agent loop. Startup discovers declarations from a bounded catalog, then exposes only the reviewed observation/input allowlist under `computer_` names. Driver guides are resource reads through the journaled `computer_help` tool, not silently injected instructions. Driver installation and OS permissions remain external prerequisites.

Every operation passes through Dispatcher. Observations have the `read` effect; application input and browser preparation have the `computer` effect, requiring approval in ask/edit and denied in plan. Auto permits them only when the computer interface was explicitly enabled. The host desktop is outside ShellExecutor's sandbox, and computer actions do not count as observed workspace edits. All computer tools run sequentially to avoid racing capture identifiers. Loom privately supplies the Driver session identifier and only permits `isolated_new` browser preparation; it exposes no profile-grant, arbitrary evaluation, batch, upload or download tools.

Startup invokes an internal `computer_check_permissions` tool through Dispatcher before any model request, with `prompt:false` and `probe_direct_capture:false`. It accepts only explicit granted Accessibility and Screen Recording fields. Pending, missing or unknown status fails startup with human setup instructions. The preflight's journal result is a labeled harness observation rather than an orphan model tool response, including crash recovery. Internal tools are omitted from model declarations and reject model-origin calls. This check never runs a prompt-capable capture probe and cannot establish visual correctness.

A recognized Driver permission error latches a computer blocker. Agent's dispatcher stop predicate cancels remaining calls in that sequential batch, including file edits; all calls still settle. Agent then records the task as blocked and stops without another chat or decision-model call. Explicit continuation checks permissions again before delivering resumed input or invoking a model. A failed check leaves pending work intact; a successful check clears the latch and preserves original requirements, without replaying the refused action. Other Driver errors retain their normal observation/recovery semantics. UI errors and `/status` show the permission remedy; JSON events include the blocker.

The child environment inherits desktop connectivity and a minimal system allowlist, excluding model credentials and implicit Driver permission overrides. Discovery has a ten-second timeout and calls default to thirty seconds. SDK elicitation auto-fulfillment is disabled because it can reissue calls. Cancellation, timeout or protocol/transport errors close the connection, mark uncertain outcomes explicitly, and never reconnect or replay automatically. A subsequent call refuses execution until Loom restarts. This does not undo an input already delivered to an application; fresh observations remain necessary before any deliberate retry.

Image results are validated PNG/JPEG/WebP bytes, stored under SHA-256 names with mode 0600 and synced before `tool.finished`. Journals, UI and JSON event consumers receive references, not encoded pixels. Reads reject traversal, final symlinks, non-regular files, oversize files and hash changes. The active chat context retains only the latest four image occurrences; it hydrates bytes at the model boundary. `read_image` recalls older artifacts through Dispatcher. Missing or changed images become an explicit no-pixels notice. Compaction, history and decision-model projections contain textual artifact evidence, not pixels or implicit visual verification. Image context estimates use a provisional 4096-token allowance per image rather than counting base64 as text; actual provider accounting may differ.

Fake-driver tests cover real stdio MCP discovery, approvals, session isolation, cancellation, timeouts, disconnection and artifact recovery. A local HTTP provider test checks the actual image payload. These establish integration behavior without paid APIs or desktop access, not live OS compatibility or visual-task success. Driver protocol and host setup are documented in its [README](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md) and [MCP contract](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/mcp-protocol-and-skills.md).

## Context and budgets

Context functions require the session interface (`events`, `messages`, `latestEvent`); internal evidence snapshots use the explicit read-only `contextView` projection. There is no implicit events-only adapter. Each request projects the journal into model context. Prompt estimates reserve the smallest of 8192 tokens, 20% of the context window and the model output limit, plus 10% of the window for safety. Compaction starts at the smaller of 65% of the window and the remaining input allowance. These are estimates, not tokenizer counts or billed usage.

Compaction cuts at user or assistant boundaries where no tool calls remain unsettled, including inside one long task. It prefers the latest two assistant exchanges and a retained tail below 20000 estimated tokens or half the compaction threshold. Tool calls and results remain paired; an indivisible oversized exchange fails before a summary request. Summarization uses source-linked visible evidence, shortening older records with explicit omissions when needed to fit the summary request. Unsuccessful or cancelled summaries preserve the original context. Automatic compaction must reduce input, and every committed projection must fit the input allowance.

Task facts come from delivered inputs and tool outcomes, not assistant claims. The projection preserves the first input and latest seven corrections, plus the latest twelve tool-outcome references. Long inputs and omitted records retain source references. Compacted current-task facts accompany the generated handoff so a lossy summary cannot silently replace user requirements; `read_history` retrieves original evidence.

Chat calls, children, compaction and adapter retries share the run budget. Retries occur only for eligible errors before text has streamed. A new explicitly resumed run gets a new budget; compaction does not replenish it.

## Investigation progress

After each settled tool batch, a bounded local monitor looks for repeated reads with identical arguments and results, consecutive failures or empty searches, history-only investigation, and missing visible updates. Three repeated or unsuccessful rounds, six history-only or silent rounds, or roughly a minute without commentary request reassessment. A three-round cooldown bounds notices; a parallel batch counts as one round. New task inputs reset observation counters.

`progress.review` records the reasons, recent call references, journal range and exact review instructions, displays a notice in the TUI/headless stream, and adds an evidence-specific reminder at the end of the next chat request. The system prompt stays stable for prefix caching; reminders are not original user inputs or searchable history. It asks the model to explain findings, change an unproductive method, and match verification to the original symptom. Reviews add no classifier call, impose no run limit, and do not interrupt an active tool or replay effects. Request and compaction budgets include reminder text. Original requirements survive resumed runs and remain the first input in bounded completion evaluation evidence.

These patterns are reasons to reassess, not semantic proof of failure or success. Fresh output and commentary do not establish correctness, and the model may still ignore feedback. Rendering claims require actual rendering evidence or an explicit verification gap; local protocol tests cannot establish a model's investigation quality.

The CLI enables `--supervise auto` by default and injects a separate `progressModel` classifier into Agent; SDK clients opt in through that explicit interface. `ProgressSupervisor` assesses a strong local pattern after at least three rounds, or sustained investigation after twelve, with at least eight rounds between assessments. It compares original/latest user inputs, four preceding and twelve current settled outcomes, bounded tool arguments/results, and visible assistant claims. Input is at most 32 KiB, with explicit omissions; private reasoning and nested raw historical records are excluded.

Four classifier questions distinguish useful progress, change versus research intent, adherence to the previous direction, and the next action. Confident stagnation judgments append `progress.directed` with exact instructions and retain a request-tail reminder until reassessment or new steering; implementation directions require confident change intent and a writable permission mode. Directions grant no permissions, invoke no tools, and never require edits merely because many calls occurred. The next assessment sees the preceding direction and actual subsequent execution. `progress.followup` records its source range, tool rounds, observed changes and assessment outcome; steering, cancellation and settlement close pending follow-ups without replay.

Progress calls use the shared durable decision lifecycle with a five-second deadline and no retries. Timeout, invalid responses or service failures leave execution running and increase assessment spacing to 24 then 48 rounds. They do not consume chat steps or the three-call shadow-completion allowance; all reported tokens and cost enter the run totals. The UI and JSON expose `progress.assessment.start/end`, the displayed next action, and decision usage. `--supervise off` retains local checks without progress classifier calls. Fake-provider tests establish these mechanics, not classifier accuracy or chat-model compliance.

## Storage

| Store | Authority | Lifecycle |
| --- | --- | --- |
| `.loom/sessions/ID/events.jsonl` | Execution and original source events | Append-only; retained across compaction |
| `.loom/sessions/ID/checkpoints/` and artifacts | Before-edit contents and full tool output | Retained for inspection and restoration |
| `.loom/history.sqlite` | Rebuildable search cache | Created lazily; may be deleted while Loom is closed |
| `.loom/memory.sqlite` | Explicit project memory and revisions | Authoritative; never delete as cache maintenance |

SQLite runs in Workers through fixed operations, without SQL or extension access from tools. Requests have a ten-second deadline; cancellation terminates the Worker and close waits for termination. Database failure is a tool error, not permission to repair journals or replay effects. Regular-file, directory and workspace checks reject common redirects but do not eliminate local filesystem races.

**History:** FTS5 trigram search tracks source fingerprints, watermarks and prefix hashes. Changed prefixes rebuild that session's index; unchanged sources avoid reads. Index schema or extraction changes discard derived tables and rebuild from original journals, without migrating old cache formats. Searches default to the current session; roots may discover other root sessions in the workspace and narrow searches with `sessionId`, while children can only recall their own. Recall calls, query parameters and copied results are excluded from indexing; original text and other tool calls in mixed messages remain searchable. `read_history` projects public text, tool intent and results with source identities, omitting private reasoning, provider metadata and nested recall copies without rewriting journals. Source reads are independent of index health. Resume listing remains a read-only journal scan.

History limits: 16 MiB per journal, at most 1000 sessions and 64 MiB of changed logs per workspace refresh, 65536 database pages, twenty search results with 700-character excerpts, and 12000-character source pages. Queries shorter than three Unicode characters use literal substring matching. The cache uses DELETE journals and NORMAL synchronization.

**Memory:** immutable `revisions`, current `heads` and atomic `operations` receipts support source-backed saves, version-checked updates and invalidation. Only original user input or completed successful non-recall tool results with `executed: true` can serve as sources. `get_memory` checks event IDs and hashes; changed, missing or expired evidence becomes stale in the returned view. Listings leave provenance unchecked. Path scopes apply to a relative subtree; project scopes apply across this workspace.

`remember` and `forget_memory` use normal write permissions. Explicit-request-only saving is a model instruction, not a semantic security guarantee. There is no background extraction, global/worktree sharing or automatic full-memory prompt injection. Archives retain earlier revisions. The database uses DELETE journals and EXTRA synchronization, with a 4000-character text limit, 1–8 sources, at most 64 MiB of source reads, twenty results per page and 10000 memory IDs. Revision history and receipts have no total disk quota.

Memory and JSONL are not one atomic transaction. A crash may occur after a mutation commits but before its result is recorded. Same-session/call receipts deduplicate identical mutations; new call identities do not. Inspect unknown outcomes before retrying. See [SECURITY.md](../SECURITY.md) for privacy and retention boundaries.

## Tools and UI

File writes sync a checkpoint before replacement and check the observed content version. Existing files use exclusive temporary replacements, with cleanup on conflict or cancellation. Restoration refuses to overwrite later changes. Shared file IO rejects oversized text, final symlinks and special files; it does not eliminate parent-directory or hard-link races.

An explicit dispatcher observer hashes bounded source files around authorized write/shell execution, including cancellation or failure after partial effects. Snapshots exclude protected, credential, generated and symlink paths, store hashes rather than contents, and use limits of 2000 files, 2 MiB per file, 16 MiB total and a soft 250 ms scan deadline. Incomplete coverage prevents unsupported addition/deletion inferences. Recorded changes include before/after hashes and coverage; concurrent edits may contribute, and changes are never verification. Per-task metrics record observed changes, intervention follow-ups and reported usage for offline log analysis.

Root file scans omit dependency/build directories. Explicit allowed subdirectories include their dependency/build children, including a package's `dist`; protected paths and traversed symlinks remain excluded. Search reports excluded entries, unreadable/oversized/binary files, and file/match limits as incomplete coverage. Empty results never establish absence from omitted content.

| Input | Limit |
| --- | --- |
| Workspace text | 2 MiB |
| Search file | 2 MiB; skipped files and incomplete coverage are reported |
| Tool-output artifact | 10 MiB |
| Screenshot artifact | 8 MiB each; four images per tool result and active chat context |
| Checkpoint JSON / session journal | 16 MiB |
| Directory listing | 5000 files |
| Skill / lock / UI settings | 32000 bytes / 4 KiB / 64 KiB |

Each TerminalApp owns a Zustand vanilla store. Pure event transitions project display state; Agent owns execution and Dispatcher owns authorization. Terminal components, promises and cancellation handles stay outside the store. Streaming updates only the affected message; closing settles execution before disposal and ignores late updates after closure. Commands, aliases, help and completion share one registry. Permission changes go through Agent; language preferences commit before display updates.

## Completion boundaries

The CLI defaults to `--verify auto`; SDK clients explicitly supply `decisionModel` and `verification: 'auto'`. `TurnBoundary` reviews a proposed root-task ending before `task.finished`. Its bounded classifier request includes original requirements, visible evidence, permission mode, available tools and project instructions. A confident incomplete result with an available authorized action can continue with request-tail feedback. At most two such corrections occur per user input, and another ending without new tool execution settles unverified. These bounds apply to corrective stop feedback, not normal tool rounds or task budgets.

Outcomes distinguish supported completion, unverified evidence and concrete blockers. Uncertain, unavailable or contradictory evaluations cannot certify success. New steering supersedes a pending ending; cancellation leaves the task unfinished. Unverified/blocked task origins survive explicit resume and context compaction; opening or recovering a session never invokes the classifier or replays tools. Completion events and their live UI phase are separate from progress assessment.

`--verify shadow` retains optional post-task observation, at most three calls per run, without affecting execution. `off` disables completion classification. Both modes use five-second deadlines, no transport retries and at most 64 KiB per request. Started/finished events preserve inputs, hashes, judgments, timing and reported usage; interrupted evaluations settle as unknown without replay. Unknown usage is marked missing. Live accuracy requires human labels and real observations; offline protocol tests do not establish it.

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
