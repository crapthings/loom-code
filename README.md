# Loom Code

[![CI](https://github.com/crapthings/loom-code/actions/workflows/ci.yml/badge.svg)](https://github.com/crapthings/loom-code/actions/workflows/ci.yml)

English | [中文](README.zh-CN.md)

A local coding agent with a terminal UI, written in ESM JavaScript with Standard Style. Loom implements its own agent loop, tool dispatcher, durable sessions, permissions, cancellation, and read-only delegation. Model protocols and terminal components come from Pi.

**Early 0.1 release.** Install from source; this package is not published to npm. Local terminal validation has been performed on macOS; automated checks pass on Linux and macOS with Node.js 22.19.0 and 24. Windows is not yet validated.

## Install from source

Requires Node.js **>=22.19.0** (24 recommended) and **pnpm 12.4.1**.

After cloning or downloading this repository, run from its root:

```sh
git clone https://github.com/crapthings/loom-code.git
cd loom-code
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm add --global "$PWD" --ignore-scripts
```

If pnpm reports that its global bin directory is missing from PATH, run `pnpm setup` and reopen the terminal. For an existing older pnpm shell configuration, inspect it before using `pnpm setup --force`. With pnpm 12, global commands live in `$PNPM_HOME/bin`.

The global installation links to this checkout. Keep the source directory and its dependencies; changes take effect on the next launch. No dependency installation is needed in the projects you work on. To uninstall, run `pnpm remove --global loom-code`.

## Start in any project

```sh
export AI_GATEWAY_API_KEY='YOUR_VERCEL_GATEWAY_KEY'
cd /path/to/project
loom
```

The default route is **Vercel AI Gateway**, with model **`deepseek/deepseek-v4.1-flash`**. The current directory becomes the workspace. The built-in Pi adapter uses Vercel's Anthropic Messages-compatible API; requests use the fixed Vercel gateway endpoint. See the [Vercel model documentation](https://vercel.com/ai-gateway/models/deepseek-v4.1-flash).

For an offline demo with real file inspection but a deterministic model:

```sh
loom --demo
# Or, before global installation:
pnpm run demo
```

## Permissions and controls

Enter `/mode` or `/permissions` to open the permission selector. Direct commands are also available:

| Command | File writes | Host shell |
| --- | --- | --- |
| `/mode ask` (default) | Ask each time | Ask each time |
| `/mode edit` | Automatic | Ask each time |
| `/mode auto` | Automatic | Automatic |
| `/mode plan` | Denied | Denied |

**Shell commands require an OS sandbox by default:** Seatbelt on macOS, bubblewrap on Linux. Auto mode skips approval but keeps the sandbox. Shell network access is denied, writes are limited, and isolation failures never fall back to host execution. See [sandbox design and setup](docs/sandbox.md) and [security boundaries](SECURITY.md).

Approval defaults to **Deny**. **Allow once** approves the current call; **Allow for this session** approves subsequent calls to that tool for the current run (all subsequent shell commands for a shell grant), within the selected sandbox. Other tools need separate grants. Choosing `/mode`, even the current mode, clears grants; exiting or reopening a saved session also clears them.

Use `loom --sandbox-status` or `/sandbox` to inspect dependencies. Linux requires `bubblewrap`, `socat`, and `ripgrep` plus host support for unprivileged namespaces. Install project dependencies yourself before running offline coding tasks. `--sandbox off` explicitly selects unsandboxed host execution; it cannot be enabled by a model or `/mode`. Model API traffic is outside the shell sandbox.

Stop or finish active work before changing permissions. Changes update the instructions, tool declarations, dispatcher, and header together, and are recorded in the session. Restarting defaults to `ask`; delegated agents always remain read-only.

| Control | Behavior |
| --- | --- |
| Enter | Submit a task or steer active work at the next safe boundary |
| Shift+Enter | Insert a newline, depending on terminal support |
| Esc / `/stop` | Interrupt active work |
| `/queue TASK` | Schedule work after the current task |
| `/continue` | Explicitly resume interrupted work or acknowledge inspected unknown effects |
| `/compact` | Summarize older exchanges while keeping raw history |
| `/undo` | Restore the latest file checkpoint if the file has not changed externally |
| `/status` | Show session ID, directory, and runtime status |
| `/language` or `/lang` | Open the interface language selector |
| `/language en` / `/language zh-CN` | Switch to English / Simplified Chinese immediately |
| `/help` | List commands |
| `/exit` | Cancel work, wait for cleanup, and close the terminal UI |

The interface defaults to English. Language choices are saved atomically in `~/.config/loom/settings.json` and apply across projects on future launches. Commands keep their stable names; model responses, code, previous messages, raw tool output and diagnostic errors keep their original language. Changing the UI language does not change permissions or session grants. Translation catalogs live in `src/ui/locales/`, with named placeholders and English fallback.

Approval dialogs default to **Deny**. Use arrow keys and Enter to select, or Esc to cancel.

## Gateway models

```sh
loom --model openai/gpt-5.4
loom --models
```

Vercel AI Gateway is the only supported production route. `--model` / `LOOM_MODEL` selects a model on that gateway; authentication uses `AI_GATEWAY_API_KEY`. Direct providers and custom endpoint flags are unavailable. Select a model that supports tools.

Model metadata and cost estimates come from the pinned Pi catalog and can differ from current gateway limits or billing. `.env.example` documents variables; Loom does **not** automatically load `.env` files.

## Sessions, tools, and delegation

Sessions live in `WORKSPACE/.loom/sessions/SESSION_ID/`. Add `.loom/` to the target project's `.gitignore`: logs and checkpoints can contain source code, user input, and tool results.

```sh
loom resume                   # Pick a session in the current workspace
loom resume --last            # Open the most recent session that is not busy
loom resume SESSION_ID        # Open a specific existing root session
loom resume --list            # List without opening a writer or requiring API credentials
loom resume --list --json     # Machine-readable catalog
loom --session SESSION_ID     # Original explicit session option
```

The picker shows the first task, update time, execution state, and pending input count. Sessions in other projects and child-agent sessions are excluded. Busy sessions remain visible in text/JSON lists but cannot be selected. Esc or Ctrl+C cancels the picker without creating a session. Non-terminal `loom resume` prints the list; automated execution must specify an ID or `--last`, plus `--resume` or `--print`.

Listing does not repair torn logs or reclaim stale locks; those are handled only when opening a selected session. Unreadable, malformed, or oversized logs (over 16 MiB) are skipped with a count. Listing currently scans local logs; large histories will need an incremental index. Opening uses the current model configuration and defaults to `ask`, without restoring session approval grants.

Reopening loads history without continuing automatically. `/continue` starts work only when a task was interrupted or failed, tool outcomes require recovery, or saved inputs remain; fresh and completed sessions display a notice without calling the model. Unfinished work resumes before queued tasks, using recorded tool results rather than replaying calls. A model may still request a repeated operation, so this is not an exactly-once guarantee. After a crash, started calls without outcomes are marked unknown and block further execution until inspected and explicitly resumed. Loom never automatically replays those effects and does not promise exactly-once execution.

File tools support reading, listing, literal search, hash-checked writes and edits, and reversible checkpoints. Shell output is bounded, with stored artifacts for longer output. Research/review subagents use separate sessions and read-only tools, sharing cancellation and the run budget. Root `AGENTS.md` and `.agents/skills/NAME/SKILL.md` provide project guidance and lazy skill instructions.

The default run budget is 30 model calls and 15 minutes, shared by delegated work, compaction, and explicit retries. Full details and implementation invariants are in [architecture.md](docs/architecture.md).

## Headless use and development

```sh
loom --mode plan --print 'Explain the project structure' --json
loom --demo --print 'Inspect the workspace'
pnpm run check
pnpm run check:package
```

Headless mode denies calls requiring interactive approval. `--mode edit` permits file tools; `--mode auto` also permits shell execution. Interrupted, failed, or recovery-blocked runs return a nonzero exit code.

`src/index.js` exports the reusable Agent, Session, Dispatcher, and model factories. Initialize the agent before enqueueing work, wait for completion, and always close it. The same core powers the TUI and headless CLI.

Checks enforce Standard Style, one-sentence comments above top-level declarations, behavioral tests with fake providers/local HTTP servers, and a packed-CLI smoke test. Paid-provider acceptance is separate; automated checks never require model credentials. Results are available in [GitHub Actions](https://github.com/crapthings/loom-code/actions/workflows/ci.yml).

## Scope and contributing

MCP, persistent OAuth, executable plugins, distributed coordination, container executors, and sandbox network allowlists are not implemented. Help improve the local coding loop first; see [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and the [release checklist](docs/releasing.md).

Loom is licensed under [MIT](LICENSE). Pi dependencies retain their MIT licenses; sandbox-runtime retains its Apache-2.0 license. See [NOTICE](NOTICE). Architecture research credits Pi, Codex, OpenCode, and publicly documented Claude Code behavior without claiming access to Claude Code's private runtime.
