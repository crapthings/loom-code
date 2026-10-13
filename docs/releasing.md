# Release checklist

The repository is public at [crapthings/loom-code](https://github.com/crapthings/loom-code). Distribution is currently source-only; `private: true` prevents npm publication. Keep that guard until package ownership and a publication workflow are established.

1. Review the intended diff and tracked files. Exclude sessions, credentials, dependency directories, archives and machine-specific data.
2. Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run check` and `pnpm run check:package`.
3. Verify installation from a fresh clone. Packed smoke tests do not replace clean dependency installation or live-provider acceptance.
4. Update both READMEs, security boundaries and `CHANGELOG.md` for observable changes. Verify local links and CLI examples; preserve historical release entries.
5. Merge into `main` and wait for all required GitHub checks on that exact commit. Local checks alone do not satisfy branch checks.
6. For a versioned release, choose the next version, update `package.json` and the lockfile, date the changelog entry, then tag the verified commit and publish GitHub release notes derived from that entry. Do not reuse an existing tag.
7. Confirm private vulnerability reporting and branch rules remain enabled. Include known limitations and distinguish offline tests from real-model evaluation.

Use the maintainer's own GitHub authentication (`gh auth status` / `gh auth login`); never store tokens in project files. A push to `main` is a source update, not an npm publication or a versioned GitHub release.
