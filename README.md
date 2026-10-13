# Loom Code

[![CI](https://github.com/crapthings/loom-code/actions/workflows/ci.yml/badge.svg)](https://github.com/crapthings/loom-code/actions/workflows/ci.yml)

English | [中文](README.zh-CN.md)

A local coding agent for your terminal. Start `loom` in a project, describe a task, and let it inspect files, make changes, run commands, and report the result.

Loom implements its own agent loop, tool dispatch, permissions, durable sessions, cancellation, and read-only delegation. It uses Pi for model protocols and terminal components, Zustand for transient UI state, and OS sandboxing for shell execution. The codebase is ESM JavaScript with Standard Style, managed with pnpm.

**Early development, version 0.1.0.** Install from source; the package is not published to npm. Local terminal testing has been performed on macOS, and CI targets Linux and macOS with Node.js 22.19.0 and 24. Production readiness and coding quality have not been established.

## Quick start

Requires **Node.js >=22.19.0** and **pnpm 12.4.1**.

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
- Delegate research and review to read-only agents sharing the run budget.
- Accept steering during active work, queue follow-up tasks, and interrupt execution.
- Reopen local sessions and explicitly continue unfinished work.
- Record optional completion judgments from a separate decision model.

Root `AGENTS.md` supplies project instructions. Skills in `.agents/skills/NAME/SKILL.md` are discovered and loaded on demand. Delegated agents cannot write files, change permissions, or delegate further.

## Permissions and sandboxing

Open `/mode` or `/permissions` to choose a mode, or switch directly:

| Mode | Read tools | File changes | Shell commands |
| --- | --- | --- | --- |
| `/mode ask` — default | Automatic | Approval required | Approval required |
| `/mode edit` | Automatic | Automatic | Approval required |
| `/mode auto` | Automatic | Automatic | Automatic |
| `/mode plan` | Automatic | Denied | Denied |

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

## Terminal controls

| Control or command | Action |
| --- | --- |
| Enter | Submit a task, or steer active work at the next safe boundary |
| Shift+Enter | Insert a newline when supported by the terminal |
| Esc / `/stop` | Interrupt active work; Esc closes an open dialog |
| Ctrl+C | Interrupt active work, or exit when idle |
| `/queue TASK` | Run a follow-up task after the current task |
| `/continue` | Explicitly continue unfinished work or inspected recovery state |
| `/compact` | Summarize older exchanges while retaining raw history |
| `/undo` | Restore the latest file checkpoint if it has not changed externally |
| `/status` | Show session ID, directory, and runtime status |
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
| `--steps` | Shared chat-model call allowance, from 1 to 500 | `30` |
| `--verify` | `off` or observational completion evaluation with `shadow` | `off` |
| `--decision-model` / `LOOM_DECISION_MODEL` | Separate completion classifier | `openai/gpt-6-luna-decisions` |

CLI flags override the corresponding environment variables. Reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. The default run deadline is 15 minutes; delegated work, compaction, and explicit retries share the chat-call budget.

`loom --models` and `loom --decision-models` read the pinned model catalog without API calls. Catalog metadata and cost estimates can differ from current gateway availability, limits, or billing. Direct providers and custom endpoints are not supported. [`.env.example`](.env.example) documents environment variables; Loom does **not** automatically load `.env` files.

## Optional completion evaluation

Use a separate decision model to observe whether completed tasks appear to cover the requirements, make unsupported claims, or lack verification:

```sh
loom --verify shadow
loom --verify shadow --decision-model typesafe-ai/jev
loom --decision-models
```

Shadow evaluation is off by default. Its default model is `openai/gpt-6-luna-decisions`, using the same gateway key as the chat model. Decision models have a separate classifier interface and cannot be selected with `--model`.

After a root task ends normally, Loom commits task completion before evaluating bounded task evidence. The judgment is displayed and saved, but does not change permissions, tool execution, the chat model's context, or trigger a retry. Child tasks are not evaluated.

Each run permits at most three decision calls, with a five-second deadline per call and no transport retries. Failures, refusals, malformed responses, and timeouts leave the task result intact. Interrupted decision calls are not replayed during recovery. Calls can add latency and billed usage; usage may be unknown after a timeout or interruption.

Session records preserve evaluation inputs, their hash, answers, timing, and reported usage. Headless JSON output includes `verification.finished` events. These judgments are observations, not correctness guarantees: compare them with human-reviewed results and actual tests before using them to drive execution policy. Automated tests use fake classifiers and do not establish live-model accuracy.

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

Recovery uses recorded tool results rather than automatically replaying effects. A tool call started without a recorded outcome is marked unknown and blocks execution until you inspect the outcome and explicitly continue. The model can still request another operation, so this is not an exactly-once guarantee. Unfinished work resumes before queued tasks; a crash during shadow evaluation does not reopen an already completed task.

Session listing scans local logs and skips unreadable, malformed, or oversized logs with a count. There is no incremental catalog index yet. See [architecture and recovery invariants](docs/architecture.md) for details.

## Headless use

```sh
# Inspect without allowing changes or shell commands.
loom --mode plan --print 'Explain the project structure' --json

# Allow file changes and sandboxed commands without interactive approval.
loom --mode auto --print 'Fix the failing test and verify the change' --json

# Explicitly continue a saved task without a TUI.
loom resume SESSION_ID --resume --json
```

Calls requiring interactive approval are denied in headless mode. Choose `--mode edit` for automatic file changes or `--mode auto` for automatic shell execution. Interrupted, failed, or recovery-blocked runs return a nonzero exit code. Use `loom --help` for the complete CLI options.

## Architecture and development

The TUI and headless CLI share the same core:

| Boundary | Responsibility |
| --- | --- |
| `src/core/` | Agent loop, durable sessions, recovery, budgets, and completion evaluation |
| `src/model/` | Gateway chat and decision-model adapters |
| `src/tools/` | Tool definitions, permission dispatch, file checkpoints, and delegation |
| `src/execution/` | Shell execution, sandbox configuration, and cancellation |
| `src/ui/` | Terminal rendering, transient state, commands, and translations |

`src/index.js` exports `Agent`, `Session`, `Dispatcher`, `createTools`, chat and decision model factories/catalogs, `ShellExecutor`, and `sandboxStatus`. SDK clients must initialize the agent before enqueueing work, wait for completion, and always close it.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run check:package
```

Checks cover Standard Style, one-sentence comments above top-level declarations, behavioral tests with fake providers and local HTTP servers, and packed CLI/SDK smoke tests. They do not require paid model credentials. Linux shell tests need the sandbox dependencies described above.

Start with [CONTRIBUTING.md](CONTRIBUTING.md), the [architecture guide](docs/architecture.md), [CHANGELOG.md](CHANGELOG.md), and the [release checklist](docs/releasing.md). MCP, persistent OAuth, executable plugins, distributed coordination, container executors, and sandbox network allowlists are not implemented.

## License and acknowledgments

Loom Code is licensed under [MIT](LICENSE). Pi dependencies retain their MIT licenses; Anthropic sandbox-runtime retains its Apache-2.0 license. See [NOTICE](NOTICE).

The design draws on Pi, Codex, OpenCode, and publicly documented Claude Code behavior. Loom's orchestration is implemented in this repository; it does not rely on access to Claude Code's private runtime.
