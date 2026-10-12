# Loom Code

[English](README.md) | 中文

一个用 ESM JavaScript 编写、遵循 Standard Style 的终端编码智能体。TUI 和模型协议复用 Pi 的成熟基础设施，会话、预算、工具授权与多代理编排由本项目实现。

当前为早期 0.1 版本，通过 GitHub 源码安装，尚未发布到 npm。macOS 已完成本地验证；CI 配置覆盖 Linux/macOS，Windows 暂未验证。

## 启动

需要 Node.js 22.19 或以上，推荐 Node.js 24。

```sh
git clone https://github.com/crapthings/loom-code.git
cd loom-code
pnpm install --frozen-lockfile --ignore-scripts
pnpm run demo
```

离线演示会真正读取当前工作区，展示工具往返、流式输出与持久化会话，不需要密钥、不调用付费模型。

## 安装为全局命令

在本地源码目录完成依赖安装后，通过 pnpm 注册命令：

```sh
cd /path/to/loom-code
pnpm add --global "$PWD" --ignore-scripts
```

如果 pnpm 提示全局命令目录不在 PATH，运行 `pnpm setup` 并重新打开终端；已有旧版 pnpm shell 配置时，检查该配置后可用 `pnpm setup --force` 更新 pnpm 配置段。pnpm 12 的全局命令位于 `$PNPM_HOME/bin`。

```sh
cd /path/to/project
loom --demo

# 设置 Vercel AI Gateway 凭据后，直接启动真实智能体
export AI_GATEWAY_API_KEY='YOUR_GATEWAY_KEY'
loom
```

`loom` 默认以当前目录作为工作区，无需在每个目标项目安装依赖。上述全局安装链接到本地源码，修改源码后下次启动即可生效；新增依赖后在源码目录运行 `pnpm install --ignore-scripts`。保留源码目录及其依赖，移动目录后重新注册命令。卸载使用 `pnpm remove --global loom-code`。

默认使用 Vercel AI Gateway，模型为 `deepseek/deepseek-v4.1-flash`，认证读取 `AI_GATEWAY_API_KEY`。内置适配器使用 Anthropic Messages 兼容协议并保留模型的上下文、推理和价格信息；无需传 `--base-url`。模型 ID 参考 [Vercel 模型文档](https://vercel.com/ai-gateway/models/deepseek-v4.1-flash)。可在 shell 配置中设置密钥，后续进入任意项目执行 `loom` 即可。上下文、输出限制和费用估算来自锁定版本的 Pi 模型目录，可能与网关最新信息不同，实际计费以网关账单为准。

```sh
export AI_GATEWAY_API_KEY='YOUR_GATEWAY_KEY'
loom

# 切换同一网关上的模型
loom --model openai/gpt-5.4

# 查看 Vercel 模型目录
loom --models --provider vercel
```

`--provider` 或 `LOOM_PROVIDER` 可覆盖默认网关（`vercel` 是 `vercel-ai-gateway` 的别名），`--model` 或 `LOOM_MODEL` 可覆盖默认模型。仅设置 `OPENAI_API_KEY` 不会自动切换供应商。缺少 Vercel 密钥时会在启动 TUI 前提示，不会自动调用其他供应商。

其他供应商与自定义端点：先在自己的终端设置对应密钥，再显式启动对应模型。

```sh
# 从环境变量 ANTHROPIC_API_KEY 读取认证
node bin/loom.js --provider anthropic --model claude-sonnet-4-6 --cwd /path/to/project

# 从环境变量 OPENAI_API_KEY 读取认证
node bin/loom.js --provider openai --model gpt-5.4 --cwd /path/to/project

# 查看锁定版本 Pi 提供的模型目录
node bin/loom.js --models
node bin/loom.js --models --provider google

# Ollama / LM Studio 等支持工具调用的 OpenAI-compatible 服务
node bin/loom.js --base-url http://localhost:11434/v1 --model YOUR_MODEL --context-window 32768
```

自定义端点只读取 `LOOM_API_KEY`，不会把其他供应商的密钥自动发送给它；无密钥的本地端点也可使用。必须选择支持工具调用的模型。自定义端点没有价格信息，界面显示的费用不代表实际账单。

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
| `/exit` | 取消活动执行、等待工具收尾、关闭日志并恢复终端 |

审批弹窗默认选中 **Deny**；上下键选择，Enter 确认，Esc 拒绝。批准仅适用于本次调用，不会隐式批准未来命令。

## 执行模式

| 模式 | 文件读取 | 文件修改 | Shell |
| --- | --- | --- | --- |
| `--mode ask`，默认 | 允许 | 逐次审批 | 逐次审批 |
| `--mode edit` | 允许 | 自动允许工作区文件工具编辑 | 仍逐次审批 |
| `--mode auto` | 允许 | 自动允许工作区文件工具编辑 | 自动执行主机命令 |
| `--mode plan` | 允许 | 工具不可见且执行层拒绝 | 工具不可见且执行层拒绝 |

通常直接运行 `loom`，在 TUI 中输入 `/mode` 选择权限，无需退出或重填启动参数。运行中的任务须先用 `/stop` 停止并等待收尾，再切换模式；切换会同步更新模型提示词、可用工具和执行层，并记入会话日志。当前权限仅对本次进程有效，重新启动默认回到 ask；子代理始终保持只读。`/mode auto` 表示授权智能体自动执行文件操作和主机命令。

Shell 是**主机执行**，目前没有 OS 沙箱；ask/edit 需要审批，auto 不弹审批。文件工具的路径校验不能限制任意 Shell 命令，也不防御恶意本地进程同时改动路径。生产中的不可信任务应在隔离环境运行；执行器接口是下一步接入容器或系统沙箱的位置。

Shell 最长运行 120 秒，输出超过 10 MiB 时停止；完整输出保存为 artifact，模型得到有限预览。Unix 中断会终止进程组；Windows 的进程树隔离与取消尚未验证。Shell 子进程默认剔除名称包含 API_KEY、TOKEN、SECRET、PASSWORD 的环境变量，避免继承模型认证；依赖这些变量的命令需要另外设计明确的凭据授权。

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
node bin/loom.js --demo --print '查看工作区'
node bin/loom.js --mode plan --print '分析项目结构' --json
```

无界面模式没有交互审批，ask 模式的修改及 ask/edit 模式的 Shell 被拒绝；`--mode edit` 允许文件工具修改，`--mode auto` 允许文件修改和主机命令。失败、中断或恢复阻塞返回非零退出码。

`src/index.js` 导出 Agent、Session、Dispatcher 和模型工厂。产品端只消费事件并提供 `approve(request)`，无需复制执行循环；API 调用方必须先 `initialize()`，用 `enqueue()` / `wait()` 执行，最后 `close()`。

## 验证与设计

```sh
pnpm run check
pnpm run check:package
```

检查包含 Standard Style、顶层声明的一行解释，以及无网络付费调用的行为测试。真实供应商 HTTP 行为没有用付费密钥验收；供应商适配通过 Pi 的 faux provider 验证，OpenAI-compatible HTTP 接口通过本地测试服务验证。

源码借鉴与实现边界见 [architecture.md](docs/architecture.md)。当前重点是可靠的本地编码闭环；MCP 客户端、OAuth 持久认证、可执行插件、分布式协调和 OS 沙箱尚未实现。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界见 [SECURITY.md](SECURITY.md)，发布步骤见 [releasing.md](docs/releasing.md)。本项目使用 [MIT 许可证](LICENSE)；依赖保留各自许可证，参考 [NOTICE](NOTICE)。
