# Security

Loom 0.1 is an early local coding-agent implementation. It is intended for workspaces and host environments you control. OS sandboxing is not implemented.

## Permission boundaries

| Mode | File writes | Host shell |
| --- | --- | --- |
| `ask` (default) | Approval required | Approval required |
| `edit` | Allowed | Approval required |
| `auto` | Allowed | Allowed without prompts |
| `plan` | Denied | Denied |

File tools confine paths to the workspace and protect `.git/` and `.loom/`. These checks do not sandbox shell commands, prevent malicious local races, or constrain a child process's network access. A model's response is not an enforcement boundary; the dispatcher enforces permissions.

Shell subprocesses omit environment variable names containing `API_KEY`, `TOKEN`, `SECRET`, or `PASSWORD`, but this is not a general credential isolation guarantee. Sessions, file checkpoints, and tool artifacts under `.loom/` can contain sensitive workspace content. Keep that directory out of version control and inspect logs before sharing them.

## Reporting

For a published GitHub repository with private vulnerability reporting enabled, use its **Security → Report a vulnerability** page. Before that channel is available, open an issue asking for a private reporting channel without including exploit details, secrets, or affected private code. No dedicated security inbox is configured yet.

Maintainers should enable GitHub private vulnerability reporting before announcing a public release. No response-time commitment or long-term support policy is established for this early version.
