# Loom Code

[![CI](https://github.com/crapthings/loom-code/actions/workflows/ci.yml/badge.svg)](https://github.com/crapthings/loom-code/actions/workflows/ci.yml)

[English](README.md) | 中文

一个用 ESM JavaScript 编写、遵循 Standard Style 的终端编码智能体。TUI 和模型协议复用 Pi 的成熟基础设施，会话、预算、工具授权与多代理编排由本项目实现。

当前为早期 0.1 版本，通过 GitHub 源码安装，尚未发布到 npm。macOS 已完成本地终端验证；Linux/macOS、Node.js 22.19.0/24 四组 CI 均已通过，Windows 暂未验证。

## 启动

需要 Node.js 22.19 或以上，推荐 Node.js 24。

```sh
git clone https://github.com/crapthings/loom-code.git
cd loom-code
pnpm install --frozen-lockfile --ignore-scripts
export AI_GATEWAY_API_KEY='YOUR_VERCEL_GATEWAY_KEY'
pnpm start
```

启动后使用 Vercel AI Gateway；开发验证可运行 `pnpm run check` 和 `pnpm run check:package`，不需要 API 密钥。

## 安装为全局命令

在本地源码目录完成依赖安装后，通过 pnpm 注册命令：

```sh
cd /path/to/loom-code
pnpm add --global "$PWD" --ignore-scripts
```

如果 pnpm 提示全局命令目录不在 PATH，运行 `pnpm setup` 并重新打开终端；已有旧版 pnpm shell 配置时，检查该配置后可用 `pnpm setup --force` 更新 pnpm 配置段。pnpm 12 的全局命令位于 `$PNPM_HOME/bin`。

```sh
cd /path/to/project
# 设置 Vercel AI Gateway 凭据后启动
export AI_GATEWAY_API_KEY='YOUR_GATEWAY_KEY'
loom
```

`loom` 默认以当前目录作为工作区，无需在每个目标项目安装依赖。上述全局安装链接到本地源码，修改源码后下次启动即可生效；新增依赖后在源码目录运行 `pnpm install --ignore-scripts`。保留源码目录及其依赖，移动目录后重新注册命令。卸载使用 `pnpm remove --global loom-code`。

默认使用 Vercel AI Gateway，模型为 `deepseek/deepseek-v4.1-flash`，认证读取 `AI_GATEWAY_API_KEY`。内置适配器使用 Anthropic Messages 兼容协议并保留模型的上下文、推理和价格信息；请求使用固定的 Vercel 网关地址。模型 ID 参考 [Vercel 模型文档](https://vercel.com/ai-gateway/models/deepseek-v4.1-flash)。可在 shell 配置中设置密钥，后续进入任意项目执行 `loom` 即可。上下文、输出限制和费用估算来自锁定版本的 Pi 模型目录，可能与网关最新信息不同，实际计费以网关账单为准。

```sh
export AI_GATEWAY_API_KEY='YOUR_GATEWAY_KEY'
loom

# 切换同一网关上的模型
loom --model openai/gpt-5.4

# 查看 Vercel 模型目录
loom --models
```

当前只支持 Vercel AI Gateway；`--model` 或 `LOOM_MODEL` 选择网关中的模型，认证只读取 `AI_GATEWAY_API_KEY`。不再提供直连供应商和自定义端点参数。必须选择支持工具调用的模型。缺少 Vercel 密钥时会在启动 TUI 前提示。


历史会话入口：

```sh
loom resume                  # 当前项目的 TUI 会话选择器
loom resume --last           # 打开最近的未占用会话
loom resume SESSION_ID       # 打开指定的已有主会话
loom resume --list           # 只读列表，无需 API 密钥
loom resume --list --json    # 输出 JSON
```

列表展示首个任务、更新时间、状态与待处理条数，排除其他项目和子代理会话。占用中的会话会在文本/JSON 列表中标记，但不能选择。Esc / Ctrl+C 取消选择，不创建新会话。非交互终端中 `loom resume` 输出列表；自动执行需指定 ID 或 `--last`，再传 `--resume` 或 `--print`。

列出时不修复日志、不删除旧锁；真正打开时才获取独占锁和恢复日志。损坏、不可读或超过 16 MiB 的日志跳过并报告数量。当前逐个扫描日志，大规模历史后续需增量索引。打开使用当前模型配置，默认 `ask`，不会恢复本次会话授权。

恢复说明：`loom --session SESSION_ID` 加载旧会话但不自动执行。`/continue` 只恢复中断、失败、待确认的未知结果或持久化待处理输入；新会话和已完成任务仅显示提示，不调用模型。未完成任务优先于排队任务，恢复请求保留已有工具结果并要求避免重复成功操作，但不能保证模型不会再次请求相同操作。

## 操作

界面由固定标题、可滚动的对话、保持可编辑的多行输入区和状态栏组成；支持中文、Markdown、鼠标滚动及终端尺寸变化。

| 操作 | 行为 |
| --- | --- |
| Enter | 提交输入；执行中输入在下一安全边界修正当前任务 |
| Shift+Enter | 插入新行；具体按键支持取决于终端协议 |
| Esc | 中断执行，保留历史和待处理任务 |
| Ctrl+C | 执行中中断，空闲时安全退出 |
| `/queue TASK` | 当前任务结束后执行下一项任务 |
| `/stop` | 中断当前任务 |
| `/continue` | 明确恢复未完成任务或确认已检查未知执行结果 |
| `/compact` | 压缩先前完整交互；原始日志保留 |
| `/undo` | 撤销最新文件工具编辑；文件被外部修改后拒绝覆盖 |
| `/status` | 显示完整会话 ID、日志路径与待处理输入数 |
| `/mode` 或 `/permissions` | 打开权限选择菜单；上下键选择、Enter 确认、Esc 取消 |
| `/mode ask\|edit\|auto\|plan` | 直接切换权限模式，标题栏同步显示 |
| `/language` 或 `/lang` | 打开界面语言选择菜单 |
| `/language en` / `/language zh-CN` | 即时切换为英文 / 简体中文 |
| `/exit` | 取消活动执行、等待工具收尾、关闭日志并恢复终端 |

审批弹窗默认选中 **Deny**；上下键选择，Enter 确认，Esc 拒绝。**Allow once** 只批准本次调用；**Allow for this session** 批准当前工具在本次运行内的后续调用，例如 shell 的所有后续命令，仍受沙箱约束。不同工具需分别批准；切换 `/mode`（包括重新选择当前模式）或退出会清除授权，恢复旧会话也不会恢复授权。

界面默认英文；中文审批选项对应「拒绝」「允许一次」「本次会话允许」。语言选择原子保存到 `~/.config/loom/settings.json`，供以后在不同项目启动时使用。切换后标题、底部状态、命令补全和新弹窗立即使用所选语言；命令名称保持稳定。模型回复、代码、已有消息、原始工具输出和诊断错误保留原文，权限与会话授权不变。翻译文案集中在 `src/ui/locales/`，使用命名占位符，缺失翻译回退英文。

## 执行模式

| 模式 | 文件读取 | 文件修改 | Shell |
| --- | --- | --- | --- |
| `--mode ask`，默认 | 允许 | 逐次审批 | 逐次审批 |
| `--mode edit` | 允许 | 自动允许工作区文件工具编辑 | 仍逐次审批 |
| `--mode auto` | 允许 | 自动允许工作区文件工具编辑 | 自动执行主机命令 |
| `--mode plan` | 允许 | 工具不可见且执行层拒绝 | 工具不可见且执行层拒绝 |

通常直接运行 `loom`，在 TUI 中输入 `/mode` 选择权限，无需退出或重填启动参数。运行中的任务须先用 `/stop` 停止并等待收尾，再切换模式；切换会同步更新模型提示词、可用工具和执行层，并记入会话日志。当前权限仅对本次进程有效，重新启动默认回到 ask；子代理始终保持只读。`/mode auto` 表示授权智能体自动执行文件操作和主机命令。

Shell 默认必须进入 OS 沙箱：macOS 使用 Seatbelt，Linux 使用 bubblewrap。ask/edit 需要审批，auto 不弹审批但保留沙箱边界；默认拒绝 shell 网络访问，限制写入工作区与私有临时目录，并保护凭据和元数据。沙箱无法建立时拒绝执行，不自动退回裸机。调研、策略与限制见 [sandbox.md](docs/sandbox.md)。

`loom --sandbox-status` 或 TUI 的 `/sandbox` 查看依赖状态。Linux 需要 bubblewrap、socat、ripgrep，以及宿主允许创建非特权 namespace。建议先由用户安装项目依赖，再让智能体离线改代码与跑测试；模型 API 请求不受 shell 网络限制。启动时显式传 `--sandbox off` 才使用裸机执行，`/mode` 和模型无法关闭沙箱。

Shell 最长运行 120 秒，输出超过 10 MiB 时停止；完整输出保存为 artifact，模型得到有限预览。Unix 中断会终止进程组；Windows 沙箱尚未接入。Shell 环境从小型白名单构造，不继承模型认证、SSH agent 或可执行启动钩子，HOME、临时目录及缓存均隔离；用户 HOME 下的部分工具链可能不可访问。

## 会话与恢复

```text
WORKSPACE/.loom/sessions/SESSION_ID/
  events.jsonl          持久事件、消息、调用与终态
  lock                  单进程写入锁
  UUID.txt              完整工具输出
  checkpoints/UUID.json 文件修改前内容与修改后 hash
```

将 `.loom/` 加入目标项目的 `.gitignore`；会话可能包含工作代码、用户输入和工具结果，不应默认提交。

```sh
node bin/loom.js --session SESSION_ID --cwd /path/to/project
```

打开已有会话会加载历史，但不会擅自继续任务。用 `/continue` 或 `--resume` 明确恢复。进程崩溃后，已开始但没有终态的工具被标记为 **unknown**，不会自动重放；用户检查工作区及外部系统后才能确认继续。这不是 exactly-once 副作用保证。

预算按本次运行统计：默认共享 30 次模型请求额度和 15 分钟运行时间，父代理、子代理、摘要和显式网络重试共用额度。失败或中断后，用户主动恢复会开启新运行预算。状态栏显示已记录的 usage；传输失败可能没有完整计费信息。

## 子代理与 skills

模型可以调用 `delegate`，选择 `explore` 或 `review`。子代理使用独立持久会话，拥有同一个工作区的只读工具，不能写入、调用 Shell 或再次委托；父子共享预算与取消链。独立的读取批次可并行，包含变更的批次串行。

项目根 `AGENTS.md` 会加载为工作指引。项目 skills 放在 `.agents/skills/NAME/SKILL.md`：

```markdown
---
name: review
description: Review JavaScript code quality
---
检查错误处理、资源释放和 Standard 风格，用文件路径提供证据。
```

启动时只把名称与单行 description 放进提示，完整指令通过 `load_skill` 按需读取。当前只支持简单的单行 frontmatter，不执行 skill 安装器或任意 hook。

## 无界面与 SDK

```sh
node bin/loom.js --mode plan --print '分析项目结构' --json
```

无界面模式没有交互审批，ask 模式的修改及 ask/edit 模式的 Shell 被拒绝；`--mode edit` 允许文件工具修改，`--mode auto` 允许文件修改和主机命令。失败、中断或恢复阻塞返回非零退出码。

`src/index.js` 导出 Agent、Session、Dispatcher 和 Vercel 模型工厂。产品端只消费事件并提供 `approve(request)`，无需复制执行循环；API 调用方必须先 `initialize()`，用 `enqueue()` / `wait()` 执行，最后 `close()`。

## 验证与设计

离线模型仅保留在 `test/fixtures/` 供测试使用，不包含在发布包中；生产 CLI 不提供 `--demo`。

```sh
pnpm run check
pnpm run check:package
```

检查包含 Standard Style、顶层声明的一行解释，以及无网络付费调用的行为测试。真实供应商 HTTP 行为没有用付费密钥验收；供应商适配通过 Pi 的 faux provider 验证，流式传输与工具调用协议通过注入本地 HTTP 测试服务验证，不代表真实 Vercel 网关验收。

源码借鉴与实现边界见 [architecture.md](docs/architecture.md)。当前重点是可靠的本地编码闭环；MCP 客户端、OAuth 持久认证、可执行插件、分布式协调、容器执行器和沙箱网络放行尚未实现。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界见 [SECURITY.md](SECURITY.md)，发布步骤见 [releasing.md](docs/releasing.md)。本项目使用 [MIT 许可证](LICENSE)；依赖保留各自许可证，参考 [NOTICE](NOTICE)。
