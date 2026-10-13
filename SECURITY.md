# Security

Loom 0.1 is an early local coding-agent implementation. It is intended for workspaces and host environments you control. Shell isolation is mandatory by default through sandbox-runtime 0.0.79: Seatbelt on macOS and bubblewrap on Linux. The old v0.1.0 release predates this change; consult the version you actually run.

## Permission boundaries

| Mode | File writes | Host shell |
| --- | --- | --- |
| `ask` (default) | Approval required | Approval required |
| `edit` | Allowed | Approval required |
| `auto` | Allowed | Allowed without prompts |
| `plan` | Denied | Denied |

Permission modes do not disable isolation. `--sandbox required` limits shell writes, denies personal directories and common credential files, protects the runtime and metadata, and denies network access. Missing/degraded dependencies or policy setup errors block the command without host fallback. Only an explicit CLI `--sandbox off` opts out. Model API traffic and file tools run outside the shell sandbox.

File tools separately confine paths and deny common credential files and metadata. They do not prevent malicious local races or hard-link attacks. Reads by shell processes are not a strict workspace-only whitelist: system runtime files remain readable, while personal and temporary directories are denied with explicit carve-outs. The sandbox is not a VM, CPU/memory/disk quota, or a formal guarantee against every escape. macOS process-group cleanup does not guarantee tracking deliberately detached descendants. See [sandbox.md](docs/sandbox.md).

History recall is a deliberate, narrower metadata interface: `search_history` and `read_history` can read validated session journals in the current workspace even though ordinary file tools cannot read `.loom/`. Search defaults to the current session; a root agent may explicitly search other root sessions in the same workspace, while delegated agents can only recall their own session. These records can contain private prompts, source, and tool output. Cross-project reads, arbitrary paths, SQL, and SQLite extensions are unavailable through these tools. Recalled text is untrusted historical evidence and never grants execution permission.

The optional `.loom/history.sqlite` index is a rebuildable cache, created with restrictive file permissions and operated in a bounded Worker. Cache failure becomes a tool error and does not change session recovery or replay effects. Real-directory and regular-file checks reject common redirects but cannot eliminate filesystem replacement races by another local process. Retention or deletion policies must consider both source journals and the cache; stopping Loom and deleting the cache permits rebuilding it from retained journals.

Shell environments are built from an allowlist and use an isolated temporary home/cache. They do not inherit model credentials, database URLs, SSH agent sockets, or executable startup hooks. Secrets can still exist in ordinary project files; protected filename rules are not a universal secret detector. Sessions, file checkpoints, and tool artifacts under `.loom/` can contain sensitive workspace content. Keep that directory out of version control and inspect logs before sharing them.

## Memory and retention

Explicit project memory is a separate, authoritative `.loom/memory.sqlite` database; it cannot be rebuilt from the history cache and must not be deleted as cache maintenance. Only root agents receive memory tools. Mutations pass through Dispatcher write permissions and preserve immutable revisions with source hashes and optimistic version checks. Sources must be original user inputs or completed, successful non-recall tool results from validated same-workspace journals. This validates provenance, not truth or explicit semantic authorization; the model instruction to remember only on request is not a security boundary.

Memory uses DELETE journals and EXTRA synchronization, fixed operations, disabled SQLite extensions and bounded worker requests. Reads are lazy; database corruption is reported without automatic deletion or repair. Cancellation may stop the worker after commit but before acknowledgment; inspect stored records before retrying. Atomic receipts deduplicate the same session/call identity, not new calls. Archiving retains data; privacy retention must cover the database, revisions, receipts, journals, caches and backups. Current limits bound individual inputs and source scans, not total revision history or disk use. Another local process can still race filesystem checks.

## Reporting

For a published GitHub repository with private vulnerability reporting enabled, use its **Security → Report a vulnerability** page. Before that channel is available, open an issue asking for a private reporting channel without including exploit details, secrets, or affected private code. No dedicated security inbox is configured yet.

Maintainers should enable GitHub private vulnerability reporting before announcing a public release. No response-time commitment or long-term support policy is established for this early version.
