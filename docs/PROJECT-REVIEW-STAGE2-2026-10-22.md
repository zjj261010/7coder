# 7coder 独立第二阶段复核：增量发现与结论修正

日期：2026-10-22（北京时间）  
基线：`6a1e325e44300d95d6557cd855e3d06f356ec2c6`，版本 2.19.0。  
主入口 SHA256：`9BEC3422AF07C05F995CCD31F1120CA5FAABF2A0C3C669C28AF11091B81E5801`，与第一轮相同。

本轮先阅读[第一轮完整报告](D:/ai-workspaces/7coder/docs/PROJECT-REVIEW-2026-10-22.md)，再独立追踪实际源码。本文只记录增量发现与修正，不替代第一轮完整报告；未修改产品源码、启动配置或现行测试。

**结论：新增 3 项已确认的 High 故障路径、1 项 High 高可信长期运行风险，以及 2 项 Medium 功能缺陷。未确认新的 Critical。原报告关于绝对路径 `.cmd` 必然不能启动的判断需要撤回；取消故障的影响需要补强。当前仍不适合直接作为 Win7 无人值守长期运行版本发布。**

“已确认”指明确代码路径或本轮隔离实验成立，不表示已在 Win7 真机发生。严重程度与发生概率、验证层级分开说明。

## 一、新增问题清单

### N01 · High／已确认：并行只读工具争用 readline，任务永久等不到第二个审批结果

**位置与函数**：

- [index.js:628](D:/ai-workspaces/7coder/index.js:628)：`read_file` 标记 `parallelRead: true`。
- [index.js:3557](D:/ai-workspaces/7coder/index.js:3557)：受保护文件读取仍需要进入审批。
- [index.js:3915](D:/ai-workspaces/7coder/index.js:3915)：`processWithTools` 对整批只读工具使用 `Promise.all`。
- [index.js:3702](D:/ai-workspaces/7coder/index.js:3702)：`askApproval` 直接调用同一个 `rl.question`。
- [index.js:5281](D:/ai-workspaces/7coder/index.js:5281)：REPL 任务执行期间持有 `taskRunning`。

**触发条件**：交互式 REPL、default 权限模式；模型在一个 assistant 消息中同时提出两次需要审批的只读调用，例如读取 `.env` 与 `.npmrc`。这不要求 EOF、模型服务故障或恶意输入。

**错误链路**：两个工具并行到达 `askApproval` → 在同一个 readline 上同时注册两个 question → Node13 的 readline 只保留当前问题，第二次 question 不建立第二个回答回调 → 用户回答两次也只能结算一个工具 → `Promise.all` 永远 pending。

**实际后果**：进程仍接收输入，模型下一步却永远不会开始。`taskRunning` 不释放，`/clear`、`/resume` 和下一次执行被拒，通常需要退出重启。第二个 `yes` 还可能被普通 line handler 当作下一任务草稿。此项与原 M10 的“EOF 后问题不结算”不同：stdin 可以一直正常打开。

**本轮证据**：随包 Node13.14，提取原 `processWithTools`、`safeExecuteToolInner`、`askApproval`，使用真实 readline/PassThrough，替换模型与文件读取为无副作用 fixture。观察到：question 调用 2 次；仅 `.env` 对应的模拟读取执行；第二个 `yes` 进入普通 line 事件；当前 readline 已无 question，但工具批次仍未结算，模型调用数停在 1。未读取真实凭据。

**修复建议**：先串行完成权限判定/交互审批，再并行执行已获准的只读操作；或者给 readline 建立单一问题队列。仅在工具内部增加超时会把丢失回调掩盖成随机拒绝，不能解决审批对应关系。

**测试缺口**：[runner-b.js:1066](D:/ai-workspaces/7coder/test/runner-b.js:1066) 的 parallel-tools 使用 bypass 和普通文本文件，完全避开交互审批。应新增两项受保护读取同批请求，断言两次答案分别对应两个调用、批次完成且后续任务可执行。

### N02 · High／已确认：SSE 的合法 JSON、非法结构可直接杀掉整个 Agent

**位置与函数**：[index.js:1927](D:/ai-workspaces/7coder/index.js:1927) `parseSSEStream` 的 data 回调；[index.js:1961](D:/ai-workspaces/7coder/index.js:1961) 无条件访问 `parsed.error`；[index.js:1981](D:/ai-workspaces/7coder/index.js:1981) 无类型检查遍历 `delta.tool_calls`。

**触发条件**：本地模型服务、协议适配层或异常响应产生 `data: null`；其他结构错误也可能触发，例如 `delta.tool_calls` 是对象而非数组。这些帧不符合 Chat Completions 数据结构，但都可能通过 JSON.parse。不能将其称为“正常协议帧”，也没有证据表明正常模型普遍发送它们。

**错误链路**：JSON.parse 成功 → 回调继续访问 null 的属性／遍历非 iterable → 同步异常从 stream 的 data 事件处理器逃出。该回调在 Promise executor 返回之后执行，外围 `await parseSSEStream(...)` 的 catch 不会自动捕获它；注册 stream error 监听也不等于捕获 data 回调自身抛出的异常。

**实际后果**：故障从“本次任务返回上游错误”升级为“整个 Node 进程退出”，所有 HTTP 对话、定时任务与内存状态中断。再叠加原 H04 的进程清理缺口，可能遗留已启动命令。这里不把孤儿后果声称为本轮已复现。

**本轮证据**：在独立 Node13.14 子进程执行原解析函数，通过真实 PassThrough 异步送入 `data: null`。子进程 exit=1，stderr 为 `TypeError: Cannot read property 'error' of null`；已注册的 Promise catch 没有执行。实验验证了解析边界，未启动完整产品 HTTP 服务。

**修复建议**：验证 parsed/choices/delta/tool_calls 的结构；data/end 回调内部捕获异常并进入同一个失败结算与 stream 清理入口。错误仅结束当前请求，且只能结算一次。

**测试缺口**：[chaos-mock.js:42](D:/ai-workspaces/7coder/test/chaos-mock.js:42) 的 malformed 测的是无效 JSON；chaos-sse 同样偏重 JSON 语法损坏。[runner-b.js:2400](D:/ai-workspaces/7coder/test/runner-b.js:2400) 验证 EOF/DONE，却没有“JSON 成功解析、结构错误”的边界。新增反例必须断言服务进程仍活着、下一正常请求成功，不能只要求故障请求失败。

### N03 · High／已确认：压缩摘要失败仍删除原历史；成功摘要也只看被删除区的前 20,000 字符

**位置与函数**：

- [index.js:3802](D:/ai-workspaces/7coder/index.js:3802) `summarizeConversation`，3807 将待总结文本直接截成前 20,000 字符。
- [index.js:3813](D:/ai-workspaces/7coder/index.js:3813)：空摘要或异常返回普通字符串 `(summary unavailable...)`。
- [index.js:3869](D:/ai-workspaces/7coder/index.js:3869)：`compressConversationIfNeeded` 无成功状态校验。
- [index.js:3874](D:/ai-workspaces/7coder/index.js:3874)：照常 splice 删除整个 oldPart；下一轮继续模型与工具执行。

**触发条件**：长任务或长期 REPL 达到上下文压缩阈值，轻模型暂时不可达、返回空内容，或待压缩区本身超过 20,000 字符。与原 H09 不同，即便模型配置完全正确，也会在普通临时故障下触发。

**两个独立的丢失路径**：

1. 摘要调用失败时，以“摘要不可用”的错误说明替换整段原始用户要求、决策和工具结果。恢复服务后，当前内存对话已没有被删除内容。
2. 摘要调用成功时，模型只收到 oldPart 的前 20,000 字符，然而程序删除整个 oldPart。后半段的较新约束和已完成副作用从未交给摘要模型；它无法总结没见过的内容。

**实际后果**：Agent 表面继续正常回答/执行，却可能忘记“不得修改数据库”等任务边界，或者重复已经完成的操作。代码层面确认的是上下文不可逆丢失；后续具体误操作取决于模型和剩余上下文，本轮没有让模型修改任何文件。REPL 随后的 saveSession 还可能把已经丢失信息的压缩对话存盘。HTTP 每次重新接收浏览器历史，因此不能声称所有 HTTP 历史也永久消失，但本次工具循环仍使用损坏后的上下文。

**本轮证据**：原压缩函数遇到受控摘要异常后，测试约束 `CONSTRAINT_DO_NOT_TOUCH_DATABASE` 消失，原用户内容被 `(summary unavailable: fixture summary unavailable)` 替换；另对原 summarizeConversation 投入超过 21,000 字符的历史，末尾较新约束没有进入摘要请求。

**修复建议**：摘要结果必须区分成功和失败；失败时保留原数据，暂停/明确失败，或使用可证明保留关键约束的本地降级。截断输入时只能删除确实被摘要覆盖的区间，或分段摘要；活跃任务目标、硬约束、待办和已执行副作用应单独保留。不能用扩大模型上下文替代失败保护。

**测试缺口**：[runner-f.js:177](D:/ai-workspaces/7coder/test/runner-f.js:177)、[runner-i.js:104](D:/ai-workspaces/7coder/test/runner-i.js:104) 主要断言出现压缩标记、体积受限、简单 role 配对与最后返回字符串。它们不能证明用户约束仍在。优先新增“摘要失败不修改原数组”“被删除区末尾的关键约束保留”“恢复后不重复已完成副作用”。

### N04 · High／高可信风险：非流式摘要 Promise 链没有容量限制，后台可长期积压历史请求

**位置与函数**：[index.js:4316](D:/ai-workspaces/7coder/index.js:4316) 全局 summaryChain；[index.js:4934](D:/ai-workspaces/7coder/index.js:4934) 非流式任务释放请求门；[index.js:4942](D:/ai-workspaces/7coder/index.js:4942) 每次回复继续追加摘要闭包。另见 [index.js:489](D:/ai-workspaces/7coder/index.js:489) 无容量限制的 requestGate。

**触发条件**：通过非流式 API 持续提交任务，主模型正常且较快，独立轻模型/摘要服务很慢或暂时失效；回复达到需要摘要的长度。用户可为辅助模型配置单独端点，因此主请求快、摘要慢是实际可出现的部署形态。

**原因与后果**：summaryChain 仅保证串行执行，未限制待处理数量、总字节、队龄或过时任务。每个尚未执行的 `.then(() => summarizeAction(rawPrompt, result))` 至少持有该次 rawPrompt/result。只要生产速度长期超过摘要消耗速度，内存积压就持续增加；服务仍能返回主请求成功。后端恢复后还会补做大量已经过时的摘要。所有聊天请求在 requestGate 外也没有排队准入上限，取消的排队请求须等前项释放才会走到取消检查。

这是原 H06 的“大输出采集”之外的新保留来源：即使每个工具输出都限长，队列项数量仍无上界。原 M01 建议把流式摘要搬到后台，**若直接复用此无界链，会扩大触发范围**。

**证据边界**：队列无界及闭包保留由源码确认；未做 OOM/数周压测，不报告已观测内存泄漏曲线，也不声称每次正常任务必定积压。

**修复建议**：摘要作为非关键工作，采用有容量/字节预算和过期策略的显式队列；按会话合并最新需要、限制重试和总截止时间。聊天执行队列也应设容量并及时移除取消项。增加 queued/oldest-age 等诊断，不需要引入复杂调度框架。

**建议验证**：慢摘要端点＋快速主模型，连续提交有限数量任务，断言队列和内存受预算限制、主任务不被摘要淹没、服务恢复后不无期限补历史账。

### N05 · Medium／已确认：工作流审批没有展示被批准的步骤，却让所有内部步骤继承批准

**位置与函数**：[index.js:408](D:/ai-workspaces/7coder/index.js:408) `sanitizeAuditArgs`；[index.js:832](D:/ai-workspaces/7coder/index.js:832) workflow 的 explain 只显示步骤数；[index.js:3676](D:/ai-workspaces/7coder/index.js:3676) 跳过内部审批；[index.js:4902](D:/ai-workspaces/7coder/index.js:4902) SSE 参数展示；[webui.html:827](D:/ai-workspaces/7coder/webui.html:827) 审批框。

**触发条件**：default 模式下批准包含命令或文件修改的 workflow。

**实际缺陷**：网页 tool_call 经 sanitizeAuditArgs 后，嵌套的 steps 数组变成 `[object Object],[object Object]`；审批请求仅为 `Execute workflow_tool?`。CLI 也主要显示“Run a N-step tool workflow”。用户看不到计划中每条命令、目标路径和内容，却一次批准后执行所有内部步骤。内层工具没有独立 SSE onToolCall 回调来补齐操作预览。

本轮原函数实验确认 steps 被字符串化成上述内容；继承审批路径为静态确认。模型有时自行解释计划不能替代程序对真实工具参数的展示。此问题不是“完全绕过权限”：denial/deny/危险命令等硬检查仍会执行，所以保守评级为 Medium，但 default 模式交付应修复。

**建议**：保留嵌套参数结构并按字段递归脱敏，审批前展示确定的步骤列表和真实参数；无法完整展示时不要默认为整批批准。验证页面中能看到每步实际 command/path，批准内容与执行内容一致。

### N06 · Medium／已确认：HTTP 选择的模型不传给子代理，任务中途切回全局主模型

**位置与函数**：[index.js:4822](D:/ai-workspaces/7coder/index.js:4822) 获取客户端 reqModel；[index.js:3885](D:/ai-workspaces/7coder/index.js:3885) 主循环使用 opts.model；[index.js:523](D:/ai-workspaces/7coder/index.js:523) 子代理只传 cancel。

**触发条件**：网页/API 为本次任务选择模型 B，HEAVY_MODEL 仍为 A；任务调用 agent_tool。特别是 B 的本地 profile 可用，而 A 的旧端点在离线环境不可达。

**后果**：主循环用 B，子代理重新回落到 A；可表现为主聊天正常、委派步骤失败或长时间等待。原 M05 又把子代理失败包装为 ok，组合后更难发现。本问题不需要修改设置或触发 H09 的轻模型 fallback。

**证据边界**：调用参数和默认值已确认；未新增真实双模型端到端实验。若产品有意使用独立代理模型，应显式配置和展示，而不是在用户选择 B 后隐式访问 A。

**建议**：请求上下文传递已选模型，或明确建立独立 agent model 配置；测试同时记录主调用与子调用的 model/endpoint，而不只断言最终回复包含某个字符串。

## 二、需要修正或补强的第一轮结论

### C01：撤回 M07 中“绝对路径 .cmd 无法直接启动”的泛化结论

原 M07 根据通用子进程说明认定 `C:\...\server.cmd` 在 shell:false 下无法启动。**本轮随包 Node13.14 在当前 Windows 宿主上使用绝对路径 spawn `.cmd`、shell:false，exit=0，输出 `BATCH_STARTED`。** 因而不能把这项当作目标 Node13 的已确认兼容性 Bug。

Node 官方在 2024 年安全更新中特别说明，较新版运行时才新增对这类 spawn/spawnSync 调用的 EINVAL 拒绝，支持了必须按版本区分的判断。参见 [Node 官方 2024-04-10 说明](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)。本轮没有用现代 Node 的结果推翻或证明 Win7 实机行为。

更准确的结论是：该调用在已测试 Node13/Windows 组合能启动；Win7 实机、带空格与特殊字符参数、现代 Node fallback 仍须分别验收。不能因为简单启动成功就认定批处理参数转义可靠。M07 其余管道异常、缓存身份竞争等问题不因这一修正自动撤销。

### C02：H03 应补充“取消后仍可开始新副作用”，不只是旧模型占队列

**位置**：[index.js:4845](D:/ai-workspaces/7coder/index.js:4845) 断连只设置 clientGone；approvalBridge.dispose 在 finally 才执行；[index.js:3679](D:/ai-workspaces/7coder/index.js:3679) 等待批准后直接进入 executeToolRaw；auto 审批等待后也没有执行边界取消复核。

在等待批准期间停止请求，pending approval 没有立即撤销。旧审批按钮、已经在路上的批准，或迟到的自动审批 verdict 仍可放行；检查取消是在此前的工具边界，实际写入/启动前没有再次检查。

本轮提取原 safeExecuteToolInner，令 cancellation 先变 true，再让审批返回 true，**模拟副作用仍执行 1 次**。实验没有运行真实命令；证明的是执行分支仍被进入。

H03 保持 High，但修复验收必须包括“取消后的审批不能触发新写入/新进程”。仅给 axios 加 CancelToken 不足以关闭此路径。断连时应及时结算/撤销审批，执行前再复核取消状态。

### C03：M07 的未处理 stdin error 建议提高为 High 风险，启动兼容与管道故障分开登记

[index.js:347](D:/ai-workspaces/7coder/index.js:347) MCP stdin.write、[index.js:1404](D:/ai-workspaces/7coder/index.js:1404) 持久 shell stdin.write 仅用同步 try/catch；没有给对应 Writable 安装 error handler。若子进程关闭输入或在写入时退出并触发异步 EPIPE/ERR_STREAM_DESTROYED，可能终止整个 Agent。

这符合用户定义的 High（重要服务整体失效），不宜因为它归在“MCP 恢复缺口”里就统一定为 Medium。**本轮未注入真实管道 EPIPE，因此保留“高可信风险”，不改为已实机复现。** 修复需包括stdin error、请求结算、child身份和重建的一致处理，而不只是扩大同步 catch。

### C04：修正 Critical 判定口径，但不据此强行升档

第一轮 Executive Summary 中“未发现足够证据认定为所有部署都会触发的 Critical”设了过高门槛。用户定义的 Critical 不要求所有部署普遍触发；条件性严重数据破坏或不可恢复故障也可能达到 Critical。

本轮仍未确认应新增为 Critical 的问题：上述进程崩溃/挂起与约束丢失按触发条件、可恢复性和已知影响定为 High。修改判定措辞不意味着把所有 High 重新标 Critical。

### C05：明确原验证记录的边界

第一轮的 Node13 `--help` 在执行 dotenv 配置逻辑前退出，单独不能证明 dotenv 初始化兼容；它确实会加载文件顶部的 axios。第一轮另有实际 HTTP 探针，不能因此否定全部依赖可加载的证据，但应避免把 `--help` 的证明范围写大。

原 H01 的 PS2/CLR2 启动器问题、H02 的浏览器交付条件，仍有代码依据；本轮没有新增另一个已确认的 Win7 系统 API 阻断点。没有因 Node13 老旧就直接判定整项目不兼容。

## 三、尚未解决的重大疑点

1. **真正 Win7 上的运行时与命令边界**：本轮运行的是随包 Node13，宿主不是 Win7。默认 PS2/CLR2、浏览器版本、VC/DLL/补丁、CP936、特殊字符路径和网络盘没有实机验证。`.cmd` 修正只能覆盖本次运行时/宿主组合。
2. **流异常后连接是否统一回收**：N02 已确认异常能逃出回调；原报告关于 reject 后未销毁 stream、close-only 是否永久 pending 的疑点，仍需真实 axios/HTTP 故障注入。不能把 N02 的实验当成这些边界已经全部验证。
3. **MCP／持久 shell 管道关闭与对象替换竞态**：除了 C03，旧 child 退出后删除新缓存对象的竞争仍应验证；未确认现场频率。
4. **auto_debug 再入**：[index.js:3428](D:/ai-workspaces/7coder/index.js:3428) 的 fixer 再次拿到完整 tools，未传原请求取消／审批上下文，也没有禁止再次调用 auto_debug_tool；系统提示又鼓励对启动程序使用 auto_debug。可能形成比单层 maxFix 更长的嵌套执行。当前没有证明正常模型会触发无限递归，故只列重大疑点，不报确定性“无限循环”。
5. **长时间内存与重启恢复**：N04 队列积压、原 H06 输出采集、H04 孤儿进程、H10 非原子状态写之间的组合风险未做 24/72h 与强杀重启验收。不能以简单任务成功或 RSS 短测宣称数周稳定。

## 四、本轮实际验证与覆盖边界

### 已完成

- 阅读第一轮完整报告并对照同一主入口哈希。
- 重点复核主入口的启动/配置、模型 SSE、权限与 readline、工具循环/压缩、工作流/子代理、HTTP 队列/审批、持久 shell/MCP、后台任务/cron、状态与备份/退出；对应页面的发送、审批、保存、恢复和模型选择。
- 重新读取启动器、打包脚本、安装说明及相关测试工装；按新增问题追踪 B/C/F/H/I/J 等相应测试与 chaos mock。未把第一轮“读过测试”的总结作为本轮的覆盖证明。
- **仅执行一次**：`runtime\node.exe .cache\review-stage2-20261022.cjs`，Node v13.14.0，win32；一批 7 个观察点，父探针 exit=0。

| 观察点 | 结果 | 证明范围 |
| --- | --- | --- |
| SSE null 帧 | 解析子进程 exit=1；Promise catch 未执行 | 原解析函数＋真实异步 stream；非完整 HTTP 端到端 |
| 两项并行保护文件审批 | asks=2，执行1，第二答案成为普通 line，批次未结算 | 原工具循环/权限函数＋真实 readline；读操作为 fixture |
| 压缩摘要失败 | 原始限制消失，替换为 summary unavailable | 原压缩函数；摘要故障为 fixture |
| 摘要输入截断 | 21K 前文后的较新约束未进入摘要请求 | 原 summarizeConversation；没有调用真实模型 |
| 绝对路径 cmd | shell:false，exit=0，BATCH_STARTED | 随包 Node13＋当前 Windows 宿主；临时 echo 脚本 |
| 取消后审批放行 | cancel=true 时仍进入模拟执行分支1次 | 原权限函数；未启动真实用户命令 |
| 工作流参数展示 | steps 变成 `[object Object],[object Object]` | 原脱敏函数；页面消费链静态核对 |

这里的“观察成功”是故障路径或反证成立，**不是产品测试全部通过**。没有失败后反复重跑，也没有复用第一轮的同一测试命令。

探针与原始记录：[探针脚本](D:/ai-workspaces/7coder/.cache/review-stage2-20261022.cjs)、[证据 JSON](D:/ai-workspaces/7coder/.cache/review-stage2-20261022-evidence.json)。它们在忽略缓存中；关键结果已完整记录于本文。唯一实际批处理文件位于本轮新建系统临时目录，仅输出固定文本；未读用户密钥、调用真实模型或操作桌面。

### 未完成／不作宣称

没有再次逐行覆盖全部测试和第三方依赖；没有运行原全量 A–J、K/R、页面回归、真实浏览器、Win7 真机、真实双模型、真实 MCP 管道故障、完整后端故障恢复、打包、断电或长期压测。当前范围是高价值调用链复核和一轮最小隔离验证，不能称“所有运行环境与故障组合已全面验证”。

## 五、最终发布风险判断

**维持“暂不作为 Win7 无人值守长期运行版发布”。** 本轮的新增证据说明，第一轮的风险判断方向成立，但修复清单仍不完整。即使先修完原报告五项首要问题，也不能自动认为长任务可靠：N01 会使 REPL 假活，N02 会因单条异常上游数据终止全进程，N03 会让任务在丢失约束后继续执行。

本轮新增项的实际修复顺序：

1. **N02：SSE 异常隔离**，局部边界修复，避免单请求故障扩大为进程退出；同时落实 C03 的管道错误处理。
2. **N03：上下文压缩失败保护和覆盖范围**，长任务能力启用前必须修；不让“压缩成功”的标记掩盖信息丢失。
3. **N01：交互审批串行化**，default REPL 交付前必须修；若临时禁用对应并行路径，应明确限制范围。
4. **C02：取消后的执行边界复核**，并入原 H03 修复，不能只处理中断模型连接。
5. **N04：摘要/任务队列预算**，持续服务验收前完成；修原 M01 时同时处理，避免把阻塞改成无界积压。
6. **N05/N06**：补齐具体工作流审批展示与子代理模型继承，再验收相应功能。

原 H01/H02 的启动与浏览器条件、文件编码/落盘完整性、进程树回收仍是发布门槛；本文不重复展开。修复后先针对这些具体反例做有限回归，再对实际交付 ZIP 做 Win7 默认环境启动、取消/异常/强杀后第二次启动、真实浏览器审批、GBK 文件及 24/72h 稳定性验收。

**本轮结论属于待修审阅结果，产品代码未修改。剩余最大不确定性是 Win7 实机和长期运行，而不是是否已经找到明确故障路径。**
