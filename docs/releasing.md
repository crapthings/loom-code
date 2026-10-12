# GitHub release checklist

The initial distribution is a GitHub source repository. `private: true` prevents accidental npm publication; it does not prevent open-source use or local installation. Do not remove that guard until the npm package name, ownership, and publication workflow have been decided.

## Before publishing

1. Select the license and verify `LICENSE` and `package.json` agree.
2. Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run check`, and `pnpm run check:package`.
3. Inspect the files in `git ls-files`. Exclude `.loom/`, `node_modules/`, `.env*` (except the example), archives, credentials, and machine-specific paths.
4. Review the README, permission behavior, provider configuration, and limitations. Use a fresh clone to verify local installation.
5. Decide the GitHub owner and repository name. Set the actual `repository`, `homepage`, and `bugs` URLs in `package.json` after that decision; do not publish placeholder URLs.
6. Review the initial commit and push to the intended repository. Enable private vulnerability reporting and branch protection, then verify GitHub CI on Linux and macOS.
7. Change the changelog's Unreleased heading to the release date, create tag `v0.1.0`, and publish release notes listing validation and known limitations.

The local package smoke check verifies a packed archive, its entry point, and execution outside the source directory. It is not a substitute for clean dependency installation or live-provider acceptance.

## GitHub authentication

```sh
gh auth status
gh auth login --hostname github.com
```

Authentication requires the maintainer's own login. Never place tokens in project files or command examples.

After choosing the repository, the initial publish can use:

```sh
gh repo create OWNER/REPOSITORY --public --source=. --remote=origin --push
```

Only run this command after the local commit and repository details have been reviewed. Creating a public repository exposes every tracked file and its committed history.
