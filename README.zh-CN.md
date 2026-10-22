# Loom Code

[![CI](https://github.com/crapthings/loom-code/actions/workflows/ci.yml/badge.svg)](https://github.com/crapthings/loom-code/actions/workflows/ci.yml)

[English](README.md) | 中文

Loom 是一个在终端里使用的 AI 编程助手。进入项目，告诉它你想做什么，它就能帮你读代码、改代码、运行测试。

目前处于早期开发阶段，支持 macOS 和 Linux，按下面的步骤从源码安装即可。

## 快速安装

需要 **Node.js 22.19.0 或更新版本**，以及 **pnpm 12.14.0**。首次使用 pnpm 全局安装时，先运行 `pnpm setup`，再重新打开终端。

```sh
git clone https://github.com/crapthings/loom-code.git
cd loom-code
pnpm install --frozen-lockfile --ignore-scripts
pnpm add --global "$PWD" --ignore-scripts
```

安装后请保留这个文件夹，`loom` 命令会使用这里的源码。

Debian / Ubuntu 用户还需要安装：

```sh
sudo apt-get install bubblewrap socat ripgrep
```

## 开始使用

在 [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/authentication-and-byok) 创建 API 密钥，替换下面的占位内容，再进入你的项目：

```sh
export AI_GATEWAY_API_KEY='YOUR_VERCEL_GATEWAY_KEY'
cd /path/to/your/project
loom
```

进入后输入 `/language zh-CN` 切换中文，然后直接描述任务，例如：

```text
给登录表单增加邮箱校验，并运行相关测试。
```

修改文件和运行命令前，Loom 默认会询问你。按 **Esc** 可以中断任务，输入 `/help` 查看可用命令。下次用 `loom resume` 打开历史会话。

把 `.loom/` 加入项目的 `.gitignore`，避免将聊天记录提交到 Git。

[MIT 许可证](LICENSE)
