# Loom Code

English | [中文](README.zh-CN.md)

A local coding agent with a terminal UI, written in ESM JavaScript with Standard Style. Loom implements its own agent loop, tool dispatcher, durable sessions, permissions, cancellation, and read-only delegation. Model protocols and terminal components come from Pi.

**Early 0.1 release.** Install from source; this package is not published to npm. Local validation has been performed on macOS. CI is configured for Linux and macOS; Windows is not yet validated.

## Install from source

Requires Node.js **>=22.19.0** (24 recommended) and **pnpm 12.4.1**.

After cloning or downloading this repository, run from its root:

```sh
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

The default route is **Vercel AI Gateway**, with model **`deepseek/deepseek-v4.1-flash`**. The current directory becomes the workspace. The built-in Pi adapter uses Vercel's Anthropic Messages-compatible API; no `--base-url` is required. See the [Vercel model documentation](https://vercel.com/ai-gateway/models/deepseek-v4.1-flash).

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

**Shell commands run on your host; there is no OS sandbox.** Auto mode authorizes execution without approval prompts. File-tool path checks do not restrict shell processes. Read the [security boundaries](SECURITY.md).

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
| `/help` | List commands |
| `/exit` | Cancel work, wait for cleanup, and close the terminal UI |

Approval dialogs default to **Deny**. Use arrow keys and Enter to select, or Esc to cancel.

## Other models and endpoints

```sh
loom --model openai/gpt-5.4
loom --models --provider vercel

# Direct provider credentials: ANTHROPIC_API_KEY / OPENAI_API_KEY
loom --provider anthropic --model claude-sonnet-4-6
loom --provider openai --model gpt-5.4

# OpenAI-compatible endpoint; authentication uses LOOM_API_KEY if set
loom --base-url http://localhost:11434/v1 --model YOUR_MODEL --context-window 32768
```

`--provider` / `LOOM_PROVIDER` and `--model` / `LOOM_MODEL` override defaults. `vercel` aliases `vercel-ai-gateway`. Setting `OPENAI_API_KEY` alone does not change the default route. Custom endpoints require an explicit model and do not receive other provider keys automatically. Select a model that supports tools.

Model metadata and cost estimates come from the pinned Pi catalog and can differ from current gateway limits or billing. Custom endpoints have no price metadata. `.env.example` documents variables; Loom does **not** automatically load `.env` files.

## Sessions, tools, and delegation

Sessions live in `WORKSPACE/.loom/sessions/SESSION_ID/`. Add `.loom/` to the target project's `.gitignore`: logs and checkpoints can contain source code, user input, and tool results.

```sh
loom --session SESSION_ID
```

Reopening loads history without continuing automatically. After a crash, started calls without outcomes are marked unknown and block further execution until inspected and explicitly resumed. Loom never automatically replays those effects and does not promise exactly-once execution.

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

Checks enforce Standard Style, one-sentence comments above top-level declarations, behavioral tests with fake providers/local HTTP servers, and a packed-CLI smoke test. Paid-provider acceptance is separate; automated checks never require model credentials. GitHub CI execution will be verified after publication.

## Scope and contributing

MCP, persistent OAuth, executable plugins, distributed coordination, and OS sandboxing are not implemented. Help improve the local coding loop first; see [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and the [release checklist](docs/releasing.md).

Loom is licensed under [MIT](LICENSE). Pi dependencies retain their own MIT licenses; see [NOTICE](NOTICE). Architecture research credits Pi, Codex, OpenCode, and publicly documented Claude Code behavior without claiming access to Claude Code's private runtime.
