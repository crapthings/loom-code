# 沙箱调研与第一阶段实现

调研时间：2026-10-13。本地源码快照：Pi `c661bc5`、Codex `a9b0815`、OpenCode `3e78cd5`；Claude Code 使用公开文档及其开源沙箱运行时作为依据，不声称审阅其私有核心。

## 前辈如何划分边界

| 实现 | 机制与证据 | Loom 的取舍 |
| --- | --- | --- |
| Codex | macOS Seatbelt；Linux bubblewrap 管文件系统和 namespace，seccomp 限制系统调用；将工具授权与执行隔离分层 | 保留 Dispatcher 的批准流程，单独引入 Executor；工作区写入不等于任意主机写入 |
| Claude Code | shell 使用 sandbox-runtime；macOS Seatbelt、Linux bubblewrap 与网络代理；文件工具在 shell 沙箱外 | 复用运行时，并让文件工具另行执行路径与凭据限制；拒绝不完整的隔离及自动裸机回退 |
| Pi | sandbox 扩展示例覆写 bash，通过同一 sandbox-runtime 包装命令；示例可合并项目配置 | 使用固定的宿主策略，不让工作区配置扩大权限；网络第一阶段全部拒绝 |
| OpenCode | 权限规则控制工具使用；本地快照的 WorkspaceDriver/EnvironmentDriver 抽象区分执行环境 | 保留可注入执行接口；不将权限规则、worktree 或远端资源名称本身视为 OS 隔离保证 |

依据：[Codex Linux 实现](https://github.com/openai/codex/blob/a9b0815/codex-rs/linux-sandbox/README.md)、[Codex Seatbelt 策略](https://github.com/openai/codex/blob/a9b0815/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)、[Claude Code 沙箱文档](https://code.claude.com/docs/en/sandboxing)、[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)、[Pi sandbox 扩展示例](https://github.com/earendil-works/pi/blob/c661bc5/packages/coding-agent/examples/extensions/sandbox/index.ts)、[OpenCode 权限](https://opencode.ai/docs/permissions/)、[OpenCode WorkspaceDriver](https://github.com/anomalyco/opencode/blob/3e78cd5/packages/core/src/workspace/driver.ts)。

## 为什么先选择原生沙箱

本地编码需要已有 Node、编译器、项目依赖和工作区。Seatbelt/bubblewrap 不要求为每个项目预建容器镜像，改造范围集中在 shell 启动边界。固定 `@anthropic-ai/sandbox-runtime@0.0.79` 复用跨平台策略生成、网络隔离和 Linux socket 限制；Loom 负责收紧策略、凭据环境、生命周期与失败处理。

Docker/容器可作为后续 Executor，但不能直接挂载整个 HOME、Docker socket 或宿主凭据。远端容器/VM 适合进一步隔离执行环境，代价是文件同步、镜像、依赖缓存和资源管理。第一阶段不接入远端服务，也不自行编写一套内核沙箱。

## 当前策略

默认 `--sandbox required`，每次 shell 调用检查依赖并构造策略，再执行命令。依赖缺失、警告表明能力退化、初始化失败、策略出现无法应用的 glob 都返回工具错误。没有自动降级、自动重试裸机或通过 `/mode` 关闭沙箱的路径。只有用户启动时明确选择 `--sandbox off` 才使用主机执行。

- 写入：工作区及每次调用独立临时目录；保护 `.git`、`.loom`、项目智能体/IDE 配置、常见凭据路径和运行中的 Loom 安装目录。
- 读取：限制 HOME、其他用户目录及通用临时目录，重新开放工作区、当前调用临时目录和 Node 可执行文件目录；系统运行时文件仍可读取，不能称为严格的工作区读取白名单。
- 网络：shell 的外部域名、直接 TCP、Unix socket 和本地监听均不开放。运行时内部的拒绝代理是必要基础设施；没有用户网络放行配置。
- 环境：从小型变量白名单构造，使用临时 HOME、TMPDIR 和缓存；不继承 API 密钥、数据库 URL、SSH agent、Node/shell 启动钩子与动态加载环境变量。
- 启动辅助程序：Linux 的 bubblewrap、socat 和 ripgrep 仅从固定系统目录查找，seccomp 使用固定依赖内的二进制；不从项目或用户传入的 PATH 查找沙箱辅助程序。
- 文件工具：独立禁止越界、符号链接跳出、常见凭据文件与元数据访问；不因为 shell 有沙箱就省略这些检查。`.env.example` 可以通过文件工具读取。
- 生命周期：进程组取消、超时、输出上限、终态配对继续生效；退出后清理运行时、临时目录和进程组。进程全局的 SandboxManager 在多个 SDK Agent 间串行使用，防止一个调用重置另一个调用的策略。

模型 API 请求运行在 shell 沙箱外，所以默认 Vercel 接入继续工作。项目指导和 lazy skills 由独立受控加载流程读取，不是让 shell 访问配置目录。

## 使用与诊断

```sh
loom --sandbox-status
loom
# TUI: /sandbox 查看执行边界；/mode auto 自动执行但不扩大隔离边界
```

Linux 需要 `bubblewrap`、`socat` 和 `ripgrep`，以及允许建立非特权 namespace 的宿主配置：

```sh
sudo apt-get install bubblewrap socat ripgrep
```

不支持的宿主或外层限制可能仍使沙箱启动失败。依赖检查只证明组件存在，不证明宿主一定允许执行；真正的工具执行才验证启动能力。不能用 `--sandbox off` 作为自动兼容路径。

Ubuntu 的 AppArmor 非特权 user namespace 限制可能导致 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`，即使依赖检查通过。宿主管理员需要审阅针对 bubblewrap 与运行时 seccomp helper 的 `userns` AppArmor 配置；Loom 不自动修改系统策略，也不关闭网络隔离以绕过该错误。CI 在临时 Ubuntu runner 上为这两个可执行文件加载定向配置，没有全局关闭 AppArmor。[同类兼容问题记录](https://github.com/openai/codex/issues/15057)。

默认网络关闭，联网安装依赖、git push、浏览器登录、依赖本机服务的测试会失败。先由用户在自己的终端准备依赖，再让智能体执行离线编辑与测试。隔离 HOME 意味着个性化 shell 初始化、用户全局缓存和部分 HOME 下的工具链不可访问。

## 验证与剩余工作

行为测试包含：工作区与私有临时目录写入成功，工作区外读写失败，符号链接越界失败，凭据读取和重命名失败，Git 配置与日志修改失败，直接 TCP 与 Unix socket 失败，初始化失败不回退，取消等待不影响其他调用，以及写 JS 后执行真实 Node 测试。

这些测试不构成形式化安全证明。文件工具尚不防御恶意本地进程造成的 TOCTOU 或硬链接竞争；沙箱不保证限制 CPU、内存或磁盘用量，也不等价于 VM。macOS 的进程组清理不保证追踪主动脱离进程组的恶意后代。底层运行时仍是实验性依赖，需跟踪更新并继续做逃逸测试。

Linux 的读取 glob 在包装命令时展开，只隐藏当时存在的匹配项；后续新建的文件不由这次展开自动覆盖。写入 deny 使用字面路径，常见根目录凭据路径预先禁止，现存嵌套凭据通过读取掩蔽保护；macOS 使用路径模式覆盖后来出现的匹配文件。不能将这些规则描述为动态、完备的秘密检测器。

下一阶段优先做：域名放行与审计、可信工具链目录配置、服务型测试的受控本地网络、资源限制、独立容器 Executor，以及真实 Vercel/DeepSeek 编码任务评测。开放网络时必须重新评估凭据泄露与代理绕过风险。
