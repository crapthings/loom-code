# Loom Code

[![CI](https://github.com/crapthings/loom-code/actions/workflows/ci.yml/badge.svg)](https://github.com/crapthings/loom-code/actions/workflows/ci.yml)

[English](README.md) | 中文

在项目目录启动 `loom`，描述任务，让智能体检查文件、修改代码、执行命令并报告结果。

Loom 自行实现执行循环、工具分发、权限、持久会话、取消和只读委托；Pi 提供模型协议和终端组件，Zustand 管理临时界面状态，OS 沙箱隔离 shell。代码使用 ESM JavaScript、Standard Style 和 pnpm。

**当前处于早期开发阶段，版本 0.1.0。** 从源码安装，尚未发布到 npm。CI 配置覆盖 Linux/macOS、Node.js 22.19.0/24；本地终端验证在 macOS 上进行，尚未建立生产就绪或真实编码质量结论。

## 快速开始

需要 **Node.js >=22.19.0** 和 **pnpm 12.14.0**。

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
- 可选通过 Cua Driver 观察和操作主机桌面，将截图传给聊天模型。
- 委托只读调研或审查，共享预算和取消链。
- 执行中修正任务、排队后续任务、随时中断。
- 打开历史会话，显式继续未完成工作。
- 检索带来源的历史及显式保存的项目记忆。
- 可选使用独立决策模型观察任务完成情况。

根目录 `AGENTS.md` 提供项目指导；`.agents/skills/NAME/SKILL.md` 的名称和单行 description 在启动时发现，完整指令按需加载。子代理不能写入、执行 shell、修改权限或再次委托。

## 权限与沙箱

用 `/mode` 或 `/permissions` 打开选择器，也可直接切换：

| 模式 | 读取 | 写入 | Shell | 已启用的电脑操作 |
| --- | --- | --- | --- | --- |
| `/mode ask`，默认 | 自动 | 需要审批 | 需要审批 | 需要审批 |
| `/mode edit` | 自动 | 自动 | 需要审批 | 需要审批 |
| `/mode auto` | 自动 | 自动 | 自动 | 自动 |
| `/mode plan` | 自动 | 拒绝 | 拒绝 | 拒绝 |

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

## 通过 Cua 操作电脑

先单独安装 [Cua Driver](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md) 0.28+ 并配置系统权限。macOS 使用其支持的 CuaDriver.app 安装方式，授予辅助功能和屏幕录制权限。随后运行：

```sh
cua-driver permissions grant
cua-driver permissions status
cua-driver doctor
loom --computer cua
# 可执行文件不在 PATH 时：
loom --computer cua --cua-driver /absolute/path/to/cua-driver
```

电脑访问默认关闭，需要目录中支持图片输入的模型。Loom 通过固定 MCP 版本 `2026-07-28` 连接 `cua-driver mcp`，不兼容旧协议格式。Cua 提供观察及输入工具，主循环、审批和持久日志仍由 Loom 管理；子代理不获得电脑工具。

首次调用模型前，Loom 会通过日志记录的只读调用检查 Driver 权限。权限缺失、等待授权或状态未知时，启动直接显示恢复步骤，不静默启用，也不代为请求系统授权。任务中遇到明确权限阻塞，会结算失败调用、取消同批次剩余调用并停止本轮，将任务标为受阻。完成系统授权后，`/continue` 先复查权限，通过后才调用模型恢复原任务；复查失败不消耗模型调用。权限检查通过不代表截图或应用行为已经验证。

**电脑工具访问主机桌面，位于 shell 沙箱之外。** 开启后允许观察，截图会通过配置的模型供应商发送。电脑操作在 `ask`/`edit` 下需要审批，`auto` 下自动允许，`plan` 下拒绝；授权按工具分别保存，仅当前运行有效。无界面执行拒绝需要审批的调用。浏览器准备仅允许新建隔离配置 `isolated_new`，不接入已有登录配置。启动应用、服务及测试仍须遵守项目要求。

截图按内容哈希保存在会话目录的私有文件中，日志及 JSON 事件只保存引用，不写入图片 base64。每次结果最多四张 PNG/JPEG/WebP，每张不超过 8 MiB；最近四次图片引用进入聊天模型上下文，较早截图可通过 `read_image` 召回。压缩、历史及决策模型的证据只包含明确标注的文字引用，不含像素，因此不能仅凭截图文件存在判定视觉效果正确。TUI 显示执行进度及结果引用，不内嵌显示截图。

取消、超时或断连会结算调用并关闭连接，不自动重试。输入操作可能已生效：重新启动带电脑访问的 Loom 后，先观察当前状态，再决定是否再次操作。`/status` 显示连接状态。测试使用假 MCP 驱动和本地模型服务；真实桌面权限及视觉行为需要另行实测。

## 终端操作

Shell 命令实时保存输出，超过 1 秒仍未结束时会返回任务 ID，继续在原沙箱中运行。完成结果会自动交给智能体；智能体可先做独立工作，没有其他工作时等待完成事件，不反复调用模型轮询。只要仍有 Shell 任务运行，本次任务就不会被标记为完成。

运行区显示命令、任务 ID、耗时和多久没有输出。`/jobs` 查看任务与最近输出，`/stop ID` 单独停止一个任务；Esc 或不带 ID 的 `/stop` 中断整个执行，并结算所有子进程。

Shell 默认不设执行时限；可选的 `timeout` 指定秒数，`yield_time_ms` 只控制调用多久后返回（0–10000 毫秒）。每个会话最多同时运行 4 个 Shell 任务，每个任务最多保存 10 MiB 输出。模型通过 `process_status`、`process_wait`、`process_stop` 操作任务，不需要拼接 `&` 或 `sleep` 等待。临时文件使用 `$TMPDIR`。重启后未完成任务记为结果未知，不自动重跑。

隔离环境中的 pnpm 会在可用版本与 `packageManager` 不符时快速报错，避免在禁止联网的沙箱中静默下载版本。运行检查前需准备好匹配的工具链；版本错误属于环境阻塞，不能据此判断构建慢。

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
| `--computer` | 主机桌面工具：off 或 cua | `off` |
| `--cua-driver` | 驱动路径，要求同时传入 `--computer cua` | PATH 中的 `cua-driver` |
| `--steps` | 共享聊天请求额度，1–500 | 不限 |
| `--verify` | 完成评估：auto、off 或旁路 shadow | `auto` |
| `--supervise` | 运行中独立评估进展：auto 或 off | `auto` |
| `--decision-model` / `LOOM_DECISION_MODEL` | 进展及完成评估使用的模型 | `openai/gpt-6-luna-decisions` |

CLI 参数优先于对应环境变量。推理级别为 off/minimal/low/medium/high/xhigh；默认不限制模型调用次数和运行时长。可用 `--steps N` 设置聊天请求额度，子代理、压缩和显式重试共享该额度；运行中仍可按 Esc 中断。

`--models` 和 `--decision-models` 读取锁定依赖中的目录，不调用 API；元数据与费用估算可能不同于网关实际情况。不支持直连供应商、自定义端点或 `LOOM_PROVIDER`。[.env.example](.env.example) 列出环境变量，Loom 不自动加载 `.env`。

## 运行中监督与完成评估

默认启用运行中的独立决策评估，结合原始需求、近期工具参数及结果判断是否有实际进展。持续调查或重复读取、连续失败、只查历史时会介入；进度说明、导入检查和退出码为 0 不单独算作有效进展。明确的停滞判断会持续指导下一步：有依据的小范围修改、实际验证、更换方法、查清一个缺失事实，或说明具体阻碍。只读任务和 plan 模式不会收到实施修改的指令。

首次在十二轮工具调用后或明显重复模式出现时检查，后续至少间隔八轮。单次问题和证据最多 32 KiB，五秒期限，不自动重试；评估失败后延长间隔，任务继续运行。评估会增加费用，但不消耗聊天步数、不设置任务总次数上限。`/status` 可查看评估模型和决策用量。`loom --supervise off` 关闭这些调用，保留本地提醒。语义判断可能出错，执行指导不能保证模型遵从或修复成功。

默认也开启结束前的验收评估，检查要求覆盖、无证据的声明及缺失验证。有明确未完成要求且存在可执行的授权操作时，自动继续；界面分别显示完成、尚未验证和受阻。项目命令限制及权限模式仍然有效，只读任务不要求修改文件。

为避免结束检查自身陷入循环，每次用户输入最多触发两次结束后的补救继续；重复结束却没有新增工具执行时，直接标为未验证。这不限制正常工具轮次。评估故障、判断不确定、缺少验证能力都不会标为已验证成功；未验证及受阻任务可明确恢复，打开历史不会自动执行。

单次完成评估最多 64 KiB、五秒期限、不重试，费用计入总量，与进展评估共用默认模型 `openai/gpt-6-luna-decisions` 及网关密钥。可单独配置：

```sh
loom --verify shadow
loom --verify off
loom --verify shadow --decision-model typesafe-ai/jev
loom --decision-models
```

`shadow` 仅在任务结束后记录判断，每次运行最多三次，不改变执行；`off` 关闭完成检查，与 `--supervise` 独立。SDK 使用 `decisionModel` 和 `verification: 'auto'` 接入结束检查。决策模型不能通过 `--model` 选择，判断也不等于正确性保证；假模型测试验证控制流程，真实效果仍需日志评估。

写入及 shell 调用前后会在有限范围内观察文件哈希，包含失败命令留下的部分变化。记录会标明遗漏与覆盖限制，也不会把并发修改都归因于 Loom。文件变化不证明修复正确；日志另行记录干预后的行动、首次观察到修改的耗时、文件数和已报告用量。

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

上下文每步从日志投影，压缩可在同一长任务内部的完整工具交换之间切分，保留近期交互及带来源的当前要求和结果引用，并标记遗漏。`search_history` 默认搜索当前会话，主代理可在同工作区发现其他主会话，再用 `sessionId` 缩小范围；子代理只能查询自身。检索调用的查询词和复制的检索结果不进入索引。`read_history` 按来源序号返回可见证据，排除私有推理、供应商元数据和复制的历史检索结果，原始日志保持不变。旧证据须结合当前代码核验。

历史检索按需创建可重建的 `.loom/history.sqlite` Worker 缓存，索引规则变化时自动重建派生数据，保留原始日志；手动删除缓存前应关闭 Loom。原始读取与恢复不依赖索引健康。部分 Node 版本可能显示 SQLite 实验性警告。会话列表仍扫描日志，跳过不可读、损坏或过大的记录并报告数量。

运行中的本地规则会显示调查进展提醒，默认启用的独立监督会在持续调查时补充证据判断。两者都不限制总步数，也不能证明任务成功；完成说明应对应原始要求的证据，并明确未验证的行为，例如尚未实际观察的视觉效果。

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

无界面模式拒绝需要交互审批的调用；edit 自动允许写入，auto 同时允许 shell 及已启用的电脑操作。失败、中断或恢复阻塞返回非零退出码；完整参数见 `loom --help`。

`src/index.js` 导出 Agent、Session、Dispatcher、工具注册、聊天/决策模型工厂及目录、ShellExecutor、CuaComputer、sandboxStatus、HistoryStore 和 MemoryStore。SDK 使用 `new Agent({ ..., computer: new CuaComputer() })` 显式接入电脑工具，须先 initialize，再 enqueue/wait，最后 close；独立存储客户端也须关闭 Worker。源码边界见 [architecture.md](docs/architecture.md)。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run check:package
```

检查覆盖 Standard Style、顶层声明一句话说明、假模型、本地 HTTP 及假 MCP 行为测试、打包 CLI/SDK。无需付费密钥，不代表真实网关、桌面或模型质量验收。通用 MCP 服务配置、OAuth 持久认证、可执行插件、分布式协调、容器执行器和沙箱网络放行尚未实现。

贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，变更见 [CHANGELOG.md](CHANGELOG.md)，发布见 [releasing.md](docs/releasing.md)。本项目使用 [MIT](LICENSE)，依赖保留各自许可证，参考 [NOTICE](NOTICE)。设计参考 Pi、Codex、OpenCode 和 Claude Code 公开行为，未使用其私有运行时。
