# Windows 进程所有权与验收边界

2026-10-27：本批接管 Windows 异步命令、task、cron、MCP、持久 Bash 和 debug。当前同步 Git/截图等入口仍待处理；不是 Win7 实机验收通过声明。

## 运行物料

- `lib/process-owner.js` 保留 ChildProcess/execFile 接口；`native/process-owner.exe` 为预编译 AnyCPU/CLR2 程序，通过 P/Invoke 调用 Win32，不需要目标机编译器或新增 VC Runtime。
- `.exe.config` 优先 CLR2，允许已有 CLR4。**不下载或启用 .NET**；目标机缺少可用 CLR 时，命令功能不可交付。运行时与 .NET 开发环境不同。
- `.json` 绑定 exe、`.cs`、CLR 配置和应用 manifest 的 SHA256。源文件/配置修改后必须重建，不能留下旧二进制。`.gitattributes` 固定这些文本为 LF，避免 Windows checkout 改变散列。
- 开发机执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-process-owner.ps1` 重建，需要 .NET 3.5 编译器及 CLR2 System.dll。该步骤不在目标机启动链路内；未实测 Win7 PS2 编译。

首次托管启动前检查物料，缺失/损坏明确拒绝，不回退到无归属启动。`/api/info.processOwner` 显示物料状态、活动/待握手数及错误；物料有效不等于 CLR/目标程序已验收。最多 128 个活动托管程序；CLR 和目标程序的内存不由计数保证，Win7 仍需实测并发内存。

## 生命周期

1. Agent 建立随机命名管道；每次启动另有 nonce，校验托管程序 PID 后握手。控制消息不混入标准输入输出。
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
| 同步 execSync/execFileSync：Git、截图、桌面辅助、发现命令等 | 本批未接管，不能据异步路径通过宣称这些后代已归属 |
| process_kill_tool | 仍按用户提供 PID 操作外部进程，与 task/cron 所属句柄停止不同 |
| Win7 外层已有非 breakaway Job | Win7 不支持嵌套；目标已在外层 Job 时可能绑定失败，明确拒绝。需实测任务计划/服务/远程宿主 |
| 目标需要自己的 Job / 主动 breakaway | Win7 可能功能冲突或创建失败，不保证任意程序兼容；不以允许逃逸来伪装兼容 |
| WMI、服务、ShellExecute 等外部 broker 创建进程 | 不保证属于本 Job，不能等同普通 CreateProcess 后代；须限制或单独管理 |
| 超长命令 | Base64 UTF16 传输使可用容量小于直接启动的 32767 字符；检查展开长度，超限要求脚本文件，不截断参数 |
| macOS/Linux | 保留原 child_process，不声称获得 Windows Job 语义 |

依据：[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AssignProcessToJobObject 的 Win7/PCA 限制](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。随包 Node13.14 使用 libuv1.37.0，其[原始 spawn 实现](https://raw.githubusercontent.com/libuv/libuv/v1.37.0/src/win/process.c)允许后代 silent breakaway，不能代替本批整组归属。

## 验证

`test:process-owner` 覆盖参数、中文/空格、stdio、创建失败、三代树（中间层先退、叶子 detached/忽略 stdio）、自然结束、Agent/托管程序强杀及再启动；用叶子端口和心跳判断清理。集成专项覆盖实际隔离 Agent 的命令/PowerShell/task/cron/MCP，以及原函数 VM 下实际 native debug/Bash。故障专项覆盖物料、暂停边界、超时/输出上限、未知终态及共享准入。分段续测及实测结果见 ISSUES-LOG.md。

发布前仍须干净 Win7 SP1 x64、普通用户、实际 CLR2/选定 CLR4、缺 CLR、中文/空格安装和工作区、默认 PS2、真实 Git/Python/MCP、外层 Job、任务计划/服务、关窗口/Ctrl+C/强杀/注销/关机后再次启动。验证三代心跳、独占文件、端口，以及 24/72 小时 helper/句柄/内存变化。现代 Windows 的成功不能替代这些门槛。
