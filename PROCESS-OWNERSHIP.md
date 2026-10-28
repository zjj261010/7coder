# Windows 进程所有权与验收边界

2026-10-28：v2 已接管异步命令、task、cron、MCP、持久 Bash、debug、截图/桌面输入及同步 Git/发现。创建者先加入严格 Job，目标从出生继承；创建窗口受保护回归通过，Win7 实机/宿主约束与长期运行仍未验收。

## 运行物料

- `lib/process-owner.js` 保留 ChildProcess/execFile 接口；`native/process-owner.exe` 为预编译 AnyCPU/CLR2 程序，通过 P/Invoke 调用 Win32，不需要目标机编译器或新增 VC Runtime。
- `.exe.config` 优先 CLR2，允许已有 CLR4。**不下载或启用 .NET**；目标机缺少可用 CLR 时，命令功能不可交付。运行时与 .NET 开发环境不同。
- `.json` 绑定 exe、`.cs`、CLR 配置和应用 manifest 的 SHA256。源文件/配置修改后必须重建，不能留下旧二进制。`.gitattributes` 固定这些文本为 LF，避免 Windows checkout 改变散列。
- 开发机执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-process-owner.ps1` 重建，需要 .NET 3.5 编译器及 CLR2 System.dll。该步骤不在目标机启动链路内；未实测 Win7 PS2 编译。

首次托管启动前检查物料，缺失/损坏明确拒绝，不回退到无归属启动。`/api/info.processOwner` 显示物料状态、活动/待握手数及错误；物料有效不等于 CLR/目标程序已验收。最多 128 个活动托管程序；CLR 和目标程序的内存不由计数保证，Win7 仍需实测并发内存。

## 生命周期

1. 内部broker以detached=true跳过Node13 libuv自动child Job，但保留进程/stdio引用、不unref、不请求CREATE_BREAKAWAY_FROM_JOB；实际宿主Job仍可能继承，用户目标的detached/IPC仍拒绝。Node13 execFile不透传该标志，回调通过受限spawn采集器实现；spawnSync传同一内部标志。每个Agent懒启动一个Node13内置worker_threads控制线程（最多5秒启动/注册等待），独立维护随机命名管道，避免主线程同步调用阻塞握手/ACK。每次启动另有nonce；异步路径先复核ChildProcess PID，才允许运行。同步路径返回前没有PID，以注册nonce授权，返回后必须复核对端PID与spawnSync返回PID相同，才接受成功。控制消息不混入标准输入输出。
2. 创建不允许 breakaway 的匿名 Job，设置 `KILL_ON_JOB_CLOSE`，**先把 broker 自身加入 Job**。Job 句柄不继承、不复制给其它进程；Win7 宿主已有不兼容 Job 时，在任何用户目标出现前拒绝。
3. 用 `CREATE_SUSPENDED` 创建目标，目标从出生继承同一个严格 Job；查询归属成功才报告 READY，收到 GO 才恢复。不再存在“用户目标已创建、尚待首次 Assign”这一步。
4. STOP/根目标自然退出后，broker 查询当前内核 Job 成员（最多4096个，超过明确失败），打开稳定句柄并再次验证属于本 Job 后终止其它成员。最多5秒清理，反复查询直到成员表仅有 broker 且活动数为1；**不是外部 PID 树或旧 PID 扫描**。查询/权限/预算/期限失败不报告成功，OS进程退出关闭唯一Job句柄兜底，结果仍标记未知。
5. v2发送 `TARGETS_EMPTY`/`STOPPED_EMPTY` 和根退出码，表示**目标组为空、broker仍待退出**；收到ACK或最多等2秒后正常退出，由OS关闭唯一Job句柄，保留选定退出码。`ownedTree.closed`是该目标组证明，完成操作还须ChildProcess close；不能把它解释为收到证明当刻整个Job已零成员。诊断暴露mode=windows-job-v2及proofScope=targets-empty-before-broker-close，旧协议物料明确拒绝。
6. broker强制死亡关闭唯一Job句柄，内核处理包含未恢复目标在内的本Job成员；Agent死亡导致管道EOF，broker停止并退出。没有收到目标组证明的意外关闭保持清理未知，不因内核兜底已请求就冒称完成。长期后台命令仍应保持根目标存活，自然退出也清理后代。

控制管道采用 overlapped IO；缓冲区、OVERLAPPED 和事件保持固定 native 地址直到完成。内核/驱动异常仍可能使停止结果未知，不承诺系统调用有硬时间上限。普通命令成功回调要求目标组空证明及 broker close；未结算停止/stdio 现在有软件未知终态和全局隔离，详见[现场恢复说明](PROCESS-RECOVERY-RUNBOOK.md)。debug 的未启动/清理未知不进入自动修复；cron 清理未知会禁用后续自动触发并保留原因。MCP/shell 已执行副作用仍需查验，不自动重放。

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


## Bash 发现与缓存（2026-10-28）

Windows发现改由受管的随包Node子进程运行lib/bash-discovery.js，扫描和Git布局/环境前缀探测不占Agent主事件循环。协议为最多64KiB UTF8 JSON，不调用where，不解析系统代码页输出；最多1024次探测、PATH 32KiB/256项。先试已知安装目录与显式PATH（支持外层引号和%变量样式），再跨盘；不扫描出无关映射盘后才检查已经可用的PATH。

主线程findBash仅读缓存；持久shell同步工厂保持原子创建，缓存未准备时在工具入口await发现后再次取工厂，两个等待者不会各建一个shell。stateless/debug同样await；已发现Git usr解释器和环境前缀直接用缓存，避免再主线程探测布局。正缓存60秒/负缓存10秒，时间回拨立即失效；失败、取消、格式错误、不完整扫描或归属未知不写缓存，迟到负结果不覆盖并发成功。

本批首次各一次：新发现18、管道37、shell期限8、debug依赖10、native集成14、作用域17，共104，无skip/失败复跑。发现暂停用私有helper替身，取消后以原模块真正发现Git Bash并执行UTF8输出；其它专项实际Bash/MCP/debug/归属路径保持。测试清理BASH_ENV/ENV/CDPATH/SHELLOPTS/BASHOPTS/BASH_FUNC_*，不自动加载用户shell启动脚本。

lib目录已有打包/隔离复制覆盖新文件；INSTALL修正v2 probe和依赖说明，packer补入其引用的所有权/创建计划文档，仅静态检查未生成ZIP。新helper增加冷发现时的Node内存/启动成本，Win7需实测。

**边界**：index.js已无execSync/execFileSync/spawnSync调用，不代表同步fs/native API可硬中断。子进程若卡在无法及时终止的驱动IO，仍可能无法取得关闭证明/回调结算；此类未知终态对全局后续请求的隔离、文件操作副作用与Win7关机/再启动需下一独立阶段处理。现代Node替身可终止不证明真实Win7驱动可终止，T22-06/07与发布门槛继续开放。


## Node13 libuv Job 复核修正（2026-10-28）

**INC-JOB-03 / High，兼容性逻辑已确认并修复，Win7实机未验收**：libuv1.37将普通spawn子进程显式加入自动child Job；v2 broker再加入严格Job，Win7的单Job规则会使普通Node启动也失败，并非仅特殊服务宿主。现代嵌套掩盖这一回归，早期preexistingJob不能全归因外部宿主。候选包必须包含本节修正，不能单独采用6d46a47至d528e33期间的v2版本。

内部broker跳过uv自动分配，控制管道与进程/stdio引用仍在，目标依旧继承严格Job。Node13 execFile内置源码不传detached，新增lib/process-capture.js，以spawn实现UTF8/Buffer、各自输出上限、单一超时/合法信号；超限/超时/IO错误停止后等close回调，无PID的EMFILE可先结算，超时后exit0也为error。收尾仅兼容null timeout及按所选编码显示有界stderr，静态检查未再跑正向套件。

实际Job对照：普通探针flags15360且不含父Node，detached/新collector探针flags10240且含父Node（真实宿主Job），受管异步/同步目标flags8192，无silent-breakaway且有完成证明。不能把这说成宿主无Job或Win7实测。依据：[libuv1.37源码](https://raw.githubusercontent.com/libuv/libuv/v1.37.0/src/win/process.c)、[Node13同步flags源码](https://raw.githubusercontent.com/nodejs/node/v13.14.0/src/spawn_sync.cc)、[Win7 Assign限制](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。execFile另以随包Node内置源码核对。

本批collector9、手动Job探针6、owner19/sync17/faults21、native集成14、桌面集成14、Git读取17/检查点19/提交21/实际Git8、Bash18、PID仅HTTP8、worktree仅HTTP9，共200个有效检查。探针首跑因夹具C#同名变量CS0136在0断言编译失败，修正后仅未完成探针6/6；其它通过项不重复。启动和全部execFile采集机制实质改变，旧测试不能替代本次；未重跑纯状态/审计/快照策略和全套。真实桌面/系统目标结束仍未执行。

**极早期边界仍开放**：跳过uv Job后，broker在CLR进入Main/连接控制管道前若永久卡死，父Agent退出没有uv自动回收保证，可能有极早期helper残留。普通进入Main有连接期限且用户目标尚不能创建，但不构成CLR加载器硬期限证明。不能据就绪后强杀或Job探针宣称“所有进程从出生均受管”。父Agent仍存活且事件循环可调度时，现有握手期限/停止监督可使它进入未知并隔离；父Agent提前死亡的架构边界未修。T22-07仍开放，不批准无人值守发布。

## 未结算进程的未知终态与隔离（2026-10-28）

正常完成契约保持。停止后8秒/exit后2秒仍无close时，采集器返回EOWNERUNKNOWN及有界部分输出；不发伪造close，不把destroy流当成目标组证明。全局隔离阻断新进程、模型和工具边界，并释放/拒绝HTTP队列；取消不能把未知转换成普通取消后继续工作。未关闭记录仍计数，迟到关闭只退记录，不自动恢复。异步独占写恢复标记，IO超时单独诊断；标记存在则下次启动在配置恢复前拒绝，详见现场手册。

本批还确认debug实际清理出现terminate-member/Win32 5：结束上游进程后另一个Job可同时触发成员终止，TerminateProcess失败与句柄变为信号之间存在时序差。现在保存错误码，5且仍未信号时继续原5秒总预算内的Job成员/活动数复核；不把5直接当成功，其它错误仍失败。持续拒绝依然未知。参见[Microsoft TerminateProcess 文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)。生产CLR2物料已重建绑定，exe SHA256为71ae9983108bc2d140157b3c8d2eb0702456cb442fb61b95e36fbeb78a4001dc。

验证记录与首跑失败/分段续测见ISSUES-LOG.md；没有重新执行整个旧套件，也没有Win7实机、系统注销/关机、24/72h或离线打包。旧章节的“下一阶段处理未知终态”是此前停点；软件隔离已落地，硬IO/父死亡/持久化失败等剩余边界仍不能据此关闭。

## 异步命令输出的共享采集预算（2026-10-28）

Windows受管exec/execFile在原有各流maxBuffer之外，共用32MiB输出缓冲分配预算。stdout/stderr均计入；16KiB独占块合并小片段，不对每个单字节write保留单独Buffer/数组成员，也不以slice保留较大输入的底层存储。诊断processOwner.outputCapture区分allocatedBytes、retainedBytes、blocks、active，快照不能修改预算。

已有命令输出导致超限时仅停止该命令，ERR_PROCESS_OUTPUT_BUDGET明确说明它可能已执行，仍等close/证明或进入既有未知终态；不提前归零、不自动重放。已完全占满时，新采集命令在实际spawn前拒绝，提示request not started。其它在运行的命令保留自己的缓冲；容量归还后可以继续。停止请求本身不释放存储，正常/错误close或明确未知回调结算才释放，迟到事件幂等。

预算只覆盖未结算采集器拥有的缓冲块，不包括返回给调用方的stdout/stderr、拼接/解码瞬时副本、spawn流式MCP/Bash、同步调用、模型/页面/内核缓冲，不能说Agent总RSS受32MiB限制。T22-15整体仍开放。新单元16、实际原生集成9、受影响collector9/恢复23/故障21本批各首跑一次，共78项通过，无失败复跑；native物料未改。没有全套、Win7/长稳或重新打包。

## MCP 启动查找与参数语义（2026-10-28）

MCP裸命令按实际child cwd/PATH寻找首个可用候选：普通exe/com直接传argv，只有batch shim才走既有cmd回退。找到本地候选即停止，不为后续PATH网络目录继续探测；同目录原生文件优先于shim。显式路径和bundled Node特例保持，不恢复“绝对路径.cmd必然启动失败”断言。

cfg.env在Windows按不区分大小写覆盖父变量，查找与实际spawn共用同一份合并环境；POSIX保留区分大小写。相对PATH条目在shim发现和native实际可执行文件解析两侧，都相对于实际child cwd，不再偶然使用Agent主工作区。原生可执行文件的空格/中文/引号/百分号/管道样式参数由CreateProcess argv处理，不经cmd重新解释。

batch shim仍使用用户配置的既有shell语义，本批不宣称其任意参数已全部字面化，也不改变Windows批处理文件正文编码；常见离线shim可用ASCII正文、%~dp0扩展Unicode路径。PATH文件探测仍是同步IO，网络盘/驱动卡死不由本批解决；不能据查找到解释器就承诺版本支持Win7。

验证与夹具失败后仅尾段续测见ISSUES-LOG.md。真实原生解释器用隔离复制的随包Node代替Python，真实batch也是本地受管夹具；未运行npx下载、未安装Python/编译器、未修改父进程真实PATH或用户配置，native物料保持不变。Win7/真实第三方MCP/PS2及长稳仍待验收。

### 显式批处理完整路径

后续实测发现：当前托管路径的隐式批处理回退会错误解释带空格和&的完整文件名，返回1且目标脚本未执行，虽然Job目标组证明存在。这不是“绝对.cmd一概无法启动”或一律193；裸shim、原生可执行文件和不同运行时不能混为同一个断言。

MCP显式.cmd/.bat（含显式相对路径）现构造独立cmd.exe `/d /v:off /s /c`启动，文件路径解析到实际child cwd，路径和支持的参数分别引用，windowsVerbatimArguments保留构造的命令行；仍经严格Job拥有解释器与目标。只接受有效环境中绝对cmd.exe（ComSpec或SystemRoot回退）。百分号会在引号内展开，内嵌引号/换行/NUL也不能对任意batch转发可靠表示，因此这些路径/参数启动前明确拒绝；可改用原生解释器或自备ASCII包装。不能说任意batch内部处理都会保持参数不变。

当前现代主机实际MCP专项7项通过：Unicode/空格/&路径、支持参数、延迟展开关闭、相对路径、非法参数零启动、Job关闭与计数归还；没有实际npx下载或真实第三方/Win7矩阵。API背景见[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)，实际行为以隔离运行证据为准。

## CMD 与 UNC 工作目录的部署限制

当前受管cmd/cmd.exe及.cmd/.bat不接受UNC作为cwd，包括斜杠写法和扩展UNC命名空间；相对cwd先按实际父目录解析。此为避免命令解释器使用其它目录执行相对写入的止损限制，EUNC_CWD在查找共享文件/控制注册/进程创建前拒绝，明确No process was started，且不隔离整个Agent。原生非cmd程序不被此规则一并禁止，但它们各自的UNC兼容性仍须验证。

cmd任务应使用已验证的本地或盘符工作目录；不会自动改注册表、建立共享、分配映射盘或通过pushd改变全局部署条件。盘符形式不代表映射盘在当前账户/提权会话一定可见。Microsoft说明[pushd对网络路径会创建临时盘符](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/pushd)，本项目未自动引入该行为。

cmd-unc-cwd专项13项仅验证词法识别、各同步/异步入口零启动、无共享探测、原生入口不被误封和计数/错误终态。UNC文件探测由夹具强制阻断，未访问真实SMB/共享，更不是Win7网络盘认证。真实共享、断连、权限、不同账户和关机仍保持待验收，不从这些局部检查推断真实机器上必然发生目录回退。

## MCP 方法与初始化的状态边界

JSON-RPC分派只证明收到对应消息；tools/call还检查对象/content数组/isError布尔及基本块类型，合法空content[]仍为成功，缺失/畸形结果不会成为空成功。格式化最多4096块和4MiB，非文本复用64层/10万值/转义字节预检，保留正常扩展块的compact JSON；不完整结果明确失败且提示检查副作用，不自动重放。

initialize在initialized通知/工具调用前检查对象及已提供元数据；显式协议版本须为支持的2024-11-05。失败连接退役，成功才记录protocolVersion。legacy缺省对象结果仍兼容，但diagnostics版本为null，不等于完整协商；完整能力/第三方版本矩阵仍未验收。半会话停止仍受本文件的pending/unknown/Job证明规则约束，不能把本地会话退役解释为外部业务副作用回滚。

本批方法结果30项首跑通过；初始化专项先因夹具缺日志接口在0断言失败，修正后仅续测本项20/20，详见ISSUES-LOG.md。无Win7或第三方认证，不关闭T22-07/15整体。

MCP完整响应从输入缓冲移出后，另计交付中128项/16MiB共享额度，deliveryBytes按原始JSON帧UTF-8字节计，不是V8堆大小。初始化校验、工具结果格式化及发现页处理都在消费租约内；发现成功的数据转交既有schema额度，finally才归还原响应额度。结果已交付到Promise后，即使client退役或目标Job关闭，也不提前归还尚在消费的额度。超额仅拒绝对应已发送调用，明确结果不完整/复查副作用，不假称请求未发送或自动重放。

原始request诊断调用返回快照后的外部保留、格式化后文本/工具历史、JSON解析膨胀及全部Agent对象不在这段交付额度内。因此本项仅关闭响应交接缺口，不是总heap有界或长稳验收。无新增轮询/后台回收器；正常/错误/取消均由消费finally释放。

发现页的schema在完整JSON复制前预检：累计缓存1MiB（含分页合并分隔符）、最多64层/每页10万值；UTF8/控制转义与数字规范化按序列化后的字节计量。预检失败MCP_SCHEMA_BUDGET，不沿用模型请求的requestNotSent字段，因为tools/list已经发送；不发布部分列表、不自动重试。取消/进程归属错误保持原控制终态。复杂但合法的第三方schema若超过结构额度也会明确拒绝，仍需第三方矩阵确认。
