# 架构与前辈实现的取舍

本文基于本地 2026-10-11 至 12 的源码快照：Pi `c661bc5`、Codex `a9b0815`、OpenCode `3e78cd5`；Claude Code 仓库 `3deb873` 不含完整核心，相关行为参考官方公开文档。

## 核心边界

```text
TerminalApp / headless JSON / SDK
       │  输入、审批、事件
       ▼
Agent: 单会话协调、step、预算、取消、委托
       ├── Context: 指令、skill 索引、模型视图、压缩
       ├── Model: Pi provider 或离线模型
       └── Dispatcher: 校验 → 授权 → 记录意图 → 执行 → 记录结果
                       ├── 文件与版本检查点
                       ├── 主机 Shell 与输出 artifact
                       └── 只读子代理
       │
       ▼
Session: 有序 JSONL、fsync、输入与结果投影、恢复
```

UI 不调用工具实现，工具不依赖终端，模型适配不负责运行循环。每次模型请求从持久记录重新投影；流式增量是临时展示，完整 assistant envelope 才进入执行历史。只有完整响应结束后执行工具，牺牲少量流式重叠以简化截断和恢复边界。

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

- **OS 沙箱**：把 shell execute 换成受限制的 Executor，明确网络和文件系统策略，保留同一 Dispatcher 授权入口。
- **MCP**：将发现的工具转换为 registry 项；schema、授权、取消、输出和日志仍必须走 Dispatcher。
- **复杂插件**：先决定信任和隔离边界；当前不加载可以直接访问宿主的任意 hooks。
- **OAuth**：向 Pi Models 注入持久 credential store，登录 UI 与凭据存储分离。
- **跨进程执行**：替换 PID 锁和进程内协调，设计租约、fencing 及外部副作用幂等键；不能只把 JSONL 换成数据库就声称分布式安全。
- **可靠性评测**：除最终答案外，统计输入丢失、重复副作用、工具终态完整率、中断延迟、验证证据和单位成功成本。
