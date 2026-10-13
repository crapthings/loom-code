# 架构与前辈实现的取舍

## 决策模型与旁路评估

正常完成先持久化 `task.finished`，再做旁路评估；`unfinishedRun()` 供执行恢复和只读会话目录共用，避免评估中断或崩溃把已完成任务误判为待执行。后续已交付的新输入或新模型步骤仍会使任务恢复为未完成，未交付队列单独恢复。

`src/model/catalog.js` 注册聊天与 classifier 目录；`src/model/decision.js` 使用 Pi 原生 `classify()`，走 Vercel TypeSafe 兼容协议并复用网关认证。默认决策模型是 `openai/gpt-6-luna-decisions`，可选择 `typesafe-ai/jev`；聊天 `complete()` 接口保持独立。协议背景参考 [Vercel Decision 文档](https://vercel.com/docs/ai-gateway/modalities/decision) 和 [OpenAI Decisions 文档](https://developers.openai.com/api/docs/guides/decisions)。

`--verify shadow` 显式启用主任务完成后的观察，每轮最多 3 次，单次最多 5 秒，不重试，不自动增加执行步骤，不评估子代理。`src/core/verification.js` 组合当前交付输入、有限的历史和工具/文件事实，明确标记截断，证据和问题合计限制 64 KiB。三个独立问题判断要求覆盖、无证据声明和缺少验证；答案校验后作为观察记录，不进入聊天上下文或权限流程，不作为完成真值。

`decision.started` 持久化版本、证据、问题和输入哈希后发请求；`decision.finished` 配对保存判断、耗时及返回用量，故障和超时仅记录，用户取消仍中断。恢复时将未结束决策结算为 unknown，不重放。Budget 为决策维护独立调用/用量计数，同时汇总 token 与费用；超时、取消和崩溃的未知用量不伪造为已知零费用。后续用人工标注与真实测试结果评估误报、漏报和延迟，再考虑执行策略。

本文基于本地 2026-10-11 至 12 的源码快照：Pi `c661bc5`、Codex `a9b0815`、OpenCode `3e78cd5`；Claude Code 仓库 `3deb873` 不含完整核心，相关行为参考官方公开文档。

## 核心边界

```text
TerminalApp / headless JSON / SDK
       │  输入、审批、事件
       ▼
Agent: 单会话协调、step、预算、取消、委托
       ├── Context: 指令、skill 索引、模型视图、压缩
       ├── Model: Vercel AI Gateway
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

## 分发与顺序流程

`src/ui/commands.js` 集中声明斜杠命令的名称、别名、参数规则和执行回调；帮助、补全与执行使用同一份注册表。应用只注入命令需要的动作，注册表不持有终端、工具或会话对象。普通文本直接入队，未知命令和错误参数在执行前拒绝。

`src/ui/transitions.js` 按事件名称组织纯状态转换；`uiTransition` 先检查关闭状态和子代理边界，再检查自有事件键并执行一个转换。流式文本、队列和弹窗转换保留各自的前置检查与不可变快照。事件处理表适用于互斥的行为选择，early return 适用于前置条件；工具验证、授权、意图提交、执行和结果结算继续使用显式顺序流程。

## 工具文件读写与结算

`src/io.js` 为 core、tools 和 UI 提供有大小上限的普通文件读取和关闭句柄的同步写入；最终路径不跟随 symlink，FIFO 以非阻塞方式打开后拒绝。工作区文本上限 2 MiB，搜索单文件 256 KiB，输出 artifact 10 MiB，checkpoint JSON 和重新打开的会话日志 16 MiB，锁文件 4 KiB，技能文件 32000 字节，UI 设置 64 KiB。目录列举最多 5000 文件，并在达到上限时提示缩小路径。

文件修改先写入并同步 checkpoint，再提交日志事实，最后替换文件。已有文件使用独占临时文件，版本冲突、写入失败或取消时清理临时文件，替换前再次检查取消。`Dispatcher.authorize()` 保留模式、审批、授权日志与会话授权的检查；未知 effect 被拒绝。工具输出只接受字符串或 `{ text: string, isError: boolean }`，异常契约与非 Error 抛出值仍转换为配对失败结果。此实现改善边界与清理，不消除父目录替换、hardlink 或版本检查到 rename 之间的竞态。

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

contextBudget 分别报告系统指令、消息和工具声明的估算大小。每次请求预留不超过 8192 token、窗口 20% 或模型输出上限的输出额度（取最小值），另留窗口 10% 的安全余量；实际 maxTokens 传给模型适配器。输入超过窗口 65% 或剩余输入上限的较小值时尝试摘要，无法安全缩短到输入上限时停止。`/status` 显示估算输入、窗口、预留及压缩阈值；它们不是计费用量，也不能代替供应商 tokenizer。

taskState 从原始 inbox.delivered、task.finished 和 tool.finished 投影当前任务，不从模型宣称推断测试通过。最多保留首条与最近七条用户要求、最近十二条工具结果引用；长输入保留首尾并标明省略和源事件。压缩检查点持久化该状态及压缩前后输入估算；当前任务已经压缩掉的要求和结果引用独立附在摘要之后，防止自由文本摘要静默丢失修正。原始日志继续保留全部内容，此投影尚不是长期记忆；模型可通过 read_history 按源事件编号取回省略的内容。

压缩切分回退到用户消息边界，保留完整近期工具调用和结果。当前保留部分自身超限时不浪费摘要调用；自动压缩若没有降低完整请求估算大小，不提交检查点。失败或取消保留原上下文；手动压缩允许用户选择主动整理较短对话。历史日志和模型摘要依然可能存在陈旧事实，SQLite 历史索引与带来源的显式记忆分别处理检索和跨会话知识。

## 可重建的 SQLite 历史索引

HistoryStore 按需启动 Worker，所有 SQLite、FTS5 和日志扫描都在 Worker 内执行。search_history/read_history 作为只读工具经过 Dispatcher；默认当前会话，主代理可显式搜索同工作区根会话，子代理只能查询自身。数据库不持有执行权限，不参与恢复判定，不自动把旧对话注入新任务；历史事实仍需按当前代码重新核验。

`.loom/history.sqlite` 包含 sessions 元数据和 FTS5 trigram 消息/摘要索引。缓存保存日志文件指纹、最后完整事件序号及已索引前缀哈希；新消息追加索引，旧记录改写或截断时替换该会话索引。刷新只读取完整 JSONL 行，不修复日志、不回收锁。索引无效或删除后可以从日志重建，read_history 则直接读取源文件，独立于数据库健康状态。resume --list 保持原有只读扫描契约，不隐式创建索引。

索引使用 DELETE journal 而非要求所有支持的 Node 内置 SQLite 都具备同一 WAL 修复版本；同步策略为 NORMAL，因为缓存可重建。数据库固定 schema 版本，关闭扩展加载，短事务加 250ms 锁等待；请求十秒超时或取消会终止 Worker，关闭代理也会清理 Worker。SQLite 不可用、缓存损坏和锁冲突表现为历史工具错误，不阻止正常 Agent 初始化或会话落盘。

单日志上限 16 MiB；工作区搜索最多扫描 1000 个会话及 64 MiB 变化日志，并报告跳过数量；当前会话查询仅刷新该会话。缓存限制为 65536 页。搜索返回最多二十条、每条七百字符及来源编号；不足三个 Unicode 字符时使用字面子串查询，其他查询使用转义的 FTS5 短语。read_history 每页返回最多 12000 字符，nextOffset 支持续读。历史查询结果不再重复索引，避免召回内容不断复制放大。

真实目录、普通单链接文件和工作区归属检查防止常见重定向；父目录替换等文件系统竞态仍遵循现有安全限制。首次索引、全文搜索质量及大量并发尚需真实工作负载评估，当前不宣称性能提升或 exactly-once。

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


## 显式长期记忆

MemoryStore 与 HistoryStore 共用 WorkerStore 请求生命周期，但使用独立数据库。`.loom/memory.sqlite` 是权威存储，revisions 保存不可变修订，heads 指向当前修订，operations 保存原子写入回执。更新和失效必须携带 expectedRevision；事务内再次检查版本及回执，避免并发覆盖。原始会话 JSONL 仍负责工具意图与终态；数据库和 JSONL 之间没有分布式原子事务，崩溃后绝不自动重放未知写入。

root Agent 提供 list_memories/get_memory/remember/forget_memory；子代理不提供记忆接口。所有操作经过 Dispatcher，写入遵循 ask/edit/auto/plan 权限。系统指令要求显式用户请求才保存；未实现自动提取或每轮全量注入。/memory 是只读控制入口，也经 Dispatcher 落盘，不请求模型。SDK 同时导出 MemoryStore。

记录包含 kind、project/path 范围、文本、来源事件 ID/序号/哈希、状态、修订号及可选过期时间。get 核验源日志，变化或缺失在返回结果中标记 stale；过期同样计算为 stale，不隐式改写历史。list 不核验全部来源，路径过滤包含项目记录及对应路径子树；指定 revision 可审阅旧版。forget 追加失效修订，归档不擦除旧记录。数据库无法证明记忆仍符合当前代码。

每条文本最多 4000 字符、来源 1–8 个事件、累计源日志最多 64 MiB（每个日志仍限 16 MiB）；查询最多 20 条并支持分页，最多 10000 个记忆 ID。修订与回执尚无总磁盘配额。DELETE/EXTRA 保护权威写入；读取不存在的记忆不会创建数据库，损坏时失败而不自动重建。十秒超时或取消终止 Worker，关闭时等待终止；同调用 ID 原子回执支持有限幂等，不能承诺跨新调用或 JSONL 的 exactly-once。


## 遍历成本

Session 的 inbox、messages 和最新类型事件索引只投影已经持久写入的新增事件；打开日志时首次读取会重建，缓存不参与恢复真值。重复查询不再扫描全日志，pending 返回成本取决于待处理输入数，messages 返回独立数组的成本仍取决于消息数。events 是追加日志视图，变更必须通过 append；替换整个事件数组或截短会触发投影重建，不支持直接改写旧事件的类型。

压缩后的上下文从日志尾部读取到 through 水位即停止；已完成任务不再为上下文构造不用的完整任务事实。taskState 只扫描选中任务范围，保留最初输入及最近七条修正、最近十二条工具结果，同时统计遗漏；临时记录数量固定，仍需读取任务范围来计算准确遗漏。压缩边界选择一次遍历，按同一用户边界分割，不改变调用/结果配对。会话列表合并子会话识别、队列和工具状态扫描。文件树复用 Set 排除目录，编辑复用已定位的文本位置。

上下文预算按分项序列化一次，复用 UTF-8 字节数并补上 JSON 外层开销，保留原先的完整提示词估算及分项取整。单会话历史索引刷新只清理该会话的缓存记录；变化日志的完整解析与前缀哈希校验仍保留，避免用速度换掉改写检测。小型模式、语言和工具列表保持直接查找，避免额外注册缓存和失效协议。遍历测试使用事件访问次数及边界等价检查，不把耗时阈值当作正确性条件。
