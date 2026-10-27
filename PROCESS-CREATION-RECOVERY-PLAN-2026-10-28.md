# INC-JOB-02：创建阶段进程归属与恢复计划

日期：2026-10-28。状态：v1缺口已取证，v2代码修复和现代宿主受影响回归已完成；Win7/长期运行发布门槛仍开放。第1节至第7节保存取证与方案阶段事实，当前状态以第8节为准。

## 1. 已取得的证据

生产位置：`native/process-owner.cs`，`Main` 中 `CreateProcessW(CREATE_SUSPENDED)` 后才调用 `AssignProcessToJobObject`（当前 120–122 行）。正常失败会进入 finally，强制终止不会执行 finally。

新增手动诊断 `test/process-owner-creation-window.js` 与 CLR2 夹具 `test/fixtures/creation-guard.cs`。只编译隔离目录中的源码副本，在 Create 成功、Assign 尚未执行处暂停。生产 exe/源码/config/manifest 的绑定散列保持原值。

诊断先把 broker 置于严格的外层 guardian Job，核对 HELLO nonce/PID 后才放行 START。因此目标从出生就受外层保护；没有故意制造无人接管的挂起进程。终止使用所持进程句柄；跨进程复制句柄同时核对 PID 与创建时间，不使用保存 PID 的 taskkill。

实测结果（现代 Windows、随包 Node 13.14、开发机 CLR）：

- 暂停点目标已经存在，且不属于 broker 自己的 Job。
- 强制结束 broker 后，目标稳定句柄仍显示 ALIVE；随后 guardian 清理，Job 活动成员归零，目标退出且执行标记始终不存在。
- 强制结束 guardian，目标与 broker 的稳定句柄均确认退出；目标没有执行。
- 最终证据目录：`C:\Users\zjj\AppData\Local\Temp\7coder-test-6g25r7\creation-window`，包含 broker/guardian 两份 JSON。临时路径供本机追溯，不是安装包依赖。

这确认了“本次 Job 尚未拥有目标，broker 死亡不足以由本 Job 清理目标”的缺口。外层保护改变了运行条件；**没有执行无外层 Job 的遗留实验，也没有证明 Win7 实机已复现挂起残留**。风险等级维持 High，不升级为普遍崩溃或数据损坏。

首跑通过前 2 项，计数断言因额外 conhost.exe 失败；补成员诊断后尾部仍遇到该错误。修为核对真实成员身份、稳定句柄和最终零成员后，失败及未跑尾部 12/12 通过，前 2 项未重跑。不得记录成单次 14/14。

## 2. 必须保持的约束

1. 在任何用户目标出现前建立归属，不能只缩短 Create/Assign 的间隔。
2. 目标执行前保持 START/READY/GO 门控、nonce/PID 校验与取消检查。
3. 不允许 breakaway，不回退到未托管启动；宿主不兼容时必须在目标创建前明确拒绝。
4. 不以心跳超时、PID 文件、启动时扫进程替代内核归属。任何补偿终止都必须持有已验证归属的稳定句柄。
5. 清理未知与已确认完成严格区分；异步和同步调用保持相同语义。测试辅助进程也必须有期限与兜底清理。
6. 原始退出码、stdio/中文参数、stdin EOF、取消/自然退出清后代、128 项准入继续保持。

Win7 不支持嵌套 Job，不能把此次用于安全诊断的“外层 guardian + 内层 broker Job”直接搬进产品。参见 [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 与 [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。较新系统的创建属性不作为 Win7 基线。

## 3. 优先验证的方案：创建者先加入唯一 Job

让 broker 在创建目标之前把自身加入严格 Job；目标通过普通 CreateProcess 继承同一 Job，移除目标创建后的首次归属步骤。Job 句柄不继承、不外泄，仍由 broker 独占；broker 强制死亡时关闭最后句柄，目标从出生就属于清理范围。先用独立原生夹具验证，不直接修改生产物料。

该方案会改变清理协议，不能只添加一行 Assign：

- broker 也在 Job 内，`TerminateJobObject` 会结束 broker 自己，不能再在其后报告“活动数为零”。
- 正常完成时，需只终止 Job 内其它成员，查询并确认只剩 broker；随后报告明确的“目标组已空、broker 待退出”证明，再正常退出。父层仍要等待 broker 句柄 close。
- 成员清理应从内核 Job 成员表取当前成员，打开稳定句柄并再次核对属于同一 Job 后操作；不能退化为外部 PID 树扫描。遇到消失成员/并发创建需重新查询，有限期限后诚实失败并通过最后句柄关闭兜底。
- 清理快照和缓存必须有界；不能用一次枚举或固定“恰好两个进程”断言证明完成，conhost 等系统辅助成员也可能在组内。
- ERROR/控制管道 IO 不应阻止最后兜底；正常退出码、ACK 丢失及 broker 自我退出的实际状态要单独验证。

Job 基本成员列表和统计接口的版本边界参见 [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)。实现前应验证上述协议能在 Win7 单 Job 下成立。若无法可靠保留完成证明，则放弃此方案；不要降格 closed 的含义来让测试通过。

## 4. 备选及暂不采用的路径

外部监督者持有 Job/目标句柄：必须解决监督者、创建者自身启动与 CLR 初始化期间的归属，并避免 Win7 嵌套；重复一层“先 suspended 创建 helper 再 Assign”会把原缺口搬到 helper 上。不能把 guardian 夹具视为已经完成的架构。

整个 Agent 统一 Job：会改变编辑器、目录打开、后台 Agent 的显式外部生命周期，而且失去每次命令独立结束的范围。没有明确隔离协议前不采用。

若最终必须新增纯 native bootstrap，需提供可审计源码、固定 Win7 工具链/API/CRT 和离线二进制散列，不要求目标机装编译器；这是独立工程项，不能在本次验证中顺手引入。

## 5. 实施顺序与验收

1. **机制夹具**：自加入唯一 Job，再创建 suspended 目标；分别在创建前、创建后未恢复、恢复后三代树就绪时强制结束创建者。通过复制稳定句柄确认退出；另验证正常清理只剩创建者、退出码及故障路径。不得依赖外层嵌套 Job 才通过。
2. **生产 native 协议**：先定义新版完成证明、错误阶段、异常兜底；更新源码/manifest 版本与构建物料，一次重建绑定散列。创建者加入 Job 失败时零目标启动。
3. **JS 消费者**：控制 worker、异步 callback、同步返回、停止与诊断共同接纳新版证明；不把 broker EOF 当作目标已清理，不丢失原根退出码，不重放已执行工具。
4. **受影响回归各一次**：进程 owner/同步/故障/真实隔离 Git 与集成/桌面、隔离工装及选择器。仅在机制改变导致旧结果失效时重验；失败先定位，按既有授权仅续测失败或未跑部分。
5. **Win7 发布门槛**：干净 SP1 x64 普通用户、CLR2 与选定 CLR4/缺 CLR、默认 PS2、中文空格路径、真实 Git/Python/MCP、严格宿主 Job/任务计划/服务；Ctrl+C/强杀/窗口关闭/注销/关机与再启动；检查挂起进程、独占文件、端口，以及 24/72h 句柄/内存。无实机条件就保留未验收，不关闭 T22-07。

故障注入还须覆盖 START 前后、READY/GO 前后、成员清理中、证明发送前后、ACK 丢失、控制 worker/Agent 死亡、磁盘/权限/CLR 错误、输出超量和同步超时。每项都区分“未执行”“已执行且清理确认”“结果或清理未知”，并验证下一次启动不会盲目重放。

## 6. 当前交付边界

本文件和手动诊断不改变用户工具行为，不属于漏洞修复提交，不批准无人值守发布。同步操作阻塞 Agent 主线程、native IO 硬中断、外部 broker/WMI 派生和实际 Win7 兼容仍各自开放，不与 INC-JOB-02 混为一个已解决问题。


## 7. 机制原型进展（2026-10-28）

新增手动`npm run diagnostic:self-job`，仍只编译私有夹具，未修改产品物料。首次按“宿主无Job”要求运行，在零断言、零目标创建时被现有宿主Job拒绝。没有绕过宿主限制；原型随后将“已存在外层Job”显式记录并允许现代系统测试自身Job，同时独立模拟Win7单Job政策的提前拒绝。

修正后的专项 **21/21**：创建前/未恢复/三代树运行时强杀、detached叶子归属、控制EOF、Job内成员清理到仅创建者、成员稳定句柄退出、创建者退出码37，以及严格宿主拒绝且零目标。所有正向输出均为`preexistingJob=true`，不是无外层单Job或Win7实测。证据在`C:\Users\zjj\AppData\Local\Temp\7coder-test-ncffh2\self-job\normal-evidence.json`。

原型证明了在当前宿主上“创建者和目标共享自身严格Job”的机制及清理协议可执行。下一步可移植至产品并验证受影响调用方；Win7没有外层Job时的真实运行、Win7外层Job拒绝和CLR/系统关闭仍需实机，不因现代嵌套可用而关闭发布门槛。


## 8. v2 产品落地与剩余门槛（2026-10-28）

已采用第3节创建者先归属的方案，`native/process-owner.cs`在目标创建前自加入Job，目标出生继承且恢复前复核；正常收尾以有界Job成员查询/稳定句柄验证清理其它成员，确认只剩broker，再发送新版目标组空证明。broker的非继承Job句柄由OS退出关闭，正常保留根退出码，强杀也覆盖原创建窗口。

协议2使用HELLO2与TARGETS_EMPTY/STOPPED_EMPTY；JS物料校验和控制worker同时升级，`ownedTree.closed`表示目标组空，外层完成仍等待broker close。`/api/info`明确proofScope，未确认清理仍未知；不是把旧零成员证明改名后直接当成功。CLR2物料已重建并绑定散列，未增加目标环境依赖。

当前v2创建窗口手动回归14/14：在创建后、归属查询前暂停，目标已属于本Job；强杀broker后、guardian清理之前，目标稳定句柄已退出且外层活动数零。证据`C:\Users\zjj\AppData\Local\Temp\7coder-test-edVVr1\creation-window`。另受影响检查112项通过，其中HTTP/内部集成为首3＋失败尾11，其余98各一次。native代码变化使先前v1结果不再足够，因此本次有必要重新验受影响路径；没有重复与本改动无关的已通过套件。

Win7无外层Job、Win7宿主提前拒绝/真实工具、CLR矩阵、系统注销关机与24/72h仍未实测。成员清理遇权限/4096成员预算/5秒期限会明确失败，由进程退出兜底，不能保证所有驱动/内核IO可被硬期限中断。同步调用仍阻塞Agent JS。INC-JOB-02代码修复与现代回归完成，T22-07整体仍未关闭，本文件不是发布批准。


收尾追加私有native清理入口异常注入6/6，验证失败125、阶段诊断、无目标组空证明，但OS关闭唯一Job句柄仍清理已监听的detached叶子及心跳。对应手动`diagnostic:cleanup-failure`，生产物料不改；本批合计132个有效检查。该故障注入不代表真实ACL/内核错误矩阵全部覆盖。
