# Windows 进程所有权与验收边界

2026-10-27：接管 Windows 异步命令、task、cron、MCP、持久 Bash、debug、截图/桌面输入；后续批将同步 Git/发现等入口也接入。不是 Win7 实机验收通过声明，创建/绑定期间的强杀窗口仍待验证。

## 运行物料

- `lib/process-owner.js` 保留 ChildProcess/execFile 接口；`native/process-owner.exe` 为预编译 AnyCPU/CLR2 程序，通过 P/Invoke 调用 Win32，不需要目标机编译器或新增 VC Runtime。
- `.exe.config` 优先 CLR2，允许已有 CLR4。**不下载或启用 .NET**；目标机缺少可用 CLR 时，命令功能不可交付。运行时与 .NET 开发环境不同。
- `.json` 绑定 exe、`.cs`、CLR 配置和应用 manifest 的 SHA256。源文件/配置修改后必须重建，不能留下旧二进制。`.gitattributes` 固定这些文本为 LF，避免 Windows checkout 改变散列。
- 开发机执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-process-owner.ps1` 重建，需要 .NET 3.5 编译器及 CLR2 System.dll。该步骤不在目标机启动链路内；未实测 Win7 PS2 编译。

首次托管启动前检查物料，缺失/损坏明确拒绝，不回退到无归属启动。`/api/info.processOwner` 显示物料状态、活动/待握手数及错误；物料有效不等于 CLR/目标程序已验收。最多 128 个活动托管程序；CLR 和目标程序的内存不由计数保证，Win7 仍需实测并发内存。

## 生命周期

1. 每个Agent懒启动一个Node13内置worker_threads控制线程（最多5秒启动/注册等待），独立维护随机命名管道，避免主线程同步调用阻塞握手/ACK。每次启动另有nonce；异步路径先复核ChildProcess PID，才允许运行。同步路径返回前没有PID，以注册nonce授权，返回后必须复核对端PID与spawnSync返回PID相同，才接受成功。控制消息不混入标准输入输出。
2. 创建不允许 breakaway 的匿名 Job，设置 `KILL_ON_JOB_CLOSE`。
3. 用 `CREATE_SUSPENDED` 创建目标，成功绑定 Job 后报告 READY；收到 GO 才恢复。创建/绑定/握手失败终止未恢复目标，不降级执行。
4. `ChildProcess.kill()` 向所属控制连接发送 STOP。托管程序终止整个 Job，查询活动成员为零，报告 STOPPED；Agent 确认收到证明后才允许退出。不按旧 PID 枚举树或 taskkill。
5. 根目标自然退出也清理剩余后代，保留根退出码。**长期后台命令应保持根进程存活**，不能依赖根命令结束后留下孙进程。
6. Agent 强制退出会断开控制管道，托管程序终止 Job；托管程序不可捕获终止时，内核关闭唯一 Job 句柄并请求回收成员。只有收到活动成员为零的证明，才设置 `ownedTree.closed`；意外关闭不冒充已确认清理。

控制管道采用 overlapped IO；缓冲区、OVERLAPPED 和事件保持固定 native 地址直到完成。内核/驱动异常仍可能使停止结果未知，不承诺系统调用有硬时间上限。普通命令成功回调要求 Job 空证明；debug 的未启动/清理未知不进入自动修复；cron 清理未知会禁用后续自动触发并保留原因。MCP/shell 已执行副作用仍需查验，不自动重放。

## 边界

| 场景 | 行为 / 限制 |
|---|---|
| 接管的 Windows 异步入口 | `child.pid` 是托管程序 PID；`ownedTree.targetPid` 仅作诊断，不能事后据此 kill |
| 编辑器/目录打开、后台 Agent 启动交接 | 显式外部生命周期，保留原始 spawn，避免启动器退出就杀编辑器或后台 Agent |
| 同步 spawnSync/execSync/execFileSync：Git、worktree、发现命令等 | 经同一控制线程/Job接管，保留stdout/Buffer/退出码/错误stderr。同步调用仍阻塞Agent主线程，期间HTTP/模型/MCP解析和JS取消不能运行；控制线程不解决这个问题 |
| process_kill_tool | 仍按用户提供 PID 操作外部进程，与 task/cron 所属句柄停止不同 |
| Win7 外层已有非 breakaway Job | Win7 不支持嵌套；目标已在外层 Job 时可能绑定失败，明确拒绝。需实测任务计划/服务/远程宿主 |
| 目标需要自己的 Job / 主动 breakaway | Win7 可能功能冲突或创建失败，不保证任意程序兼容；不以允许逃逸来伪装兼容 |
| WMI、服务、ShellExecute 等外部 broker 创建进程 | 不保证属于本 Job，不能等同普通 CreateProcess 后代；须限制或单独管理 |
| 超长命令 | Base64 UTF16 传输使可用容量小于直接启动的 32767 字符；检查展开长度，超限要求脚本文件，不截断参数 |
| macOS/Linux | 保留原 child_process，不声称获得 Windows Job 语义 |

**创建窗口（INC-JOB-02，High，受保护注入确认／尚未修复）**：Main 中 CreateProcessW(CREATE_SUSPENDED) 与 AssignProcessToJobObject 分离。10-28 在隔离源码副本暂停于两者之间，确认目标不属于 broker 本次 Job；通过已持有句柄强制结束 broker 后目标仍活着，外层 guardian 随后归零清理。另一路 guardian 强杀也以目标/broker 稳定句柄确认退出。此实验刻意有外层保护，未制造无归属遗留，也不是 Win7 实机复现；生产 exe/源码/config 散列保持不变。既有就绪后强杀用例不能覆盖此窗口。机制、边界与实施顺序见 [创建阶段恢复计划](PROCESS-CREATION-RECOVERY-PLAN-2026-10-28.md)；不能把诊断中的嵌套 Job 直接部署到 Win7。T22-07 继续开放。

依据：[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AssignProcessToJobObject 的 Win7/PCA 限制](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。随包 Node13.14 使用 libuv1.37.0，其[原始 spawn 实现](https://raw.githubusercontent.com/libuv/libuv/v1.37.0/src/win/process.c)允许后代 silent breakaway，不能代替本批整组归属。

## 验证

`test:process-owner` 覆盖参数、中文/空格、stdio、创建失败、三代树（中间层先退、叶子 detached/忽略 stdio）、自然结束、Agent/托管程序强杀及再启动；用叶子端口和心跳判断清理。集成专项覆盖实际隔离 Agent 的命令/PowerShell/task/cron/MCP，以及原函数 VM 下实际 native debug/Bash。故障专项覆盖物料、暂停边界、超时/输出上限、未知终态及共享准入。分段续测及实测结果见 ISSUES-LOG.md。

`test:process-owner-sync`验证同步stdio/Unicode/错误、主线程阻塞时异步退出仍获确认、超时/超量未知、后代释放、父进程强杀及控制线程启动拒绝；`test:process-owner-git`验证实际HTTP Agent的status/diff/commit、提交前快照和callId审计，Git配置和hooks均在私有目录。控制线程增加一个Node isolate的常驻内存，CLR启动也增加每次Git调用成本，Win7并发内存和延迟须实测。

发布前仍须干净 Win7 SP1 x64、普通用户、实际 CLR2/选定 CLR4、缺 CLR、中文/空格安装和工作区、默认 PS2、真实 Git/Python/MCP、外层 Job、任务计划/服务、关窗口/Ctrl+C/强杀/注销/关机后再次启动。验证三代心跳、独占文件、端口，以及 24/72 小时 helper/句柄/内存变化。现代 Windows 的成功不能替代这些门槛。

## 桌面辅助后续批

截图与输入使用异步 runner、30 秒期限和 stdout/stderr 各 64 KiB 上限，取消后等待受管调用结算。输入脚本独占创建随机文件，UTF8 BOM/PS2 编码前缀、严格错误、完整写入/关闭后才执行；只删除归属仍匹配的文件，替换/未知残留保留并记录诊断。旧 `input.ps1` 不再写入或自动删除。输入文本限 16 KiB UTF8、脚本限 64 KiB、按键说明限 128 字符，超限明确拒绝。输入文件BOM保证脚本文字解码；控制台UTF8设置失败只告警，不阻断输入，Win7原生诊断仍可能使用系统代码页。

截图使用 try/finally 释放 Graphics/Bitmap，跨异步边界复核输出父目录，取消不再启动 vision。已经截图/输入的副作用不回滚；失败/取消要核对现场，成功也只表示系统 API 调用完成，未验证前台窗口/焦点正确。截图磁盘保留和 native 文件路径最后检查后的外部竞态仍开放。测试仅用捕获调用、Node 替身及真实文本 PowerShell，不操作桌面，不当作真实 Win7/GDI/SendKeys 验收。


## 手动创建窗口诊断（2026-10-28）

`npm run diagnostic:creation-window` 需要 Windows 与开发机 .NET 3.5 编译器，仅编译私有副本，不加入 test-all，也不要求目标机装编译器。默认完整诊断 14 项；`CREATION_WINDOW_SCOPE=tail` 为故障后的 12 项续测，输出明确标识计数并拒绝未知 scope。此次前 2 项首跑通过，夹具误判 conhost 成员数后修正，仅失败/未跑尾部 12/12 通过，不记为单次 14/14。目标始终由外层 Job 兜底，操作固定句柄与出生身份，显式清理查询活动数为零；guardian 强杀路径验证目标和 broker 均退出，不冒称拿到了未发送的零成员证明。临时隔离目录/manifest/证据保留，不代表全局临时文件清空。
