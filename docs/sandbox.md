# Shell sandbox

Loom uses pinned `@anthropic-ai/sandbox-runtime@0.0.81` with Seatbelt on macOS and bubblewrap on Linux. Dispatcher controls authorization; ShellExecutor controls isolation. File tools enforce their own paths and version checks outside the shell sandbox.

## Setup and diagnosis

```sh
loom --sandbox-status
loom
# Inside the TUI: /sandbox
```

Linux requires `bubblewrap`, `socat`, `ripgrep` and host support for unprivileged namespaces:

```sh
sudo apt-get install bubblewrap socat ripgrep
```

Dependency checks establish component availability, not whether host policy allows execution. Ubuntu AppArmor restrictions can block namespace creation even when checks pass. An administrator must review targeted `userns` policy for bubblewrap and the runtime seccomp helper; Loom does not modify host policy. CI uses targeted profiles rather than globally disabling AppArmor. See the [compatibility issue](https://github.com/openai/codex/issues/15057).

Install project dependencies in your own terminal before asking Loom to run offline builds or tests. Shell networking is denied, including access to local services. Model API requests run outside this sandbox. Isolated HOME/cache directories can make user-installed toolchains unavailable. Windows has no supported backend.

## Policy

Default `--sandbox required` checks dependencies and constructs policy for each command. Missing or degraded capabilities, initialization errors and unsupported policy patterns fail the tool. There is no automatic host fallback. Only explicit startup `--sandbox off` selects host execution; `/mode auto` changes approval, not isolation.

| Boundary | Policy |
| --- | --- |
| Writes | Workspace and a private per-call temporary directory; protect `.git`, `.loom`, agent/IDE metadata, common credentials and the running Loom installation |
| Reads | Deny personal/user and general temporary directories, with carve-outs for the workspace, call scratch directory and Node executable directory; system runtime files remain readable |
| Network | Deny external domains, direct TCP, Unix sockets and local listening; runtime denial proxies are internal infrastructure |
| Environment | Small allowlist with isolated HOME/TMPDIR/cache; exclude API keys, database URLs, SSH agents and executable startup hooks |
| Helpers | Linux helpers come from fixed system directories and seccomp binaries from the pinned dependency, never project PATH |
| Lifecycle | Bound command duration/output, cancel process groups, settle tool results and clean runtime/scratch resources |

Each command owns a SandboxManager in an isolated Node worker. Its configuration, proxy resources and cleanup remain alive until that command's process group stops, so background commands do not hold a cross-session global lock or reset another command's policy. Diagnostic and injected managers are serialized within their own worker. The child environment is sanitized, including `pnpm_config_pm_on_fail=error` to reject unavailable package-manager versions without a network download. Project guidance and skills use controlled loaders; workspace configuration cannot expand shell permissions.

ProcessManager persists launch intent before spawning, returns a process ID after a short wait and records a separate completion event. Waiting does not terminate the process; only an explicit execution deadline, cancellation, failure or output limit does. An IPC-connected runner owns the Unix process group and kills it if the harness connection disappears. On normal completion, a short idle drain handles descendant-held stdout/stderr before group cleanup. Commands that deliberately escape their process group remain a limitation. Crash recovery marks unfinished outcomes unknown and never replays commands or signals stale PIDs from history.

## Limits and validation

Native tests cover permitted workspace/scratch access, denied outside paths and credentials, protected metadata, symlink escapes, TCP/Unix sockets, initialization failure, cancellation and a sandboxed JavaScript test run. They are behavioral checks, not a formal security proof.

- Filesystem checks cannot eliminate malicious local TOCTOU or hard-link races.
- System runtime reads remain possible; this is not a strict workspace-only read whitelist.
- There are no CPU, memory or disk quotas, and the sandbox is not a VM.
- macOS process-group cleanup cannot guarantee tracking deliberately detached descendants.
- Linux read globs hide matches present at command wrapping; later matching files are not automatically covered. Write denies use literal paths, with known root credential paths protected. macOS patterns can cover later matches. Neither policy is a universal secret detector.
- The runtime is experimental; network allowlists, trusted toolchain configuration, container executors and controlled service tests are not implemented.

See [SECURITY.md](../SECURITY.md) for reporting and data-retention boundaries.

## Provenance

The choice follows native isolation in [Codex](https://github.com/openai/codex/blob/a9b0815/codex-rs/linux-sandbox/README.md), the [Claude Code sandbox design](https://code.claude.com/docs/en/sandboxing), and [Pi's sandbox extension](https://github.com/earendil-works/pi/blob/c661bc5/packages/coding-agent/examples/extensions/sandbox/index.ts). Runtime code comes from [Anthropic sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime). Permissions and worktrees alone do not constitute OS isolation. General agent references are in [architecture.md](architecture.md).
