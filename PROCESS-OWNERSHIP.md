# Windows 进程所有权与验收边界

2026-10-28：v2 已接管异步命令、task、cron、MCP、持久 Bash、debug、截图/桌面输入及同步 Git/发现。创建者先加入严格 Job，目标从出生继承；创建窗口受保护回归通过，Win7 实机/宿主约束与长期运行仍未验收。

## 运行物料

- `lib/process-owner.js` 保留 ChildProcess/execFile 接口；`native/process-owner.exe` 为预编译 AnyCPU/CLR2 程序，通过 P/Invoke 调用 Win32，不需要目标机编译器或新增 VC Runtime。
- `.exe.config` 优先 CLR2，允许已有 CLR4。**不下载或启用 .NET**；目标机缺少可用 CLR 时，命令功能不可交付。运行时与 .NET 开发环境不同。
- `.json` 绑定 exe、`.cs`、CLR 配置和应用 manifest 的 SHA256。源文件/配置修改后必须重建，不能留下旧二进制。`.gitattributes` 固定这些文本为 LF，避免 Windows checkout 改变散列。
- 开发机执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-process-owner.ps1` 重建，需要 .NET 3.5 编译器及 CLR2 System.dll。该步骤不在目标机启动链路内；未实测 Win7 PS2 编译。

首次托管启动前检查物料，缺失/损坏明确拒绝，不回退到无归属启动。`/api/info.processOwner` 显示物料状态、活动/待握手数及错误；物料有效不等于 CLR/目标程序已验收。最多 128 个活动托管程序；CLR 和目标程序的内存不由计数保证，Win7 仍需实测并发内存。

## 生命周期

1. 每个Agent懒启动一个Node13内置worker_threads控制线程（最多5秒启动/注册等待），独立维护随机命名管道，避免主线程同步调用阻塞握手/ACK。每次启动另有nonce；异步路径先复核ChildProcess PID，才允许运行。同步路径返回前没有PID，以注册nonce授权，返回后必须复核对端PID与spawnSync返回PID相同，才接受成功。控制消息不混入标准输入输出。
2. 创建不允许 breakaway 的匿名 Job，设置 `KILL_ON_JOB_CLOSE`，**先把 broker 自身加入 Job**。Job 句柄不继承、不复制给其它进程；Win7 宿主已有不兼容 Job 时，在任何用户目标出现前拒绝。
3. 用 `CREATE_SUSPENDED` 创建目标，目标从出生继承同一个严格 Job；查询归属成功才报告 READY，收到 GO 才恢复。不再存在“用户目标已创建、尚待首次 Assign”这一步。
4. STOP/根目标自然退出后，broker 查询当前内核 Job 成员（最多4096个，超过明确失败），打开稳定句柄并再次验证属于本 Job 后终止其它成员。最多5秒清理，反复查询直到成员表仅有 broker 且活动数为1；**不是外部 PID 树或旧 PID 扫描**。查询/权限/预算/期限失败不报告成功，OS进程退出关闭唯一Job句柄兜底，结果仍标记未知。
5. v2发送 `TARGETS_EMPTY`/`STOPPED_EMPTY` 和根退出码，表示**目标组为空、broker仍待退出**；收到ACK或最多等2秒后正常退出，由OS关闭唯一Job句柄，保留选定退出码。`ownedTree.closed`是该目标组证明，完成操作还须ChildProcess close；不能把它解释为收到证明当刻整个Job已零成员。诊断暴露mode=windows-job-v2及proofScope=targets-empty-before-broker-close，旧协议物料明确拒绝。
6. broker强制死亡关闭唯一Job句柄，内核处理包含未恢复目标在内的本Job成员；Agent死亡导致管道EOF，broker停止并退出。没有收到目标组证明的意外关闭保持清理未知，不因内核兜底已请求就冒称完成。长期后台命令仍应保持根目标存活，自然退出也清理后代。

控制管道采用 overlapped IO；缓冲区、OVERLAPPED 和事件保持固定 native 地址直到完成。内核/驱动异常仍可能使停止结果未知，不承诺系统调用有硬时间上限。普通命令成功回调要求目标组空证明及 broker close；debug 的未启动/清理未知不进入自动修复；cron 清理未知会禁用后续自动触发并保留原因。MCP/shell 已执行副作用仍需查验，不自动重放。

## 边界

| 场景 | 行为 / 限制 |
|---|---|
| 接管的 Windows 异步入口 | `child.pid` 是托管程序 PID；`ownedTree.targetPid` 仅作诊断，不能事后据此 kill |
| 编辑器/目录打开、后台 Agent 启动交接 | 显式外部生命周期，保留原始 spawn，避免启动器退出就杀编辑器或后台 Agent |
| 同步 spawnSync/execSync/execFileSync：Git、worktree、发现命令等 | 经同一控制线程/Job接管，保留stdout/Buffer/退出码/错误stderr。同步调用仍阻塞Agent主线程，期间HTTP/模型/MCP解析和JS取消不能运行；控制线程不解决这个问题 |
| process_kill_tool | 仍按用户提供 PID 操作外部进程，与 task/cron 所属句柄停止不同 |
| Win7 外层已有非 breakaway Job | Win7 不支持嵌套；broker已在外层 Job 时自归属可能失败，创建目标前明确拒绝。需实测任务计划/服务/远程宿主 |
| 目标需要自己的 Job / 主动 breakaway | Win7 可能功能冲突或创建失败，不保证任意程序兼容；不以允许逃逸来伪装兼容 |
| WMI、服务、ShellExecute 等外部 broker 创建进程 | 不保证属于本 Job，不能等同普通 CreateProcess 后代；须限制或单独管理 |
| 超长命令 | Base64 UTF16 传输使可用容量小于直接启动的 32767 字符；检查展开长度，超限要求脚本文件，不截断参数 |
| macOS/Linux | 保留原 child_process，不声称获得 Windows Job 语义 |

**创建窗口（INC-JOB-02，High，代码已修／Win7发布验证待完成）**：v1在10-28受保护注入中确认Create与Assign间目标不属于broker本次Job，broker死亡后仍活着。v2改为创建者先归属，目标直接继承；同一创建后/恢复前暂停点确认归属为true，强杀broker后，在guardian尚未清理时目标稳定句柄已退出、外层Job活动数归零。创建窗口回归14/14通过，运行与退出路径见下。实验使用现代外层guardian作兜底，不是Win7无外层/宿主Job实测；T22-07整体保持开放。历史证据和实施记录见[创建阶段恢复计划](PROCESS-CREATION-RECOVERY-PLAN-2026-10-28.md)。

依据：[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AssignProcessToJobObject 的 Win7/PCA 限制](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。随包 Node13.14 使用 libuv1.37.0，其[原始 spawn 实现](https://raw.githubusercontent.com/libuv/libuv/v1.37.0/src/win/process.c)允许后代 silent breakaway，不能代替本批整组归属。

## 验证

`test:process-owner` 覆盖参数、中文/空格、stdio、创建失败、三代树（中间层先退、叶子 detached/忽略 stdio）、自然结束、Agent/托管程序强杀及再启动；用叶子端口和心跳判断清理。集成专项覆盖实际隔离 Agent 的命令/PowerShell/task/cron/MCP，以及原函数 VM 下实际 native debug/Bash。故障专项覆盖物料、暂停边界、超时/输出上限、未知终态及共享准入。分段续测及实测结果见 ISSUES-LOG.md。

`test:process-owner-sync`验证同步stdio/Unicode/错误、主线程阻塞时异步退出仍获确认、超时/超量未知、后代释放、父进程强杀及控制线程启动拒绝；`test:process-owner-git`验证实际HTTP Agent的status/diff/commit、提交前快照和callId审计，Git配置和hooks均在私有目录。控制线程增加一个Node isolate的常驻内存，CLR启动也增加每次Git调用成本，Win7并发内存和延迟须实测。

发布前仍须干净 Win7 SP1 x64、普通用户、实际 CLR2/选定 CLR4、缺 CLR、中文/空格安装和工作区、默认 PS2、真实 Git/Python/MCP、外层 Job、任务计划/服务、关窗口/Ctrl+C/强杀/注销/关机后再次启动。验证三代心跳、独占文件、端口，以及 24/72 小时 helper/句柄/内存变化。现代 Windows 的成功不能替代这些门槛。

## 桌面辅助后续批

截图与输入使用异步 runner、30 秒期限和 stdout/stderr 各 64 KiB 上限，取消后等待受管调用结算。输入脚本独占创建随机文件，UTF8 BOM/PS2 编码前缀、严格错误、完整写入/关闭后才执行；只删除归属仍匹配的文件，替换/未知残留保留并记录诊断。旧 `input.ps1` 不再写入或自动删除。输入文本限 16 KiB UTF8、脚本限 64 KiB、按键说明限 128 字符，超限明确拒绝。输入文件BOM保证脚本文字解码；控制台UTF8设置失败只告警，不阻断输入，Win7原生诊断仍可能使用系统代码页。

截图使用 try/finally 释放 Graphics/Bitmap，跨异步边界复核输出父目录，取消不再启动 vision。已经截图/输入的副作用不回滚；失败/取消要核对现场，成功也只表示系统 API 调用完成，未验证前台窗口/焦点正确。截图磁盘保留和 native 文件路径最后检查后的外部竞态仍开放。测试仅用捕获调用、Node 替身及真实文本 PowerShell，不操作桌面，不当作真实 Win7/GDI/SendKeys 验收。


## 手动创建窗口诊断（2026-10-28）

`npm run diagnostic:creation-window` 需要 Windows 与开发机 .NET 3.5 编译器，仅编译私有副本，不加入 test-all，也不要求目标机装编译器。当前为v2修复回归，完整14/14已通过；v1取证结果仅为历史记录。默认完整诊断 14 项；`CREATION_WINDOW_SCOPE=tail` 为故障后的 12 项续测，输出明确标识计数并拒绝未知 scope。此次前 2 项首跑通过，夹具误判 conhost 成员数后修正，仅失败/未跑尾部 12/12 通过，不记为单次 14/14。目标始终由外层 Job 兜底，操作固定句柄与出生身份，显式清理查询活动数为零；guardian 强杀路径验证目标和 broker 均退出，不冒称拿到了未发送的零成员证明。临时隔离目录/manifest/证据保留，不代表全局临时文件清空。


`npm run diagnostic:self-job`为独立机制原型，私有夹具21/21通过（首跑在零断言/零目标时因现有宿主Job提前拒绝；调整夹具明确记录外层宿主后再测）。覆盖创建者自归属后目标继承、三代树强杀、正常清理只剩创建者并保留退出码、控制EOF及模拟Win7单Job政策拒绝。当前全部正向路径preexistingJob=true，未取得无外层单Job或Win7证明；此原型结果不单独改变产品状态；随后v2移植及验收见下。


## v2 移植验证（2026-10-28）

重建CLR2 AnyCPU物料，exe SHA256=`47d3eb24dd25333585860e6cccb70c51854f261b6191067331d86c0a19831836`，源码/config/应用manifest仍按绑定清单核对。没有新增目标机编译器、VC或npm依赖。当前宿主有外层Job，现代Windows允许嵌套；Win7兼容宿主必须保证broker可先归属自己的唯一Job，否则在创建目标前拒绝。

native/协议实质变化后，受影响旧专项各执行一次：owner19、sync17、faults21、Git8、desktop-integration14、harness10、control-errors4、selection5，共98项；integration首3项通过，旧提示文字断言失败，修正后仅失败/未跑尾部11项通过。另v2创建窗口14/14。共126项有效检查，集成采用3＋11分段，不是一次全套。未重跑原型21、其它已过专项、A–J/UI/test-all；未运行Win7、真实桌面、注销/关机或24/72h。


追加`diagnostic:cleanup-failure`首次6/6：私有native源码在根退出后的清理入口抛错，确认125/阶段诊断、拒绝完成证明，同时OS关闭broker的唯一Job句柄仍清理真实detached叶子端口和心跳。合计本批132项有效检查，仍不等于实机或完整套件。该诊断同样需要开发机编译器，不加入默认test-all。


## Git 读取等待（2026-10-28 后续批）

Git status/diff及其repo探针已改为异步受管execFile，各工具共用30秒命令预算与1MiB输出上限；调用方取消主动STOP并等回调结算，迟到成功拒绝，非仓库/缺Git/ACL错误仍区分。读取期间可处理HTTP请求，任务整体截止和回收等待仍不是native IO硬中断保证。

**剩余跨阶段阻塞**：HTTP和CLI请求开始前的createTaskGitCheckpoint仍用同步Git；提交/快照/保留策略、worktree和发现也仍可能阻塞。新读取专项在模型fixture响应（检查点之后）才启用私有fsmonitor/diff驱动，准确验证工具等待，不把它写成整条HTTP请求已无同步阻塞。首次将fsmonitor提前配置时，检查点阶段实际阻塞并使health超时，这个现场路径保持开放。

新专项5个确定性预算/取消断言＋12个真实HTTP/Git断言分段通过；status列9、前置依赖12、实际Git/提交8各一次，合计46个有效检查。真实驱动等待时HTTP可读，断开后端口/心跳、owner/tool归零，逐callId审计cancelled且不重放，同Agent下一读取成功。未重跑native owner/创建窗口/其它旧专项、完整A–J/UI/test-all或Win7/24–72h。


## 请求前检查点等待（2026-10-28 再后续批）

createTaskGitCheckpoint现为异步，CLI和两种HTTP入口都await并在模型开始前复核取消。repo探针、stash create、自有ref发布和保留共用30秒命令预算/1MiB输出，主动取消会等回调结算；确认bound但清理未知直接中止请求，不当可忽略快照失败后继续模型。普通非仓库仍静默；其它非致命检查点失败保留阶段警告。已发布ref不会因取消补偿删除，取消后不继续prune。

同步commit快照和异步task检查点驱动同一个generator命令计划；归属/namespace/50条保留、CAS/--no-deref、时间回拨/多worktree策略未复制或改变。runner只新增只读ownedTree getter用于明确区分清理未知。

本批首跑：新checkpoint-cancellation19/19（含6个边界、两种HTTP各5、CLI3）、旧Git快照11/11、实际Git/提交8/8、审计提交预算13/13，共51。真实fsmonitor在首个模型前暂停时HTTP可响应，取消后模型零调用/无新ref，CLI自身期限也能停止；正常后续快照保留working/index而不改HEAD/原文件。没有重复上批Git读17/状态列/依赖或native/桌面专项和全套，也未做Win7/系统关闭/24–72h。之前请求前检查点的同步阻塞代码已修；提交、worktree和发现等待及native IO仍开放。


## Git 提交异步等待与副作用（2026-10-28）

Git提交的repo探针、恢复快照、stage、staged检查、commit、最后log现均异步受管，整次命令预算120秒、单命令最多30秒/1MiB并服从调用方截止。与读取/检查点共享runGitCommandAsync，绑定后清理未知不继续。取消、native退出、超量/预算到期与迟到成功都不被包装成提交成功。

错误/取消结果携带phase、snapshot、sideEffectsPossible及可见的短快照ID。stage/钩子/commit可能已执行时提示检查status/log；提交后log失败仍为error，不自动重试或回滚真实提交。保留快照及钩子副作用，不自动删除Git锁；后续状态检查可用不代表下一次提交一定成功，可能需要现场核查锁/钩子。

同步Git传输/probe和无生产调用方的同步快照包装已移除，原归属generator策略由唯一异步驱动消费。共享传输和快照消费者有实质变化，本批各一次验证：新提交21、检查点19、读取17、快照11、状态列9、依赖12、审计提示13、实际Git8，共110；无失败复跑。前后hook均真实私有Git：pre取消HEAD不变，post取消HEAD已变化，均保持恢复ref、逐callId取消审计/无重放、端口心跳清理、HTTP响应与后续status。实际快照保留测试改为异步驱动，测试内Git命令仍是同步fixture，不冒充其本身验证Agent调度。

未重复native/创建窗口/桌面套件或完整A–J/UI/test-all；未做Win7/系统关闭/24–72h。worktree、where/bash发现、显式外部PID工具以及native IO仍有同步等待，T22-06继续开放。收尾仅更新deadline/测试说明及fixture提交标题，静态检查，未因此重复已通过专项。


## Worktree 创建（2026-10-28）

enter_worktree_tool改为异步受管Git argv `worktree add -- <relative path>`，保持60秒预算并服从调用方截止；共享传输只在明确传入时采用60秒，原Git默认30秒不变。中文/空格/%变量样式/&路径按字面值，不再经过cmd展开。取消/未知保留目录与Git元数据，结果提示检查worktree list/目标后再决定，避免删掉已执行钩子写入。

原“Entered”描述不符合真实行为，现明确创建worktree但活跃工作区不变，后续路径需带worktree前缀；没有调用process.chdir改变全局工作区/租约。新15与旧E单场景1/J单场景2首次单次通过，共18；实际post-checkout钩子挂起期间HTTP可响应，取消后进程归零，目录/文件/登记保留，之后仍读主工作区。E/J外层强制私有空global Git/禁system配置，未碰用户全局配置。未重复上一批110或其它native/桌面/全套测试；Win7/旧Git版本、系统关闭、长期运行仍待实测。


## 用户指定外部 PID（2026-10-28）

process_kill_tool仍是用户指定PID的外部操作，不获得task/cron的稳定句柄身份保证。新增严格十进制整值校验（2–2147483647），不把123oops/123.5截成123。Windows固定SystemRoot/System32/taskkill.exe，异步argv `/PID n /T /F`，30秒/64KiB与调用方取消；缺SystemRoot在启动前失败，不走工作区/PATH同名程序。非零退出使用稳定的数字/错误码诊断，不依赖Win7本地化stderr的UTF8解码。

Windows成功仅表明taskkill命令完成，POSIX仅表明SIGTERM已发送；targetState始终unverified，不冒充目标/后代均退出。取消/错误注明目标可能已停止，应核对身份/状态后再决定，不自动重放。实际是否忽略信号、PID复用和外部目标生命周期仍非本Job所有权范围。

新专项17/17首次单次通过：9个VM边界＋8个实际隔离HTTP/受管Node替身。只在私有Agent替换唯一taskkill spec，未执行真实taskkill或POSIX信号；验证路径/argv/严格PID、错误码、迟到取消、未知归属、响应/审计/不重放/恢复和乱码字节不冒充成功。旧E kill-real和旧B含任意外部PID场景未运行，实际Win7 taskkill/权限/本地化输出与目标终止仍须受控实机验证。未重复无关Git/native/桌面或全套测试。
