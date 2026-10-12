# Contributing to Loom

Issues and pull requests may be written in English or Chinese.

## Local setup

Use Node.js >=22.19.0 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run demo
pnpm run check
pnpm run check:package
```

The checks use fake providers and local HTTP servers, with temporary workspaces. They do not need API keys or make paid model requests. Real provider acceptance is separate from CI.

## Code conventions

Read [AGENTS.md](AGENTS.md). Write ESM JavaScript with Standard Style. Put a one-sentence explanation immediately above each top-level declaration. Split responsibilities that need more than one sentence. Pin direct dependency versions and update `pnpm-lock.yaml` with pnpm.

Keep the UI, model protocols, orchestration, tools, and durable session store behind explicit interfaces. All tools must go through the dispatcher, including delegated execution. Mode changes must update the model instructions, tool declarations, and execution policy together.

For behavioral changes, add focused coverage of the observable behavior. Persistence and cancellation changes should verify call-result pairing, unknown effects, and cleanup where relevant. Do not automatically replay external effects after a crash.

## Pull requests

Keep each pull request focused. Explain the problem and final behavior, then include validation and material limitations. Avoid attaching local sessions, credentials, private code, or generated dependency directories. See [architecture.md](docs/architecture.md) for invariants and extension points.

If you find a security issue, follow [SECURITY.md](SECURITY.md) instead of posting exploit details in a public issue.
