# Loom Code

[![CI](https://github.com/crapthings/loom-code/actions/workflows/ci.yml/badge.svg)](https://github.com/crapthings/loom-code/actions/workflows/ci.yml)

English | [中文](README.zh-CN.md)

Loom is an AI coding assistant for your terminal. Open a project, describe what you need, and let it help you understand code, make changes, and run tests.

Currently in early development. Supports macOS and Linux; install from source using the steps below.

## Quick install

You need **Node.js 22.19.0 or newer** and **pnpm 12.14.0**. If this is your first global pnpm installation, run `pnpm setup` and reopen your terminal first.

```sh
git clone https://github.com/crapthings/loom-code.git
cd loom-code
pnpm install --frozen-lockfile --ignore-scripts
pnpm add --global "$PWD" --ignore-scripts
```

Keep this folder: the `loom` command uses this copy of the source.

On Debian or Ubuntu, also install:

```sh
sudo apt-get install bubblewrap socat ripgrep
```

## Start using Loom

Create an API key in [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/authentication-and-byok), replace the placeholder below, and open your project:

```sh
export AI_GATEWAY_API_KEY='YOUR_VERCEL_GATEWAY_KEY'
cd /path/to/your/project
loom
```

Describe your task, for example:

```text
Add email validation to the login form and run the relevant tests.
```

By default, Loom asks before changing files or running commands. Press **Esc** to interrupt a task, or type `/help` to see available commands. Use `loom resume` to open a previous conversation.

Add `.loom/` to your project's `.gitignore` to keep conversation records out of Git.

[MIT License](LICENSE)
