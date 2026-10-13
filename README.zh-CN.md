# Loom Code

[![CI](https://github.com/crapthings/loom-code/actions/workflows/ci.yml/badge.svg)](https://github.com/crapthings/loom-code/actions/workflows/ci.yml)

[English](README.md) | 中文

在项目目录启动 `loom`，描述任务，让智能体检查文件、修改代码、执行命令并报告结果。

Loom 自行实现执行循环、工具分发、权限、持久会话、取消和只读委托；Pi 提供模型协议和终端组件，Zustand 管理临时界面状态，OS 沙箱隔离 shell。代码使用 ESM JavaScript、Standard Style 和 pnpm。

**当前处于早期开发阶段，版本 0.1.0。** 从源码安装，尚未发布到 npm。CI 配置覆盖 Linux/macOS、Node.js 22.19.0/24；本地终端验证在 macOS 上进行，尚未建立生产就绪或真实编码质量结论。

## 快速开始

需要 **Node.js >=22.19.0** 和 **pnpm 12.4.1**。

```sh
git clone https://github.com/crapthings/loom-code.git
cd loom-code
pnpm install --frozen-lockfile --ignore-scripts
pnpm add --global "$PWD" --ignore-scripts
export AI_GATEWAY_API_KEY='YOUR_VERCEL_GATEWAY_KEY'
cd /path/to/project
loom
```

先尝试“找到项目入口，解释执行流程并指出相关测试”，再要求一个范围明确的修改和验证。默认 `ask` 模式允许读写及 shell，写入和命令执行需要审批。`/mode edit` 自动允许写入，`/mode auto` 同时自动允许命令；沙箱始终按启动配置生效。

将 `.loom/` 加入目标项目的 `.gitignore`，日志和检查点可能包含提示词、源码和工具输出。

全局命令链接到当前源码目录，保留该目录和依赖即可；源码更新在下次启动生效，目标项目无需安装 Loom 依赖。找不到命令时运行 `pnpm setup` 并重新打开终端。卸载使用 `pnpm remove --global loom-code`。

## 功能

- 读取、列举和字面文本搜索，加载项目指导及 skills。
- 通过内容版本检查修改文件，保存可恢复的编辑检查点。
- 在 OS 沙箱中运行命令，限制输出并保存完整 artifact。
- 委托只读调研或审查，共享预算和取消链。
- 执行中修正任务、排队后续任务、随时中断。
- 打开历史会话，显式继续未完成工作。
- 检索带来源的历史及显式保存的项目记忆。
- 可选使用独立决策模型观察任务完成情况。

根目录 `AGENTS.md` 提供项目指导；`.agents/skills/NAME/SKILL.md` 的名称和单行 description 在启动时发现，完整指令按需加载。子代理不能写入、执行 shell、修改权限或再次委托。

## 权限与沙箱

用 `/mode` 或 `/permissions` 打开选择器，也可直接切换：

| 模式 | 读取 | 写入 | Shell |
| --- | --- | --- | --- |
| `/mode ask`，默认 | 自动 | 需要审批 | 需要审批 |
| `/mode edit` | 自动 | 自动 | 需要审批 |
| `/mode auto` | 自动 | 自动 | 自动 |
| `/mode plan` | 自动 | 拒绝 | 拒绝 |

切换前停止或完成活动任务。重新打开会话默认使用 ask，除非传入 `--mode`。

审批默认选中拒绝；上下键选择、Enter 确认、Esc 取消。“允许一次”只批准当前调用；“本次会话允许”批准该工具后续调用，shell 授权仍受沙箱约束。各工具分别授权；切换模式（包括当前模式）或退出都会清除授权，旧会话不会恢复授权。

Shell 默认要求 macOS Seatbelt 或 Linux bubblewrap，拒绝网络并限制文件访问。依赖缺失或隔离初始化失败时拒绝执行，不自动回退到裸机。模型 API 请求和文件工具在 shell 沙箱外运行。

```sh
loom --sandbox-status
# Linux 所需组件：
sudo apt-get install bubblewrap socat ripgrep
```

TUI 中可用 `/sandbox` 查看状态。Linux 宿主还须允许非特权 namespace；Windows 没有支持的沙箱后端。先在自己的终端安装项目依赖，再让 Loom 运行离线构建或测试。只有启动时显式 `--sandbox off` 才选择主机执行。

沙箱不等于 VM，也不提供完整的竞态或资源耗尽防护。配置、诊断和限制见 [sandbox.md](docs/sandbox.md)，安全及隐私边界见 [SECURITY.md](SECURITY.md)。

## 终端操作

| 操作 | 行为 |
| --- | --- |
| Enter | 提交任务，或在下一安全边界修正活动任务 |
| Shift+Enter | 插入新行，取决于终端支持 |
| Esc / `/stop` | 中断任务；Esc 也可关闭弹窗 |
| Ctrl+C | 中断活动任务，空闲时退出 |
| `/queue TASK` | 当前任务结束后执行后续任务 |
| `/continue` | 显式继续未完成任务或已检查的未知结果 |
| `/compact` | 压缩先前完整交互，保留原始日志 |
| `/undo` | 恢复最新检查点；拒绝覆盖外部后续修改 |
| `/memory [all|ID]` | 查看有效记忆、所有状态或指定记录 |
| `/status` | 查看会话、预算和上下文输入/输出/安全预留估算 |
| `/mode` / `/permissions` | 选择权限模式 |
| `/sandbox` | 查看执行隔离状态 |
| `/language` / `/lang` | 选择界面语言 |
| `/help` | 查看命令 |
| `/exit` | 取消、等待收尾并安全退出 |

默认英文；`/language en` 或 `/language zh-CN` 即时切换，偏好保存在 `~/.config/loom/settings.json`，跨项目生效。命令名称保持稳定，模型回复、代码、已有消息和原始工具输出保留原语言。

## 模型与配置

**唯一模型入口是 Vercel AI Gateway**，默认聊天模型 `deepseek/deepseek-v4.1-flash`。

```sh
loom --model openai/gpt-6.1-sol
loom --model openai/gpt-6.1-sol --reasoning high
loom --models
```

| 配置 | 用途 | 默认值 |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | 网关认证 | 模型请求必需 |
| `--model` / `LOOM_MODEL` | 聊天模型 | `deepseek/deepseek-v4.1-flash` |
| `--reasoning` | 模型支持的推理级别 | `off` |
| `--cwd` | 工作区目录 | 当前目录 |
| `--mode` | 初始权限 | `ask` |
| `--sandbox` | required 或显式 off | `required` |
| `--steps` | 共享聊天请求额度，1–500 | `30` |
| `--verify` | off 或旁路 shadow 评估 | `off` |
| `--decision-model` / `LOOM_DECISION_MODEL` | 独立完成评估模型 | `openai/gpt-6-luna-decisions` |

CLI 参数优先于对应环境变量。推理级别为 off/minimal/low/medium/high/xhigh；默认运行期限 15 分钟，子代理、压缩和显式重试共享聊天额度。

`--models` 和 `--decision-models` 读取锁定依赖中的目录，不调用 API；元数据与费用估算可能不同于网关实际情况。不支持直连供应商、自定义端点或 `LOOM_PROVIDER`。[.env.example](.env.example) 列出环境变量，Loom 不自动加载 `.env`。

## 可选完成评估

```sh
loom --verify shadow
loom --verify shadow --decision-model typesafe-ai/jev
loom --decision-models
```

默认关闭；开启后使用独立 classifier 观察要求覆盖、无证据的完成声明及缺失验证，复用网关密钥。决策模型不能通过 `--model` 选择。

主任务先持久化完成，再评估；判断展示并保存，不改变权限、工具执行、聊天上下文或触发重试，子代理不评估。每轮最多三次调用，每次五秒期限，不自动重试；故障不改变已完成任务。评估可能增加延迟和费用，JSON 输出包含 `verification.finished`。判断不等于正确性保证；证据和恢复细节见 [架构文档](docs/architecture.md)。

## 会话与恢复

会话位于 `WORKSPACE/.loom/sessions/SESSION_ID/`，包含 `events.jsonl`、写入锁、输出 artifacts 和文件检查点。

```sh
loom resume                   # 选择当前项目会话
loom resume --last            # 打开最近的可用会话
loom resume SESSION_ID        # 打开指定会话
loom resume --list            # 只读列表，无需 API 密钥
loom resume --list --json     # JSON 列表
```

**打开历史不会重新执行任务。** `/continue` 恢复未完成工作或待处理输入；已完成且无待处理输入时不调用模型。打开使用当前模型配置和新授权。列表只允许打开本工作区的主会话，忙碌会话不可选择；非交互终端中 `loom resume` 输出列表。

上下文每步从日志投影，压缩保留近期完整交互及带来源的当前任务要求和结果引用，并标记遗漏。`search_history` 默认搜索当前会话，主代理可显式搜索同工作区其他主会话；子代理只能查询自身。`read_history` 按序号读取原始事件。旧证据须结合当前代码核验。

历史检索按需创建可重建的 `.loom/history.sqlite` Worker 缓存，关闭 Loom 后可以删除重建；原始读取与恢复不依赖索引健康。部分 Node 版本可能显示 SQLite 实验性警告。会话列表仍扫描日志，跳过不可读、损坏或过大的记录并报告数量。

崩溃后已开始但没有结果的工具会标记 unknown，检查工作区后才能明确继续，不自动重放副作用。这不是 exactly-once 保证，模型仍可能请求另一次操作。未完成工作优先于排队任务；评估崩溃不重开已完成任务。

## 项目记忆

说“记住本项目使用 pnpm”，模型可通过 `remember` 保存带来源的记录，沿用当前写入权限。当前没有后台自动提取，也不会每轮注入所有记忆。相关任务使用 `list_memories` / `get_memory` 召回；来源序号通过历史工具查找。

`/memory` 查看有效记录，`/memory all` 包含失效及归档记录，`/memory ID` 核验来源。支持项目/相对路径范围、过期时间、不可变修订和版本检查。`forget_memory` 追加失效或归档修订，**不是物理删除**。来源变化只能证明证据变动，不能证明当前代码仍符合记忆；列表不核验来源，应读取具体记录再使用。

`.loom/memory.sqlite` 是独立权威存储，**不能当历史缓存删除重建**。备份前关闭 Loom；不要保存密钥。当前不支持全局或跨 worktree 共享。取消或崩溃可能发生在提交后、日志终态前，应先检查再重试；同会话/调用 ID 回执不能保证所有新调用都去重。

## 无界面与开发

```sh
loom --mode plan --print '解释项目结构' --json
loom --mode auto --print '修复失败测试并验证' --json
loom resume SESSION_ID --resume --json
```

无界面模式拒绝需要交互审批的调用；edit 自动允许写入，auto 同时允许 shell。失败、中断或恢复阻塞返回非零退出码；完整参数见 `loom --help`。

`src/index.js` 导出 Agent、Session、Dispatcher、工具注册、聊天/决策模型工厂及目录、ShellExecutor、sandboxStatus、HistoryStore 和 MemoryStore。SDK 须先 initialize，再 enqueue/wait，最后 close；独立存储客户端也须关闭 Worker。源码边界见 [architecture.md](docs/architecture.md)。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run check:package
```

检查覆盖 Standard Style、顶层声明一句话说明、假模型及本地 HTTP 行为测试、打包 CLI/SDK。无需付费密钥，不代表真实网关或模型质量验收。MCP、OAuth 持久认证、可执行插件、分布式协调、容器执行器和沙箱网络放行尚未实现。

贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，变更见 [CHANGELOG.md](CHANGELOG.md)，发布见 [releasing.md](docs/releasing.md)。本项目使用 [MIT](LICENSE)，依赖保留各自许可证，参考 [NOTICE](NOTICE)。设计参考 Pi、Codex、OpenCode 和 Claude Code 公开行为，未使用其私有运行时。
