# 架构与前辈实现的取舍

本文基于本地 2026-10-11 至 12 的源码快照：Pi `c661bc5`、Codex `a9b0815`、OpenCode `3e78cd5`；Claude Code 仓库 `3deb873` 不含完整核心，相关行为参考官方公开文档。

## 核心边界

```text
TerminalApp / headless JSON / SDK
       │  输入、审批、事件
       ▼
Agent: 单会话协调、step、预算、取消、委托
       ├── Context: 指令、skill 索引、模型视图、压缩
       ├── Model: Vercel AI Gateway 或离线模型
       └── Dispatcher: 校验 → 授权 → 记录意图 → 执行 → 记录结果
                       ├── 文件与版本检查点
                       ├── ShellExecutor → OS 沙箱与输出 artifact
                       └── 只读子代理
       │
       ▼
Session: 有序 JSONL、fsync、输入与结果投影、恢复
```

UI 不调用工具实现，工具不依赖终端，模型适配不负责运行循环。每次模型请求从持久记录重新投影；流式增量是临时展示，完整 assistant envelope 才进入执行历史。只有完整响应结束后执行工具，牺牲少量流式重叠以简化截断和恢复边界。

## 界面状态与执行状态

`src/ui/store.js` 使用固定版本 `zustand/vanilla`，每个 TerminalApp 创建独立实例，不依赖 React。通过 `dispatch(event)` 更新语言、权限模式显示、状态、预算数字快照、临时流式文本、待处理输入与弹窗元数据；`uiTransition` 是纯投影，不调用模型、工具或文件系统。`getState` 和 `subscribe` 用于读取与渲染，渲染方不修改返回的 Map 和对象。

TerminalApp 保留终端组件、弹窗句柄、Promise 与关闭流程。订阅按字段变化更新标题、补全和底栏；流式文本只更新对应 Markdown 组件。消息完成或输入投递后删除临时状态；关闭界面时释放订阅与组件引用。`closing` 期间仍接收执行收尾事件，`closed` 后忽略迟到事件与操作；异步语言保存完成后会再次检查关闭状态。相同语言、模式和不存在的弹窗关闭操作不触发订阅。可变 Budget 不直接进入 store，外部修改数字不会悄悄改变旧的显示快照。

Agent 继续拥有执行生命周期，Dispatcher 继续拥有授权，Session 的 JSONL 继续负责持久事实与崩溃恢复。UI 中的模式只是执行事件的投影，用户切换仍通过 `agent.setMode()`；语言保存成功后才提交 UI 变化。store 不持久化会话授权、进程、AbortController、未完成流式文本或执行状态。

当前选择 [Zustand vanilla](https://github.com/pmndrs/zustand#using-zustand-without-react)，因为所需的是简单可订阅的界面数据，且可用稳定接口封装依赖。[XState Store](https://stately.ai/docs/xstate-store) 的事件与纯转换也适合这一层；[XState actors](https://stately.ai/docs/actors) 适合以后明确表达执行状态转换和子任务生命周期，届时仍需保留日志提交、取消结算和未知副作用恢复约束。[MobX](https://mobx.js.org/observable-state.html) 更适合观察大量类对象；[Redux](https://redux.js.org/introduction/getting-started) 的 reducer/action 结构适合更多客户端共享事件协议。暂不同时引入多个库。

## 参考实现到我们的机制

| 来源 | 查看位置 | 吸收的机制 | 当前实现 |
| --- | --- | --- | --- |
| Pi | `packages/tui/README.md`、`test/chat-simple.ts` | 差分渲染、Editor、Markdown、ScrollView、固定布局 | 直接依赖锁定版 pi-tui；自研 TerminalApp |
| Pi | `packages/agent/src/agent-loop.ts` | steering/follow-up 分离、参数校验、截断调用不执行 | Agent 的 steer/queue；Dispatcher 统一入口 |
| Pi | `packages/ai/README.md` | 供应商协议、流式事件、认证环境变量、usage | 直接依赖锁定版 pi-ai；保留 provider envelope |
| Pi | `packages/coding-agent/src/core/session-manager.ts` | 原始历史与模型上下文分离 | 原始日志不删，checkpoint 只改变模型投影；暂不实现会话分支树 |
| Codex | `codex-rs/core/src/tools/orchestrator.rs` | 执行前授权、执行策略集中管理 | Dispatcher 的 ask/edit/auto/plan；TUI 通过 /mode 同步切换提示词、工具和权限；OS 沙箱后置 |
| Codex | `codex-rs/core/src/context_manager/normalize.rs` | 取消后修复工具调用配对 | 恢复时给未完成调用补终态及结果，不自动执行 |
| Codex | `codex-rs/core/src/tools/parallel.rs` | 可并行工具与排他工具区分 | 全读取批次并行，包含写入或 shell 的批次串行 |
| OpenCode | `packages/core/src/session/runner/llm.ts` | 持久输入驱动、step 重新加载历史 | durable inbox；每步重建 context |
| OpenCode | `packages/core/src/session/run-coordinator.ts` | 单会话推进、迟到唤醒、取消与收尾分离 | Agent.running 单所有者；结束边界再检查 inbox |
| OpenCode | `packages/core/src/session/execution.ts` | 崩溃恢复依赖持久记录 | 日志中的 started/finished 和 PID 锁；不宣称集群所有权 |
| OpenCode | `packages/core/src/session/compaction.ts` | 执行交接摘要、近期内容保留 | 目标、最新约束、证据、未知结果和下一步摘要 |
| Claude Code | 官方 how-claude-code-works、permissions、sub-agents | 工作中可修正、审批交互、按需 skills、上下文隔离 | 编辑器不禁用、拒绝默认选项、load_skill、只读子会话 |

Claude Code 官方参考：[工作机制](https://code.claude.com/docs/en/how-claude-code-works)、[权限](https://code.claude.com/docs/en/permissions)、[子代理](https://code.claude.com/docs/en/sub-agents)。这些是公开行为依据，不是内部源码审阅结论。

## 持久化不变量

1. 消费 inbox 的记录同时携带用户消息；不先写消息再单独消费输入。
2. `tool.started` 经 fsync 成功后才进入工具执行。
3. `tool.finished` 同时携带终态与模型可见结果，避免两条记录间的崩溃窗口。
4. 所有未执行、拒绝、校验失败、截断或取消的模型调用都返回配对结果。
5. 用户直接执行的 `/undo` 用 user 状态通知更新模型上下文，不伪造孤立 toolResult。
6. 同一个 session 只允许一个存活进程持有写入锁，进程内只有一个执行链。
7. 未知副作用阻塞自动执行，必须由用户检查并显式恢复。
8. 原始记录与文件检查点不因压缩而删除。

这里的持久性以文件成功写入和 fsync 为边界。文件系统损坏、断电时目录元数据保证、恶意本地进程、远端接口幂等以及 PID 重用，不在第一版的强保证内。

## 中断和并发

输入默认 steer；执行完本批工具后把修正纳入下一步。queue 在当前工作不再需要续执行时投递。取消传递到模型请求、工具和子代理；已取消批次的剩余调用也得到结果。正常空闲边界再检查持久 inbox，避免消息刚好到达收尾阶段而无人唤醒。

子代理只读并使用独立会话，但共享工作区和预算。读取并行不等于快照读取；如果父任务同时修改其他文件，子代理观察到的内容可能变化。需要严格隔离的任务以后接入 worktree 或执行器快照。

## 预算和压缩

Budget 独立于消息列表和 compaction。父代理、子代理、摘要与适配层显式重试消耗同一个额度；压缩不会恢复剩余额度。SDK 内部重试关闭，适配器只有在可重试错误且尚未输出文本时重试，防止重复展示半个回答。

模型请求超过估计窗口的 65% 时尝试摘要；保留近期完整调用批次或最近用户交互。失败保留原上下文；超过 90% 且无法安全压缩时停止并提示缩短输入。估算基于 UTF-8 字节，不替代供应商 tokenizer，也不保证一定不会被远端拒绝。

## 接下来的扩展位置

- **执行隔离**：ShellExecutor 已通过 sandbox-runtime 接入 Seatbelt/bubblewrap，默认禁止网络且失败不降级；下一步加入受审计的网络放行、资源限制和容器执行器，见 [sandbox.md](sandbox.md)。
- **MCP**：将发现的工具转换为 registry 项；schema、授权、取消、输出和日志仍必须走 Dispatcher。
- **复杂插件**：先决定信任和隔离边界；当前不加载可以直接访问宿主的任意 hooks。
- **OAuth**：向 Pi Models 注入持久 credential store，登录 UI 与凭据存储分离。
- **跨进程执行**：替换 PID 锁和进程内协调，设计租约、fencing 及外部副作用幂等键；不能只把 JSONL 换成数据库就声称分布式安全。
- **可靠性评测**：除最终答案外，统计输入丢失、重复副作用、工具终态完整率、中断延迟、验证证据和单位成功成本。

## 历史会话选择

`listSessions` 只读取当前工作区 `.loom/sessions`，不调用 `Session.open`，因此列出不会获取写锁、截断日志或重置运行状态。先按工作区与主会话过滤，再按最后记录时间降序排列。原生选择器只允许选择未占用会话；真正打开仍依赖独占锁，并使用 `existing: true` 防止选中会话消失时误建新会话。启动选择器只持有临时终端组件，结束后销毁，不需要把启动状态并入运行中的 Zustand store。

参考本地源码：Pi 的 `packages/coding-agent/src/cli/session-picker.ts` 将启动选择器与执行界面分开；Codex 的 `codex-rs/cli/src/main.rs` 中 `ResumeCommand` 提供选择器、指定 ID、`--last` 与当前目录过滤；OpenCode 的 `packages/cli/src/commands/handlers/session/list.ts` 按项目、`parentID: null`、更新时间倒序列出，提供表格和 JSON。Loom 先实现当前项目范围，不提供全局跨项目查找或会话 fork。
