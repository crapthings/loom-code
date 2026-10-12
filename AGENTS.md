# Loom development rules

- Write ESM JavaScript using JavaScript Standard Style.
- Explain every top-level declaration with one sentence directly above it; split responsibilities that cannot be explained in one sentence.
- Keep model, session, tools, and UI independent through explicit interfaces.
- All tools, including delegated calls, must pass through the dispatcher.
- Persist tool intent before execution and settle every call even after cancellation.
- Never automatically replay an external side effect after a crash.
- Run `pnpm run check` after implementation changes; tests must use fake providers and temporary workspaces, never paid APIs.
- Manage dependencies with pnpm, install with `pnpm install --frozen-lockfile --ignore-scripts`, and pin direct dependencies.
