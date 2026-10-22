# Loom Code

[![CI](https://github.com/crapthings/loom-code/actions/workflows/ci.yml/badge.svg)](https://github.com/crapthings/loom-code/actions/workflows/ci.yml)

English | [中文](README.zh-CN.md)

A local coding agent for your terminal. Start `loom` in a project, describe a task, and let it inspect files, make changes, run commands, and report the result.

Loom implements its own agent loop, tool dispatch, permissions, durable sessions, cancellation, and read-only delegation. It uses Pi for model protocols and terminal components, Zustand for transient UI state, and OS sandboxing for shell execution. The codebase is ESM JavaScript with Standard Style, managed with pnpm.

**Early development, version 0.1.0.** Install from source; the package is not published to npm. Local terminal testing has been performed on macOS, and CI targets Linux and macOS with Node.js 22.19.0 and 24. Production readiness and coding quality have not been established.

## Quick start

Requires **Node.js >=22.19.0** and **pnpm 12.14.0**.

```sh
git clone https://github.com/crapthings/loom-code.git
cd loom-code
pnpm install --frozen-lockfile --ignore-scripts
pnpm add --global "$PWD" --ignore-scripts
```

Set your Vercel AI Gateway key, then start in any project:

```sh
export AI_GATEWAY_API_KEY='YOUR_VERCEL_GATEWAY_KEY'
cd /path/to/project
loom
```

Try a small task with an observable result:

```text
Find the entry point, explain how it works, and identify the relevant tests.
```

Then ask for a focused change and verification. The default `ask` mode can write files and run commands after you approve each tool call. Use `/mode edit` to approve file changes automatically, or `/mode auto` to approve shell commands automatically as well. Shell sandboxing stays enabled in all modes.

Add `.loom/` to the project's `.gitignore`; session logs and checkpoints can contain prompts, source code, and tool output.

The global installation links to this checkout. Keep the checkout and its dependencies; source changes take effect on the next launch. Your target projects do not need Loom dependencies. If `loom` is missing from PATH, run `pnpm setup` and reopen your terminal. Uninstall with `pnpm remove --global loom-code`.

## What Loom can do

- Read files, list directories, search literal text, and load project guidance.
- Write and edit files with content checks and checkpoints for restoration.
- Run shell commands inside an OS sandbox, with bounded output and saved artifacts.
- Optionally observe and operate the host desktop through Cua Driver, returning screenshots to the chat model.
- Delegate research and review to read-only agents sharing the run budget.
- Accept steering during active work, queue follow-up tasks, and interrupt execution.
- Reopen local sessions and explicitly continue unfinished work.
- Recall source-linked history and explicitly saved project memory.
- Review proposed endings against evidence, continue recoverable gaps, and distinguish unverified outcomes.

Root `AGENTS.md` supplies project instructions. Skills in `.agents/skills/NAME/SKILL.md` are discovered and loaded on demand. Delegated agents cannot write files, change permissions, or delegate further.

## Permissions and sandboxing

Open `/mode` or `/permissions` to choose a mode, or switch directly:

| Mode | Read tools | File changes | Shell commands | Computer actions, if enabled |
| --- | --- | --- | --- | --- |
| `/mode ask` — default | Automatic | Approval required | Approval required | Approval required |
| `/mode edit` | Automatic | Automatic | Approval required | Approval required |
| `/mode auto` | Automatic | Automatic | Automatic | Automatic |
| `/mode plan` | Automatic | Denied | Denied | Denied |

Stop or finish active work before switching modes. A reopened session starts in `ask` unless you pass `--mode`.

Approval dialogs default to **Deny**. Use arrow keys and Enter to choose, or Esc to cancel:

- **Allow once** approves the exact pending call.
- **Allow for this session** grants that tool permission for the current open session. A shell grant covers subsequent shell commands, within the selected sandbox.

Grants are separate for each tool. Selecting a mode, including the current mode, clears them. Grants are also cleared on exit and are never restored from saved sessions.

Shell execution requires **Seatbelt on macOS** or **bubblewrap on Linux** by default. Network access is denied; filesystem access is restricted. A sandbox initialization failure stops execution without falling back to unsandboxed commands.

```sh
loom --sandbox-status
```

Use `/sandbox` for the same check inside the TUI. Linux needs `bubblewrap`, `socat`, and `ripgrep`, plus host support for unprivileged namespaces. On Debian or Ubuntu:

```sh
sudo apt-get install bubblewrap socat ripgrep
```

Install project dependencies in your own terminal before asking Loom to run offline builds or tests. Model API requests occur outside the shell sandbox. Windows does not currently have a supported sandbox backend.

`loom --sandbox off` explicitly selects host execution at startup. A model or permission-mode change cannot disable the sandbox.

The sandbox is an experimental boundary, not a VM. File tools use their own path and content checks; filesystem races and resource exhaustion remain limitations. Read [sandbox setup and design](docs/sandbox.md) and [security boundaries](SECURITY.md) before relying on isolation.

## Computer use with Cua

Install [Cua Driver](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md) 0.28+ separately and configure its OS permissions. On macOS, use its supported CuaDriver.app installation with Accessibility and Screen Recording permissions. Then:

```sh
cua-driver permissions grant
cua-driver permissions status
cua-driver doctor
loom --computer cua
# When the executable is outside PATH:
loom --computer cua --cua-driver /absolute/path/to/cua-driver
```

Computer access is off by default and requires a model whose catalog supports image input. Loom connects to `cua-driver mcp` using the pinned MCP revision `2026-07-28`; older protocol formats are not supported. Cua supplies observation and input tools while Loom retains its agent loop, approvals and durable logs. Delegated agents do not receive computer tools.

Before the first model request, Loom runs a journaled, read-only Driver permission check. Missing, pending or unknown permission status stops startup with recovery instructions; it never silently enables computer use or requests OS grants. If the Driver reports a permission blocker during a task, Loom settles the failed call, cancels the remaining calls in that batch and stops the run with the task marked blocked. After completing the OS authorization, `/continue` rechecks permissions before any new model request and preserves the original unfinished task. Failed rechecks do not consume model calls. A successful permission check does not prove screenshot capture or the application's behavior.

**These tools access the host desktop outside the shell sandbox.** Enabling them permits observations, including screenshots sent through the configured model provider. Computer actions require approval in `ask`/`edit`, run without prompts in `auto`, and are denied in `plan`; grants apply to each named tool for the current run. Headless execution denies calls that require approval. Browser preparation accepts only a new isolated profile (`isolated_new`), not an existing logged-in profile. Project restrictions still apply to starting apps, servers and tests.

Screenshots are stored as private, content-addressed files in the session directory; logs and JSON events contain artifact references, not image base64. Each result accepts at most four PNG/JPEG/WebP images of 8 MiB each. The latest four image occurrences remain available to the chat model; `read_image` recalls an older artifact. Compaction, history and decision-model evidence use explicit text references without pixels, so an artifact alone cannot establish visual correctness. The TUI shows progress and result references, not inline screenshots.

Cancellation, timeout or connection loss settles the call and closes the connection without automatically retrying it. An input may already have taken effect. Restart Loom with computer access enabled, then inspect the current state before repeating an action. `/status` reports the connection state. Tests use a fake MCP driver and local provider fixtures; real desktop permissions and visual behavior require a separate live check.

## Terminal controls

Shell commands stream output and return a process ID after one second if still running. The command continues in its sandbox; completion is delivered automatically. Loom can do independent work, then wait for an event without calling the model repeatedly. A task cannot finish while its shell processes are still running. The live indicator shows the command, ID, elapsed time and time since output; `/jobs` shows recent output, and `/stop ID` stops one process. Esc or `/stop` interrupts the whole run and settles its processes.

Shell execution has no default time limit. A tool's optional `timeout` sets an execution deadline in seconds; `yield_time_ms` controls only the initial wait (0–10000 ms). There are at most four active shell processes per session and 10 MiB of captured output per process. Use `process_status`, `process_wait` and `process_stop` for process controls, rather than `&` or `sleep` loops. Use `$TMPDIR` for scratch files. Restart records unfinished process outcomes as unknown and never replays their commands.

The isolated shell environment makes pnpm fail promptly when its available version differs from `packageManager`, instead of trying to download a version over a denied network. Install and expose the matching toolchain before running checks; a version mismatch is an environment blocker, not evidence that the project build is slow.

| Control or command | Action |
| --- | --- |
| Enter | Submit a task, or steer active work at the next safe boundary |
| Shift+Enter | Insert a newline when supported by the terminal |
| Esc / `/stop` | Interrupt active work; Esc closes an open dialog |
| `/jobs` / `/stop ID` | Inspect shell tasks or stop one task without interrupting the model |
| Ctrl+C | Interrupt active work, or exit when idle |
| `/queue TASK` | Run a follow-up task after the current task |
| `/continue` | Explicitly continue unfinished work or inspected recovery state |
| `/compact` | Summarize older exchanges while retaining raw history |
| `/undo` | Restore the latest file checkpoint if it has not changed externally |
| `/memory [all|ID]` | Browse explicit project memories; `all` includes inactive records |
| `/status` | Show session details and estimated context usage with output/safety reserves |
| `/mode` / `/permissions` | Select permissions |
| `/sandbox` | Inspect sandbox status |
| `/language` / `/lang` | Select interface language |
| `/help` | Show available commands |
| `/exit` | Cancel work, wait for cleanup, and exit |

The interface defaults to English. Use `/language en` or `/language zh-CN` to switch immediately. The preference is saved in `~/.config/loom/settings.json` across projects. Command names remain stable; model responses, existing messages, code, and raw tool output retain their original language.

## Models and configuration

**Vercel AI Gateway is the only supported route.** The default chat model is `deepseek/deepseek-v4.1-flash`.

```sh
loom --model openai/gpt-6.1-sol
loom --model openai/gpt-6.1-sol --reasoning high
loom --models
```

| Setting | Purpose | Default |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | Gateway authentication | Required for model requests |
| `--model` / `LOOM_MODEL` | Chat model | `deepseek/deepseek-v4.1-flash` |
| `--reasoning` | Reasoning level supported by the selected model | `off` |
| `--cwd` | Workspace directory | Current directory |
| `--mode` | Initial permissions | `ask` |
| `--sandbox` | `required` or explicit host execution with `off` | `required` |
| `--computer` | Host desktop tools: `off` or `cua` | `off` |
| `--cua-driver` | Driver executable path; requires `--computer cua` | `cua-driver` on PATH |
| `--steps` | Shared chat-model call allowance, from 1 to 500 | Unlimited |
| `--verify` | Completion review: `auto`, `off`, or observational `shadow` | `auto` |
| `--supervise` | Independent progress assessment during execution: `auto` or `off` | `auto` |
| `--decision-model` / `LOOM_DECISION_MODEL` | Classifier for progress and completion review | `openai/gpt-6-luna-decisions` |

CLI flags override the corresponding environment variables. Reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Runs have no model-call or wall-clock limit by default. Set `--steps N` to cap chat calls; delegated work, compaction, and explicit retries share that allowance. Esc still interrupts a running task.

`loom --models` and `loom --decision-models` read the pinned model catalog without API calls. Catalog metadata and cost estimates can differ from current gateway availability, limits, or billing. Direct providers, custom endpoints and `LOOM_PROVIDER` are not supported. [`.env.example`](.env.example) documents environment variables; Loom does **not** automatically load `.env` files.

## Progress supervision and completion evaluation

Progress supervision is on by default. During sustained investigation, or repeated reads/failures/history-only work, an independent decision model compares the original requirements with current tool arguments and results. Commentary, import checks and exit code zero alone are not treated as useful progress. Confident stagnation judgments provide a persistent direction to implement a scoped authorized change, verify behavior, change the method, inspect one missing fact, or explain a concrete blocker. Research requests and plan mode do not receive implementation directions.

The first check occurs after twelve tool rounds or earlier on a strong repeated pattern; subsequent checks are at least eight rounds apart. Each request uses at most 32 KiB of questions and evidence, has a five-second deadline, and does not retry. Failures increase the interval and leave work running. Checks add billed usage but do not consume chat steps or impose a task limit. `/status` shows the configured model and decision usage. `loom --supervise off` disables these calls; local progress reminders remain available. Semantic judgments can be wrong, and guidance does not guarantee model compliance or successful fixes.

Completion review is also enabled by default. Before a root task settles, the classifier checks requirements, unsupported claims and missing verification. A confident unmet requirement with an available authorized action can continue automatically. The UI distinguishes supported completion, unverified results and concrete blockers. Permission modes and project command restrictions still apply; research tasks do not require writes.

To prevent a separate stop-hook loop, an ending can receive at most two corrective continuations per user input, and a repeated ending without new tool execution settles as unverified. This does not cap ordinary tool rounds. Uncertainty, service failures or missing verification capabilities never become verified success. Unverified and blocked tasks remain explicitly resumable; opening a session never starts execution.

Both assessments use `openai/gpt-6-luna-decisions` by default through the gateway's separate classifier interface. Each completion request is bounded to 64 KiB, has a five-second deadline and no transport retry; usage is included in totals. Configure it independently:

```sh
loom --verify shadow
loom --verify off
loom --verify shadow --decision-model typesafe-ai/jev
loom --decision-models
```

`shadow` records at most three post-task evaluations per run without changing execution. `off` disables completion review independently of `--supervise`. SDK clients supply `decisionModel` and `verification: 'auto'` to enable the ending boundary. Classifier judgments remain fallible; offline tests establish control flow, not real-model accuracy.

Bounded workspace hashes observe changes around write and shell tools, including partial effects from failed commands. Coverage limits are explicit, concurrent changes are not attributed exclusively to Loom, and changes do not prove correctness. The journal records intervention follow-ups and task metrics such as first observed change, changed-file counts and reported usage.

## Sessions and recovery

Sessions are stored under `WORKSPACE/.loom/sessions/SESSION_ID/`.

```sh
loom resume                   # Choose a session in this workspace
loom resume --last            # Open the latest available session
loom resume SESSION_ID        # Open a specific session
loom resume --list            # List sessions without API credentials
loom resume --list --json     # Machine-readable session catalog
```

**Opening a session loads history without executing the task again.** Use `/continue` to resume unfinished work or pending inputs. Completed sessions with no pending work do not call the model when continued. Opening uses your current model configuration and fresh permission grants.

The picker shows the first task, update time, execution state, and pending input count. Only root sessions in the current workspace are selectable; busy sessions are visible in lists but cannot be opened. In a non-terminal environment, plain `loom resume` lists sessions.

Context is rebuilt from the journal on each step. Compaction retains recent complete exchanges and separately carries bounded current-task inputs and tool-outcome references, marking any omissions. Output and safety space are reserved before requests; automatic compaction must reduce estimated input size. Original history remains on disk; explicit project memory is described below.

The model can use `search_history` to search literal text and `read_history` to read source-linked visible evidence by sequence, including evidence omitted by compaction. Source pages exclude private reasoning, provider metadata and copied recall, while original journals remain unchanged. Search defaults to the current session; workspace scope discovers other root sessions in this project, and `sessionId` narrows searches to one source. Recall queries and copied responses are not indexed. Delegated agents can only recall their own session. Results are historical evidence and must be rechecked when code or requirements have changed.

Search lazily builds a rebuildable `.loom/history.sqlite` cache in a Worker. Changed index rules automatically rebuild derived data without changing original journals. Close Loom before manually deleting that cache; source reads and session recovery remain independent. Node may print an experimental SQLite warning. Session listing still scans journals without modifying them. Storage limits and implementation details are in the [architecture guide](docs/architecture.md).

During execution, local pattern checks display investigation reminders; default independent supervision adds evidence-based judgments during sustained investigation. Neither sets a run limit or establishes task success. Completion claims should identify evidence matching the original requirement and state verification gaps, including visual behavior that has not been observed.

Recovery uses recorded tool results rather than automatically replaying effects. A tool call started without a recorded outcome is marked unknown and blocks execution until you inspect the outcome and explicitly continue. The model can still request another operation, so this is not an exactly-once guarantee. Unfinished work resumes before queued tasks; a crash during shadow evaluation does not reopen an already completed task.

Session listing scans local logs and skips unreadable, malformed, or oversized logs with a count. There is no incremental catalog index yet. See [architecture and recovery invariants](docs/architecture.md) for details.

## Project memory

Ask Loom to “remember that this project uses pnpm” to save a source-backed record with `remember`. Memory writes use ordinary mode permissions: approval in `ask`, automatic in `edit`/`auto`, unavailable in `plan`. The model is instructed to save only on explicit user requests; there is no background extraction or automatic injection into every prompt. Relevant recall uses `list_memories` and `get_memory`; the latter checks original source events. Find source sequences through `search_history`/`read_history`.

Use `/memory` to browse active records, `/memory all` to include inactive records, or `/memory ID` to inspect provenance. Records support project or relative-path scope, optional expiration, immutable revisions and version-checked updates. `forget_memory` marks records stale or archived; it retains earlier revisions and is **not physical deletion**. Source hashes detect changed or unavailable evidence, not whether code still matches a remembered fact. Listings leave sources unchecked; inspect a record before relying on it.

`.loom/memory.sqlite` is authoritative storage, separate from the rebuildable history cache. **Do not delete it to rebuild history.** Close Loom before backing up its metadata. Records and journals may contain private information; avoid saving secrets. Memory is local to the current workspace, without global or shared worktree memory. Cancellation or a crash can leave a committed mutation with an unknown journal outcome: inspect records before retrying. Identical call receipts prevent duplicate execution only for the same session/call identity, not arbitrary retries.

## Headless use

```sh
# Inspect without allowing changes or shell commands.
loom --mode plan --print 'Explain the project structure' --json

# Allow file changes and sandboxed commands without interactive approval.
loom --mode auto --print 'Fix the failing test and verify the change' --json

# Explicitly continue a saved task without a TUI.
loom resume SESSION_ID --resume --json
```

Calls requiring interactive approval are denied in headless mode. Choose `--mode edit` for automatic file changes or `--mode auto` for automatic shell execution and enabled computer actions. Interrupted, failed, or recovery-blocked runs return a nonzero exit code. Use `loom --help` for the complete CLI options.

## Architecture and development

The TUI and headless CLI share the same core:

| Boundary | Responsibility |
| --- | --- |
| `src/core/` | Agent loop, durable sessions, recovery, budgets, and completion evaluation |
| `src/model/` | Gateway chat and decision-model adapters |
| `src/tools/` | Tool definitions, permission dispatch, file checkpoints, and delegation |
| `src/storage/` | SQLite Workers for history and explicit memory |
| `src/execution/` | Shell execution, sandbox configuration, and cancellation |
| `src/ui/` | Terminal rendering, transient state, commands, and translations |

`src/index.js` exports `Agent`, `Session`, `Dispatcher`, `createTools`, chat and decision model factories/catalogs, `ShellExecutor`, `CuaComputer`, `sandboxStatus`, `HistoryStore`, and `MemoryStore`. SDK clients explicitly enable computer access with `new Agent({ ..., computer: new CuaComputer() })`. Initialize the agent before enqueueing work, wait for completion, and always close it. Standalone storage clients must also close their Worker.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run check:package
```

Checks cover Standard Style, one-sentence comments above top-level declarations, behavioral tests with fake providers and local HTTP servers, and packed CLI/SDK smoke tests. They do not require paid model credentials. Linux shell tests need the sandbox dependencies described above.

Start with [CONTRIBUTING.md](CONTRIBUTING.md), the [architecture guide](docs/architecture.md), [CHANGELOG.md](CHANGELOG.md), and the [release checklist](docs/releasing.md). General MCP server configuration, persistent OAuth, executable plugins, distributed coordination, container executors, and sandbox network allowlists are not implemented.

## License and acknowledgments

Loom Code is licensed under [MIT](LICENSE). Pi dependencies retain their MIT licenses; Anthropic sandbox-runtime retains its Apache-2.0 license. See [NOTICE](NOTICE).

The design draws on Pi, Codex, OpenCode, and publicly documented Claude Code behavior. Loom's orchestration is implemented in this repository; it does not rely on access to Claude Code's private runtime.
