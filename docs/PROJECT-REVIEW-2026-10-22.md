# 7coder 完整项目工程审阅报告

审阅日期：2026-10-22（北京时间）  
代码基线：`6a1e325e44300d95d6557cd855e3d06f356ec2c6`，声明版本 `2.19.0`  
目标：Windows 7 SP1、离线或封闭内网、低配置机器、长期运行与现场恢复。  
交付性质：审阅与建议；未修改产品源码、配置、现行测试或历史问题状态，未提交、打包或发布。

证据类型：**已确认 Bug**＝代码存在明确错误路径，或本轮隔离实验复现；**高可信风险**＝结构性缺口明确，现场发生频率未实测；**潜在风险**＝依赖特定环境或时序；**Improvement**＝工程改进。严重程度与证据类型分别标注，不把所有风险称为已复现故障。

## 1. Executive Summary

**当前版本不宜直接按“任意 Win7、解压即用、可无人值守长期运行”发布。** 在固定运行环境、配置好本地模型、单用户短任务的条件下，主流程具有可用基础；但启动前提、取消与进程回收、编码保护、运行中配置切换尚未闭环。

项目已有实际工程投入：53 个工具的集中元数据、真实路径检查、逐请求审批桥、HTTP 请求门、工具结果限长、部分结构化失败状态、备份与会话恢复、cron 防重叠、本地 mock 与浏览器回归。这些值得保留。问题主要出在跨模块生命周期，以及测试未覆盖的失败阶段。

最危险的五组问题：

1. **部署启动链不满足 Win7 默认环境**：网页启动器调用 CLR 2 没有的 `String.IsNullOrWhiteSpace`；页面又需要额外部署支持现代 Web API 的浏览器（H01、H02）。
2. **页面停止不等于后端停止**：上游模型调用不接受取消，仍占全局请求门；命令超时/取消只杀 shell 父进程，实际命令可以继续写文件（H03、H04）。
3. **本地文件存在真实破坏路径**：下载替换先删除旧文件；GBK 文件的局部编辑会把未编辑部分按错误编码重写（H07、H08）。
4. **界面配置成功后，Agent 可能半失效**：主模型变了，默认轻模型/摘要模型仍是启动时旧值，换到只支持新模型的本地端点后自动审批持续拒绝（H09）。
5. **长期状态和资源缺乏完整边界**：HTTP 对话共享持久 shell；输出在内存中的保留与显示限长不是一回事；状态文件直接覆盖，缺跨实例协调（H05、H06、H10）。

**Critical：未发现足够证据认定为所有部署都会触发的 Critical。High：存在多项发布阻断条件。长期运行评级：C／需整改后验收；不建议无人值守运行数周。** 这里的评级不是压测得分：本轮没有真实 Win7、72 小时 soak 或断电实验。

如果只允许修五个问题，建议 H01 → H04 → H03 → H09 → H08；同时把浏览器和本地模型作为交付前置条件落实。若明确只处理 UTF-8 项目，可先禁止非 UTF-8 编辑，将第五项换为 H05。完整排序见第 12 节。

### 审阅范围与方法

完整逐段阅读了 `index.js` 全 5,345 行、`webui.html` 全 1,062 行，以及全部现行自有测试、mock、测试基线 fixture、三个 JavaScript 辅助脚本、PowerShell 启动/清理脚本和两个 bat。阅读了 `package.json`、完整 lockfile、`.env.example`、README、INSTALL、LICENSE、gitignore、现行前端设计/验收文档；核对了历史问题账中的相关修复、暂缓决定与当前代码。

历史审阅原文只用于背景和交叉定位，没有把旧行号、旧结论或历史“全绿”当作本轮证据。`test1/` 为 hello 示例；`.zcode/` 为开发工作流草稿/执行记录，`.workbuddy/` 为开发记录；`.cache/` 为旧构建/真实模型实验资产，均无产品入口引用。确认用途后降低优先级，没有逐行重审全部历史缓存与开发草稿。真实 `.env` 和用户会话内容未复制进报告。

第三方依赖检查覆盖锁定版本、包元数据、实际 CommonJS 入口、相关 HTTP/编码行为与 Node 13 加载结果，没有宣称逐行审计第三方库全部源码。`dist` 对主入口做了源码差异与 ZIP 内容哈希核对，重复文件没有重复逐行阅读。

第一遍建立启动、状态、IO、工具循环和测试覆盖图；第二遍复核了“前端停止 → 后端取消 → 请求门释放”“设置 → 轻模型审批”“失败状态 → workflow → UI”“写入 → 备份 → 重启”“网页会话 → 持久 shell”等组合路径。新增发现已合并在下文，没有另列未经整合的复核清单。

## 2. 项目架构理解

### 2.1 启动与部署

```text
7coder.bat ───────────────→ runtime/node.exe（否则 PATH node）→ index.js
7coder-web.bat → powershell.exe → scripts/start-web.ps1
                                  ├─ 选工作区，Push-Location
                                  └─ runtime/node.exe index.js --server

index.js
  参数解析 → 安装目录 .env → 工作区 .env 强覆盖
  → 模型/MCP/权限配置 → 工具元数据校验 → 一次性文件地图
  → readline → main()
       ├─ --background：派生一个去掉 --background 的分离子进程
       ├─ HTTP：dream 检查 → 可选启动任务 → 关闭 readline → listen
       ├─ --prompt：dream 检查 → 单次任务 → flushExit
       └─ REPL：积累输入，/execute-task-now 执行，/bye 清理
```

后端是普通 Node CommonJS 程序；没有 Electron、WebView、打包 GUI、Windows 服务管理器或自动更新器。HTML 由后端启动时读取一次，浏览器访问 `/`；内嵌脚本在 DOM 底部执行。没有页面加载成功后才允许后台工作的握手。

`launchDir` 固定为进程启动工作目录，是文件工具、状态存储和大部分命令的根；`appDir` 用于安装资源。CLI 保留调用目录，网页脚本默认切到安装目录或显式指定工作区，两者行为有意不同。

### 2.2 Agent 的核心循环

`processWithTools`：检查取消 → 必要时压缩上下文 → 请求模型 → 添加 assistant 消息 → 执行 tool_calls → 回填 tool 消息 → 下一步。全部属于可并行读集合时用 `Promise.all`，混合批次顺序执行；达到 `MAX_TOOL_STEPS` 后请求无工具最终答复。

工具通过 `safeExecuteTool` 进入：参数解析、denial、保护文件、deny 规则、自动安全例外、危险命令、computer_use 开关、allow、bypass/auto/default 审批，再到 `executeToolRaw`。元数据中的 cancellation 字段只是描述，不会自动实现取消。

CLI 任务结束后等待摘要、更新 `7CODER.md`、interaction 时间、改动/用量输出。HTTP 非流式摘要进后台 Promise 链；流式路径结束 socket 后仍在请求门内等待摘要。Ralph 只在 `executeTask` 使用；HTTP 请求直接调用 `processWithTools`，没有同样的 Ralph 包装。

### 2.3 隐式状态机与所有权

| 状态域 | 产生/修改处 | 消费处与寿命 |
| --- | --- | --- |
| 配置 | 启动环境、models.json、settings/mode API | 进程全局；重模型可变，轻模型/摘要模型固定 |
| 权限上下文 | `subAgentModeOverride`、`agentDepth`、`workflowStepDepth` | 全局变量，HTTP 请求门串行保护；子调用复用 |
| HTTP 任务 | 请求内 `tempMessages`、`clientGone`、approvalBridge | 请求局部；上游调用没有同生命周期取消 |
| REPL | `messages/currentPrompt/currentRawPrompt/taskRunning/btwPending` | 进程内；任务后 session.json 持久化 |
| 页面 | `history/busy/ctrl/sessFile/sessGen/autoSaving/sessionActivities` | 浏览器内；正文与活动分别保存，切换时 generation 防迟到响应 |
| shell/MCP | `persistentShells`、`mcpClients` | 进程级缓存，惰性创建；shell key 未包含 HTTP 会话身份 |
| 后台任务 | `backgroundTasks` | running → completed/failed/stopped；停止不验证 OS 结果 |
| cron | `cronJobs` | armed → running → idle；删除只移除计时/表项，丢失运行中 child |
| 文件状态 | todos、memory、sessions、auto-log、audit、backups | 工作区共享；没有工作区级单实例锁 |

HTTP 的实际状态为“接收 → 排队 → 模型 → 审批/工具 → 回复结束 → 摘要 → 释放请求门”。页面在回复结束即进入 idle，二者的“完成”并不相同。取消也没有贯穿整个链路。

### 2.4 外部条件和子进程

核心后端依赖随包 `node.exe`、生产 `node_modules`（axios 1.20.0、dotenv 8.6.0 及传递依赖）、可写工作区、可达的 OpenAI 协议模型端点。没有模型权重或推理服务；断网且无本地/内网模型时，Agent 推理不能工作。

可选能力另依赖：Git、Git Bash、Windows PowerShell、桌面会话/System.Drawing/Windows.Forms、Python、C# 编译器、项目自己的 tsc/eslint/npm 等。MCP 还依赖用户配置的 server 和它的运行环境。`npx -y` 示例可能首次联网下载；不能视为离线可用的部署配置。

没有发现产品启动时的 telemetry、崩溃上报、在线 license 校验、在线字体、CDN、时间服务器或自动更新调用。网上搜索/抓取/下载是显式工具功能。许可证文字中的条件是交付审查事项，本报告不作法律解释，也没有发现对应联网校验代码。

### 2.5 测试结构

A–J 为 mock 模型驱动的后端/文件/命令/状态回归，公共工装在 `_shared.js`；B 最大，覆盖既往修复和分批 ToolResult 迁移。K/R 为可选真实端点测试。页面有两个无第三方依赖的 DOM 模拟，以及 Playwright＋真实 Chrome 的本地 fixture 回归；真实 Chrome 测试不经过实际 Agent 后端。

## 3. Critical 问题

本轮没有确认 Critical。不能由此推导“可以发布”：以下 High 的触发条件正好包含默认 Win7 环境、本地模型切换和长任务停止。

## 4. High 问题

### H01：网页启动器不兼容 Win7 默认 PowerShell/CLR 组合

- **严重程度 / 类型**：High／已确认兼容性 Bug（依据代码与官方运行时定义；未在真 Win7 上执行）。
- **文件 / 位置**：[start-web.ps1:17](D:/ai-workspaces/7coder/scripts/start-web.ps1:17)，由 [7coder-web.bat:4](D:/ai-workspaces/7coder/7coder-web.bat:4) 调用。
- **相关逻辑**：无论是否传工作区，都求值 `[string]::IsNullOrWhiteSpace($Workspace)`。
- **触发条件**：Win7 自带 Windows PowerShell 2.0，运行于 CLR 2，而非已安装并启用较新版 WMF/CLR 的开发机。
- **实际后果**：方法不存在，`$ErrorActionPreference='Stop'` 终止脚本；推荐的网页启动入口在启动 Node 前失败。双击终端可能迅速关闭。
- **问题原因**：把 .NET 4 才有的方法用于承诺支持默认 Win7 的引导脚本。安装了 .NET 4 也不等于 PS2 自动改用 CLR4。
- **为什么确定**：Win7 自带 PS2，微软将 PS2 与 CLR2/.NET2–3.5 对应；该字符串方法适用版本从 .NET Framework 4.0 开始。参见 [Win7 PowerShell 说明](https://learn.microsoft.com/en-us/windows/win32/win7devguide/management-and-deployment)、[PS2 运行时说明](https://devblogs.microsoft.com/powershell/windows-powershell-2-0-deprecation/)、[方法版本](https://learn.microsoft.com/en-us/dotnet/api/system.string.isnullorwhitespace?view=netframework-4.7.2)。
- **修复建议**：用 CLR2 可用的空值＋Trim 长度判断；启动器显示版本/缺文件原因并保留失败信息。不要为了一个判断强制目标机安装整套现代 PowerShell。
- **建议验证方式**：干净 Win7 SP1/PS2/CLR2，分别双击、命令行、带中文/空格工作区启动；普通用户和管理员各验证一次。

### H02：离线网页交付缺少浏览器最低条件与预检

- **严重程度 / 类型**：High／高可信部署风险；不是“所有 Win7 浏览器均不兼容”。
- **文件 / 位置**：[webui.html:547](D:/ai-workspaces/7coder/webui.html:547)、717、776；[INSTALL.md:3](D:/ai-workspaces/7coder/INSTALL.md:3) 及快速开始；打包清单 [pack-offline.js:28](D:/ai-workspaces/7coder/scripts/pack-offline.js:28)。
- **相关逻辑**：无 polyfill，直接使用 NodeList.forEach、Promise、fetch、AbortController、ReadableStream reader、TextDecoder；CSS 使用变量、grid、clamp、inset。
- **触发条件**：目标机仅有 IE，或现场使用不支持上述 API 的旧浏览器；包内只有 Node，没有浏览器。
- **实际后果**：可能在初始化就抛错、按钮不工作，或无法读取流式回复；后端仍显示 ready。离线现场不能临时在线安装解决。
- **问题原因**：Node 13 支持 ES/API 并不代表独立浏览器页面也支持；安装说明没有固定浏览器基线。
- **为什么确定**：IE 不具备这些完整能力；代码没有能力检测或降级。Chrome 109 是官方 Win7 最后支持版本，可作为候选验收基线，而非要求升级操作系统。参见 [Google 官方兼容公告](https://support.google.com/chrome/thread/185534985?hl=en)。
- **修复建议**：明确并离线准备已验收的 Win7 浏览器版本，页面先检测关键 API 并给出可读提示。优先固定环境，不必为 IE 重写整个页面。
- **建议验证方式**：目标浏览器实测聊天、流式、停止、审批、会话恢复、中文输入、复制；IE 应显示明确不支持提示而不是静默失效。

### H03：停止生成不取消模型调用，旧任务继续占用全局请求门

- **严重程度 / 类型**：High／已确认 Bug，本轮实际 Node 13 HTTP 实验复现。
- **文件 / 位置**：[index.js:2010](D:/ai-workspaces/7coder/index.js:2010)、2035–2077、3889–3898、4892–4924；[webui.html:936](D:/ai-workspaces/7coder/webui.html:936)。
- **相关逻辑**：页面 abort 只断开下游；`cancelled()` 在循环/工具边界检查，`callOpenAI` 未接收取消参数，也没向 axios 传 CancelToken/signal。
- **触发条件**：模型慢、失联、重试、持续只发部分流；用户点击停止后再发送任务。
- **实际后果**：页面恢复可输入，新的任务却卡在旧请求后面；健康接口仍可返回 200，形成“服务活着、任务不工作”的典型现场故障。等待可达分钟级；不能把 axios 的网络超时当成统一任务总时限。
- **问题原因**：取消没有进入上游请求和重试等待；全局串行门放大了单个任务的阻塞。非流式路径还没有断连取消。
- **为什么确定**：本地上游首片段后延迟 1.7 秒结束，收到片段后立刻断开；下一请求仍等待约 **1,758ms**。源码表明不是只有测试延迟才会触发。
- **修复建议**：建立兼容 Node13 的取消源，贯穿主/轻/摘要/子代理/重试和 IO；主动销毁上游流；定义绝对截止时间。确认旧副作用已停止后才释放执行门，不能简单放开门让两个旧新任务同时写文件。
- **建议验证方式**：分别在连接前、流中、审批中、重试间隔中、工具中取消；确认旧上游关闭、无后续写入、下一个任务及时执行。

### H04：命令超时和退出清理不覆盖实际进程树

- **严重程度 / 类型**：High／父进程停止后命令继续运行已复现；其他退出入口为高可信风险。
- **文件 / 位置**：[index.js:1292](D:/ai-workspaces/7coder/index.js:1292)、1303–1313、1352–1358、1423–1427、392–396、5094、5118–5159。
- **相关逻辑**：`runCommandAsync.kill()` 仅 `child.kill()`；exec timeout 也只针对直接 child。`/bye` 仅对 Map 中 task/cron 做 `/T`，未登记当前普通命令。HTTP/Ctrl+C/one-shot 没有共同 shutdown 入口。
- **触发条件**：cmd/bash/PowerShell 派生实际命令；超时、网页停止、Ctrl+C、one-shot 返回、MCP 由 npx.cmd 启动后父进程退出。
- **实际后果**：真实命令继续写文件、占端口或持锁，下一次启动冲突；后台任务在 one-shot 中创建后又随父程序立即退出，返回的 task id 也无法继续查询。
- **问题原因**：子进程所有权分散，成功清理 `/bye` 的少数 Map 不等于所有模式正确回收。Windows `kill` 不是树杀。
- **为什么确定**：原 `runCommandAsync` 经 cmd 启动一个 Node13 子程序，150ms 超时后，该程序仍在 650ms 时写出标记。参见 [Node13 子进程 API](https://nodejs.org/download/release/v13.14.0/docs/api/child_process.html)。
- **修复建议**：统一记录所有受管 child 的身份和退出状态，Windows 对受管树实施停止并确认结束；所有正常退出模式共用幂等 shutdown。若 one-shot 要允许后台工作，定义明确的转交/持久化语义。强制 taskkill/断电不能依赖 JS 清理，应另用系统级作业管理或下次启动核对机制。
- **建议验证方式**：带孙进程的心跳/文件锁/端口探针；覆盖取消、超时、/bye、Ctrl+C、关窗口、one-shot、父进程强杀与第二次启动。

### H05：不同 HTTP 对话共享持久 shell 的 cwd/env

- **严重程度 / 类型**：High／已确认状态隔离 Bug；未做真实多标签 shell 端到端实验。
- **文件 / 位置**：[index.js:1327](D:/ai-workspaces/7coder/index.js:1327)–1420、2271–2278；[webui.html:1022](D:/ai-workspaces/7coder/webui.html:1022)。
- **相关逻辑**：`shellSessionKey()` 只看代理/工作流深度，普通 HTTP 请求恒为 `main`；不同子代理也按相同深度复用。页面新建/载入会话不通知后端清理 shell。
- **触发条件**：A 对话 `cd sub`/export 后，B 对话或新对话使用 `bash_tool {persistent:true}`。
- **实际后果**：B 在 A 的目录或环境下执行命令；文件工具仍以 launchDir 为根，两种工具对同一相对路径操作不同文件，可能改错/删错本地数据。串行执行不能消除这种污染。
- **问题原因**：进程级缓存冒充对话级资源。
- **为什么确定**：完整调用链没有 HTTP session id；隔离提取原函数得到普通请求 key 恒为 `main`。只有 REPL `/clear` 有明确 dispose。
- **修复建议**：建立后端会话身份并将 shell 归属该会话；会话结束、重置、过期时释放。暂未定义会话协议前，HTTP 禁用 persistent 是成本较低的可交付方案。
- **建议验证方式**：两个网页会话互相 export/cd，随后新建、恢复、取消、子代理结束，检查 cwd/env 只在所属会话保存。

### H06：显示截断未限制采集内存，输出可耗尽低配置机器

- **严重程度 / 类型**：High／高可信长期运行风险，未复现 OOM。
- **文件 / 位置**：[index.js:1347](D:/ai-workspaces/7coder/index.js:1347)–1380、2518–2555、2568–2576、3477–3483、2184–2205、299–304、3755。
- **相关逻辑**：持久 shell `out += d` 只在一次命令完成后裁尾；后台任务输出完整拼接，显示时才取 8,000 字符；auto_debug stdout/stderr 无上限；read_file 即使 offset/limit 也先读全文件；MCP 未换行缓冲无上限。
- **触发条件**：长时间构建日志、后台持续输出、命令不结束、一次大文件读取，或 MCP server 把日志写到 stdout 且不换行。
- **实际后果**：内存持续增长或一次峰值导致崩溃。后台任务虽然最多清理到 50 个已完成条目，但每任务可保存数十 MB 输出，合计可达 GB 量级，running 条目没有数量上限。
- **问题原因**：限制的是“给模型/界面的字符串”，不是生成、读取和持有这些字符串的过程。不能称所有 Map 都无限增长，但当前上界仍明显超出 2GB 机器预算。
- **为什么确定**：上述 data handler 和读取操作没有字节预算/环形缓冲；`pruneTasks` 也不裁单任务 output。
- **修复建议**：采集处限长/环形缓冲，或写受控轮转文件；限制同时运行任务；read_file 分块读取窗口；MCP 限帧长并拒绝异常 server；auto_debug 定额采集。
- **建议验证方式**：受限内存环境下一个持续大输出任务、50 个完成任务、多轮读取大日志，检查 RSS 峰值和回落，不仅检查返回文本长度。

### H07：下载替换失败会删除原文件，事务保护仅覆盖下载阶段

- **严重程度 / 类型**：High／已确认 Bug，本轮故障注入复现。
- **文件 / 位置**：[index.js:2394](D:/ai-workspaces/7coder/index.js:2394)–2405。
- **相关逻辑**：下载完成后 `unlinkSync(dest)`，再 `renameSync(temp,dest)`；catch 只清理 temp。
- **触发条件**：删除成功后 rename 因杀毒拦截、权限/占用状态变化或其它 IO 故障失败；两条语句之间进程崩溃也可触发。
- **实际后果**：工具报告 Download error，旧文件已不存在；临时新文件又被清理，没有 download 专属备份可恢复。
- **问题原因**：注释承诺“任何失败都不动 dest”，但提交阶段先主动破坏了旧版本。
- **为什么确定**：对原下载分支仅注入 rename EPERM，结果旧文件确实消失。现有 `ast-download` 只测连接拒绝和成功下载到新路径，未覆盖这一阶段。
- **修复建议**：采用保留旧版本的替换协议，优先尝试目标平台支持的同卷替换；失败保持旧文件。若需要先移走旧版本，必须有可靠回滚和启动恢复记录，不能直接 unlink。
- **建议验证方式**：已有目标的成功替换、rename/close/权限失败、替换时中断和第二次启动恢复。

### H08：编辑 GBK 文件会永久改写未编辑的中文内容

- **严重程度 / 类型**：High／已确认编码错误路径，未在真实 GBK 项目上执行破坏性测试。
- **文件 / 位置**：[index.js:2230](D:/ai-workspaces/7coder/index.js:2230)–2242；读取/追加另见 2187–2194、2222。
- **相关逻辑**：`edit_file` 对任意文本直接 UTF-8 解码、字符串替换、UTF-8 重写；没有验证解码可逆性，也没有编码声明。
- **触发条件**：Win7 常见 GBK/CP936 文件，用户只改一段可匹配的 ASCII；UTF-16 文本则常被 read_file 的 NUL 检测直接判为 binary。
- **实际后果**：原 GBK 中文先变为替换字符/乱码，随后连同未修改部分一起写回 UTF-8；append_file 还可能制造 GBK＋UTF-8 混合编码。备份通常可救，但备份失败被吞掉时无保护。
- **问题原因**：把全部本地项目文本视为 UTF-8，不符合目标环境。`chcp 65001` 只影响部分命令输出，不能修复文件解码。
- **为什么确定**：GBK 非法 UTF-8 字节在 Buffer.toString('utf8') 中不可逆；匹配 ASCII 不要求中文正确，所以该写入路径完全可达。
- **修复建议**：最小方案是编辑/追加前检测 UTF-8 严格可逆性，非 UTF-8 拒绝并说明；如要支持 GBK，显式编码配置、保留 BOM/换行、同编码写回。不要无依据自动猜测全部文件编码。
- **建议验证方式**：UTF-8 有/无 BOM、GBK 中文＋ASCII、UTF-16LE、CRLF 文件；比对未编辑字节，故障后能从备份恢复。

### H09：网页切换主模型后默认轻模型仍指向旧值

- **严重程度 / 类型**：High／已确认 Bug，本轮实际 HTTP 设置接口复现。
- **文件 / 位置**：[index.js:126](D:/ai-workspaces/7coder/index.js:126)、135、2120、4300、4755–4757。
- **相关逻辑**：`LIGHT_MODEL`、`SUMMARY_MODEL` 是启动时 const；settings API 只改 HEAVY_MODEL、全局 endpoint/key。
- **触发条件**：LIGHT_MODEL/SUMMARY_MODEL 留空，用户经 UI 将主模型和端点从 A 切为只支持 B 的本地服务。
- **实际后果**：主聊天能答复，自动审批仍请求 A，调用失败返回 safe=false，修改/命令等任务持续被拒；上下文压缩和摘要也走错模型。若 A 有独立 profile，还可能继续访问旧端点。
- **问题原因**：默认继承在启动时固化，没有区分“用户显式固定”与“随主模型继承”。
- **为什么确定**：设置前 heavy/light 都为 fixture，API 保存 new-fixture 后 info 返回 heavy=new-fixture、light=fixture；模型调用确实读取该旧 const。
- **修复建议**：保存显式配置，调用时解析有效 fallback；主模型切换后继承项随动。提供全部实际模型/端点的本地连通性状态，不仅回显保存成功。
- **建议验证方式**：端点 A 仅支持模型 A，端点 B 仅支持 B；UI 切换后执行 auto 写文件、上下文压缩和摘要；另验证显式轻模型不被错误覆盖。

### H10：状态直接覆盖且缺少多实例协调，异常可能变成静默数据丢失

- **严重程度 / 类型**：High／高可信数据完整性风险；没有声称本轮发生真实断电损坏。
- **文件 / 位置**：[index.js:2150](D:/ai-workspaces/7coder/index.js:2150)–2159、4043–4046、4264、4269、4358、4536、4659、4785。
- **相关逻辑**：todos、memory、session、模型配置、.env、7CODER.md 大多直接 writeFileSync 覆盖；`loadTodos` 把损坏文件当空列表。只有部分用户文件工具备份，状态写入不统一走备份。无工作区独占锁。
- **触发条件**：掉电、磁盘满、进程强杀于覆盖期间；CLI/不同端口 HTTP/后台实例同时使用一个工作区。
- **实际后果**：配置/会话截断，模型配置退回全局端点；损坏 todos 被下次 add 覆盖成新列表，旧数据再无明显恢复入口。两个实例的 read-modify-write 可互相覆盖；单进程 requestGate 无法防止。
- **问题原因**：缺少统一持久化协议、损坏隔离与跨进程所有权。同步写入只串行本线程，不提供断电原子性。
- **为什么确定**：写入顺序与损坏回退路径明确；同端口 EADDRINUSE 只阻止同端口实例，不能防 CLI 或其它端口竞争。
- **修复建议**：同目录唯一 temp＋可靠替换＋上一版本；解析失败先隔离 corrupt 文件并报警，不静默重建；按工作区选择单实例或显式锁/合并方案，锁要含身份、陈旧恢复，不能只测 PID 存在。
- **建议验证方式**：已有状态写入中断、磁盘满、只读/共享冲突、两个实例同时修改、损坏 JSON、BOM JSON和异常后第二次启动。

### H11：自动调试的进程生命周期和桌面操作不可靠

- **严重程度 / 类型**：High／部分已确认 Bug＋高可信本地误操作风险；功能默认是否启用取决于配置。
- **文件 / 位置**：[index.js:3415](D:/ai-workspaces/7coder/index.js:3415)–3432、3466–3512。
- **相关逻辑**：只监听 spawn error，没有处理实际 exit code/exit 时间；数分钟后仍按旧 PID taskkill。随机 mouse_move 后 `click` 未传坐标，实际回到默认 (0,0)；未确认测试窗口拥有焦点就发送文字。最终无条件返回 `[OK] ... only warnings or benign`。
- **触发条件**：测试程序早退/非零退出但没有匹配日志；PID 被系统重用；用户窗口抢焦点；spawn 根本失败；修复三次仍有错误。
- **实际后果**：误报测试成功、延迟误杀其它进程；启用桌面控制时可能把点击/文本注入现场其它应用。不是公网攻击模型，仍有本地真实影响。
- **问题原因**：以观察时长和文本正则替代真实进程状态，缺少目标窗口约束与权威最终结果。
- **为什么确定**：spawnFailed 直接 break 后仍走成功 return，本轮提取原分支实验得到 `[OK]` 与 `spawn failed: ENOENT` 同时存在。其余 PID/焦点风险由缺失生命周期判断可确定，发生率未测。
- **修复建议**：记录 exit/close/code、确认存活身份再停进程；退出立即结束观察；结构化报告失败/未验证；取消贯穿 fixer；GUI 操作限制于已确认的测试窗口，无归属时停止。
- **建议验证方式**：spawn 失败、静默 exit(1)、瞬时 exit(0)、长期程序、取消、三轮仍失败、焦点丢失；PID 重用用可控 mock 验证，避免实机误杀。

## 5. Medium 问题

### M01：流式回复完成后的摘要仍阻塞全局队列

- **严重程度 / 类型**：Medium／已确认 Bug。
- **位置 / 逻辑**：[index.js:4915](D:/ai-workspaces/7coder/index.js:4915)–4923，socket end 后仍 await summarizeAction 才 releaseGate；非流式另有 summaryChain。
- **触发 / 后果**：长答复触发摘要、轻模型慢或失联；页面显示完成，新任务实际排队。实验 1.6 秒摘要导致下一请求等待 **1,654ms**。生产默认单次 API 超时 420 秒并允许重试，尾延迟可很大。
- **原因 / 确认依据**：摘要不是当前任务工具执行，却占同一执行门；真实 Node13 HTTP 探针确认。
- **建议 / 验证**：流式与非流式统一进入有容量/截止时间的摘要队列，独立串行写文件；慢摘要不阻塞后续任务，并与新任务直接修改 auto-log 协调。验证回复已 DONE 后立即发下一任务。

### M02：内置 Node 未用于所有内部 Node 工具，自动测试依赖未打包命令

- **严重程度 / 类型**：Medium／已确认环境依赖 Bug。
- **位置 / 逻辑**：[index.js:3443](D:/ai-workspaces/7coder/index.js:3443)–3454；3070–3083。auto_debug 的 JS 固定用 PATH `node`；测试自动选 `npm test` 或 `node --test`。
- **触发 / 后果**：只有包内 runtime/node.exe、没有系统 Node/npm 的目标机：Agent 能启动，内部 JS 调试却 ENOENT；`node --test` 也不属于 Node13 支持的测试入口。
- **原因 / 确认依据**：包只复制 node.exe，没有 npm；内部 Node 子进程没有复用 process.execPath。不能把模型可自行填写绝对命令当作内置功能已处理。
- **建议 / 验证**：内部启动 JS 使用 process.execPath；识别当前运行时能力，不能自动选择不支持的参数；Git/Bash/Python/csc/npm/tsc/eslint 分别预检。清空 PATH 中开发工具后验证相应功能给出准确依赖信息。

### M03：网页会话保存失败静默，忙碌保存丢弃后续更新

- **严重程度 / 类型**：Medium／已确认 Bug 路径。
- **位置 / 逻辑**：[webui.html:575](D:/ai-workspaces/7coder/webui.html:575)–586；[index.js:4639](D:/ai-workspaces/7coder/index.js:4639)。
- **触发 / 后果**：历史＋活动 JSON 超过 save 路由 1MB（聊天路由允许 10MB）；磁盘满/权限失败；前一次 save 未结束时新结果再触发 save。前端 catch 不显示失败，`autoSaving` 直接丢弃下一保存，既无 dirty 标记也无补存。刷新后可能丢失用户以为已保存的对话。
- **原因 / 确认依据**：`if(autoSaving) return` 与空 catch；200 条活动各可含 12KB 文本，足以超过服务端上限。
- **建议 / 验证**：按会话排队、只合并最新快照并显示未保存状态；失败保留可重试数据，前后端统一容量策略。延迟第一次 save，让第二轮完成后再释放，确认最新记录最终落盘；测试 413/500。

### M04：错误/停止后页面保留显示，但历史与活动记录不完整

- **严重程度 / 类型**：Medium／已确认 Bug。
- **位置 / 逻辑**：[webui.html:699](D:/ai-workspaces/7coder/webui.html:699)、810–819、683–686、924–928。
- **触发 / 后果**：工具已改文件后模型报错，或用户停止部分答复：错误分支 pop 用户轮，部分 assistant 正文没有进入 history；重试时模型不知道上一操作，可能重复执行。每轮清空 sessionActivities，仅保存当轮活动；自动恢复路径还完全忽略 activities。刷新后显示过的执行记录消失。
- **原因 / 确认依据**：UI DOM 与持久化 history 是不同数据源；成功、错误、停止、手工载入和自动恢复路径不对称。现有 DOM 测试反而断言 pop 失败用户轮。
- **建议 / 验证**：记录明确的 failed/cancelled 轮与已完成副作用，正文部分标为未完成；活动绑定 turn id 并有总容量；两条恢复路径共用。验证先写文件再报错、停止部分代码、刷新和继续追问，确保不重复执行。

### M05：部分失败仍包装为成功，成功命令的 stderr 丢失

- **严重程度 / 类型**：Medium／已确认 Bug；本轮复现 agent 失败为 ok。
- **位置 / 逻辑**：[index.js:526](D:/ai-workspaces/7coder/index.js:526)–527、2250、2258–2261、2288–2306、3740–3751。
- **触发 / 后果**：子代理 API 失败被转为文字，却 `makeToolResult('ok', ...)`；workflow 必选 agent 步骤照常继续。Worktree error、Fetch error、MCP external error、Synthetic output error、Screenshot failed、Unsupported schedule 等尚未统一权威状态，部分失败也会继续。exit=0 的 stderr 被命令工具直接丢弃，编译警告和现场故障上下文不可见。
- **原因 / 确认依据**：混合结构化/文本协议未完全收口；结构化包装不能纠正已写死的错误 ok。实验返回 `{status:'ok', text:'Sub-agent ... failed: API unavailable'}`。
- **建议 / 验证**：逐工具明确结果状态，不以扩大正文关键字正则代替；子代理保留失败类型；stdout/stderr/exitCode 分别返回。验证必选失败步骤绝不执行下一写步骤，含 error/declined 的正常数据仍可成功。

### M06：Windows PowerShell 输入脚本与命令输出编码没有闭环

- **严重程度 / 类型**：Medium／脚本编码路径已确认，具体文字损坏取决于系统代码页。
- **位置 / 逻辑**：[index.js:2302](D:/ai-workspaces/7coder/index.js:2302)–2306、2908–2912、2963–2966。`input.ps1` 以 UTF-8 无 BOM 写入，再用 Windows PowerShell `-File` 读取；PowerShell 工具虽用 UTF-16LE EncodedCommand 输入，但 stdout 始终按 UTF-8 解码。
- **触发 / 后果**：中文输入、含非 ASCII 的 PowerShell 输出；旧版 Windows PowerShell 按系统 ANSI 读取无 BOM 脚本，会输入乱码或产生解析差异；系统输出不是 UTF-8 时模型读到乱码。run_command 的 chcp 不覆盖 powershell_tool。
- **原因 / 确认依据**：编码写法和调用入口明确；微软说明 [Windows PowerShell 无 BOM 脚本按 ANSI 解释](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-7)。
- **建议 / 验证**：输入统一 EncodedCommand 或 UTF-8 BOM；输出明确约定 UTF-8，必要时按来源解码。用 CP936/非中文系统实测中文内容、特殊引号、路径和错误输出；不能以 ASCII SendKeys 测试证明中文通过。

### M07：MCP 管道故障和 shell 缓存销毁存在恢复缺口

- **严重程度 / 类型**：Medium／高可信风险；未现场触发 EPIPE。
- **位置 / 逻辑**：[index.js:265](D:/ai-workspaces/7coder/index.js:265)–285、299–365、392–396、1352–1358。
- **触发 / 后果**：server 关闭 stdin 后客户端 write，异步 stdin error 没有监听，外围 try/catch 不能捕获 EventEmitter 的异步 error，可能终止后端。超时只删 pending，没有取消远端工具；未换行数据可无限缓冲。显式 `C:\...\server.cmd` 被 resolveCommandOnWindows 排除 shell 包装，无法按普通 exe 启动。
- **原因 / 确认依据**：只给 child 绑定 error/exit，没有 stdin error；request 超时不处理远端执行；Windows .cmd/.bat 需要 shell，见 [Node13 官方说明](https://nodejs.org/download/release/v13.14.0/docs/api/child_process.html)。另有旧 child 的 die 无条件 delete 同名缓存，重建时可能误删新对象，持久 shell 同样如此。
- **建议 / 验证**：管道显式错误处理；dispose/die 幂等且校验对象身份；协议超时区分“结果未知”与“远端停止”；限制帧大小；明确支持显式 cmd 路径。用断 stdin、迟到响应、退出后立即重连 fixture 验证。

### M08：删除 cron 不停止已运行命令，并丢失回收句柄

- **严重程度 / 类型**：Medium／已确认 Bug。
- **位置 / 逻辑**：[index.js:2814](D:/ai-workspaces/7coder/index.js:2814)–2822；退出遍历 5137 起。
- **触发 / 后果**：cron 正在执行时删除。只 stopped/clearTimeout/delete Map，运行中 child 继续；随后 `/bye` 也因 Map 已无此项而找不到它。用户认为任务已删除，文件仍在变化。
- **原因 / 确认依据**：删除路径没有处理 job.child，而 shutdown 只从该 Map 获取句柄。
- **建议 / 验证**：明确“停止未来调度”和“停止当前执行”语义；即使只停未来调度，运行 child 仍留在统一进程登记簿。验证删除运行中的文件心跳后输出停止、无孤儿。

### M09：权限切换和审批展示不保证与实际执行一致

- **严重程度 / 类型**：Medium／已确认状态路径。
- **位置 / 逻辑**：[index.js:3551](D:/ai-workspaces/7coder/index.js:3551)、3617、3640–3685、4796–4810；[webui.html:858](D:/ai-workspaces/7coder/webui.html:858)–861。
- **触发 / 后果**：工具审批等待中把全局切为 denial，旧调用保留捕获的 mode，批准后没有再检查；`--danger` 启动后页面切 default，DANGER_MODE 仍让执行免审批，界面却显示“操作前询问”。审批按钮在 POST 成功前先显示已批准，且不检查 HTTP 状态，过期/401/400 也可能显示成功。
- **原因 / 确认依据**：配置值、有效权限和 UI 文案不是同一权威状态。
- **建议 / 验证**：定义模式变更对在途操作的语义，执行边界复核；info 返回有效 mode 与 CLI 强制项；审批只在成功响应后显示确认，失败保留可诊断状态。覆盖等待中切 denial、danger→default、过期审批及断连。

### M10：REPL 的 EOF 和 BTW 等待仍有时序缺口

- **严重程度 / 类型**：Medium／高可信异步风险。
- **位置 / 逻辑**：[index.js:3702](D:/ai-workspaces/7coder/index.js:3702)–3712、2495–2497、5039–5043、5207–5235、5273–5281。
- **触发 / 后果**：question 注册后 stdin EOF，close 只置 rlClosed，已经等待的 Promise 没有 resolve；任务无法正常收尾。多个 BTW 同时发起仅记录最后一个 btwPending，部分备注可晚于任务开始；等待 BTW 时 taskRunning 仍 false，多个 execute handler 可同时跨过初始检查。
- **原因 / 确认依据**：readline line listener 的 async 返回不被 EventEmitter 串行等待；现有“先检查 closed”只覆盖注册前已关闭场景。
- **建议 / 验证**：集中管理待回答问题并在 close/cancel 时结算；BTW 用链或集合；在任何 await 前占用任务执行状态，await 后复核。用可控延迟而非固定 sleep 验证 EOF、多 BTW 和连续 execute。

### M11：盘符/共享根目录作为工作区会被路径包含判断误拒绝

- **严重程度 / 类型**：Medium／已确认 Bug 路径。
- **位置 / 逻辑**：[index.js:1000](D:/ai-workspaces/7coder/index.js:1000)–1005、1056–1064、1759。
- **触发 / 后果**：工作区为 `D:\` 或带尾分隔符的共享根。`path.resolve` 根仍带分隔符，代码再拼 path.sep，得到双分隔符前缀；合法子路径不匹配。状态配置加载报拒绝，main 迁移还可直接失败。
- **原因 / 确认依据**：一般目录前缀算法没有处理 filesystem root。
- **建议 / 验证**：用 path.relative 判断包含关系并显式考虑盘符/UNC 根、大小写和不同卷。验证根路径、普通目录和 junction；不能为修这一边界削弱现有真实路径检查。

### M12：启动失败与 dream 检查可能留下无服务的存活进程

- **严重程度 / 类型**：Medium／已确认控制流＋高可信恢复风险。
- **位置 / 逻辑**：[index.js:441](D:/ai-workspaces/7coder/index.js:441)、1788–1809、1841–1847、5049–5083、5345。
- **触发 / 后果**：内部状态根异常导致 migrate 抛错；dream lock 写/删失败；DREAM_ALLOW=true 且新工作区 lastTime=0，启动先调用慢/离线模型。readline 已创建，顶层仅 main().catch(console.error)，可能打印“initialized”后没有监听端口且不设失败退出码；dream 还可能在服务器上线前长时间等待。HTTP 正常聊天不更新 interaction 时间，重启后可能被误判为空闲。
- **原因 / 确认依据**：ready 与 initialized 混用；顶层错误无统一失败/清理；dream 不是后台周期任务，实际只在启动或 REPL 执行前检查，且 lock 无原子获取/owner/finally。
- **建议 / 验证**：区分初始化/服务 ready；顶层失败退出非零并释放资源；启动先做本地预检，dream 明确是否允许阻塞；锁标记所有者、原子创建并 finally 释放。验证不可写目录、外指状态根、断开模型、新工作区和重启。

### M13：同版本 ZIP 与当前源码不一致，已修错误状态会在现场重现

- **严重程度 / 类型**：Medium／已确认发布产物差异。
- **位置 / 逻辑**：`dist/7coder-v2.19.0-offline-win64.zip` 的 `index.js`，以及 [当前结构化工具清单](D:/ai-workspaces/7coder/index.js:3724)。
- **触发 / 后果**：把现有 ZIP 当作当前审阅源码发给目标机。ZIP 仍只有三个结构化结果工具，缺当前后续批次迁移；Task/File/Resource not found 等错误状态与当前源码不同。现场复现与开发机对不上。
- **原因 / 确认依据**：ZIP 共 457 项；ZIP 主入口 SHA256=`6901EA4B83492F54185CACCEDF19AE7649178E1A8CA86A02B1F95F775ABE9F39`，与 staged 入口相同；当前入口=`9BEC3422AF07C05F995CCD31F1120CA5FAABF2A0C3C669C28AF11091B81E5801`；当前与 staged diff 为 77 行增加、87 行删除（方向以 diff 为准）。HTML 哈希相同。这不是声称旧包不能启动，而是不能代表当前代码。
- **建议 / 验证**：修复后从固定提交重建、更新 build identity、生成文件清单/哈希；部署验收针对实际 ZIP，不引用工作树测试代替包验证。原 ZIP 本轮未改动。

### M14：多类磁盘数据无保留策略，混用 CLI/Web 还有历史误删

- **严重程度 / 类型**：Medium／高可信长期运行风险；CLI/Web 混用策略不一致已确认。
- **位置 / 逻辑**：[index.js:3972](D:/ai-workspaces/7coder/index.js:3972)、3264、2868、4267–4271、4659、5057、5232、2166。
- **触发 / 后果**：频繁任务/截屏/后台运行数周：Git snapshot refs、Web 新会话、截图、background.log、BTW.md、TODO.md 持续累积。session listing 每次同步读取所有 JSON；刷新与保存后重复触发，事件循环和 UI 会逐渐变慢。CLI saveSession 又对同一 sessions 目录按文件名排序只留 20 个，`web-` 前缀改变排序，可能清掉另一入口的历史，不是按真实 savedAt 保留。
- **原因 / 确认依据**：有条数上限的仅部分存储；备份 200 个和摘要 60 条不能代表全部磁盘有界。audit 的 5MB rotation 已存在，不把它误报为毫无轮转。
- **建议 / 验证**：统一按时间/总字节保留、对用户历史给可配置策略；CLI/Web 共同执行，Git refs 允许固定保留和显式导出；列表分页/索引。测试跨入口保存、几千会话和长日志下的健康响应。

### M15：Markdown 语言标识进入 HTML 属性时没有属性转义

- **严重程度 / 类型**：Medium／已确认编码上下文 Bug；未进行浏览器执行攻击实验。
- **位置 / 逻辑**：[webui.html:330](D:/ai-workspaces/7coder/webui.html:330)、380–383。
- **触发 / 后果**：模型或历史正文给出含双引号的 fenced language token，例如 `x"onmouseover="...`。esc 通过 textContent→innerHTML 转义文本，但文本中的双引号无需转义，随后却拼入 `data-language="..."`。属性可被意外截断并新增属性；页面异常时可能改变后续操作，特制内容可触发同源行为。
- **原因 / 确认依据**：HTML 文本转义与属性转义不是同一规则；语言 split 空白不排除双引号。错误气泡转 textContent 的旧修复不覆盖此处。
- **建议 / 验证**：用 DOM setAttribute 设置语言属性，或对语言标识做有限字符白名单/属性专用转义。保留 c++/c# 的现有支持。验证含引号、尖括号、未闭合围栏和普通多语言块，不把所有 innerHTML 一律重写。

### M16：完整测试入口并非完全隔离，存在现场副作用

- **严重程度 / 类型**：Medium／已确认测试工装问题；本轮因此未运行全量。
- **位置 / 逻辑**：[test/runner-i.js:432](D:/ai-workspaces/7coder/test/runner-i.js:432)–437、input-escape 场景；[test/runner-b.js:2286](D:/ai-workspaces/7coder/test/runner-b.js:2286)；[test/_shared.js:20](D:/ai-workspaces/7coder/test/_shared.js:20)；[test/kill-orphans.ps1:1](D:/ai-workspaces/7coder/test/kill-orphans.ps1:1)。
- **触发 / 后果**：在项目根运行 test-all：cli-strict 的 spawnSync 没有 cwd/timeout，可能读取根目录真实 `.env`、真实请求并改写当前工作日志/Git checkpoint；input-escape 明确启用真实鼠标键盘。sec1 临时写安装根 permissions.json，影响同机正在工作的 Agent。孤儿清理按命令行宽泛匹配，会匹配真实 index.js --server，不只本次测试。
- **原因 / 确认依据**：共享基线不能阻止产品随后从 cwd `.env` 强覆盖；各场景例外破坏总体隔离承诺。没有在本轮执行这些有副作用的路径。
- **建议 / 验证**：全部子进程独立 cwd/配置、明确超时；桌面/真实端点/安装目录改写必须单独 opt-in；只清理本次记录的 PID/身份；测试结束验证真实配置、工作日志和仓库元数据未变。

## 6. Low 问题

| ID / 类型 | 证据与触发 | 实际影响及建议 |
| --- | --- | --- |
| L01／已确认 Bug | [index.js:3216](D:/ai-workspaces/7coder/index.js:3216) 对 `git status --short` 整段 trim；第一行 ` M app.txt` 丢掉前导空格，随后 X/Y 解析反转。runner-b git-integration 还断言 staged:1 modified:0。 | Git 状态计数错误；仅去尾换行，保留首字符；修测试 oracle，不延续错误契约。 |
| L02／已确认 Bug | [index.js:3584](D:/ai-workspaces/7coder/index.js:3584) 的 memory 自动写例外用正斜杠前缀，但 Windows path.relative 返回反斜杠。 | write_file 写记忆在 Win7 不享有声明的例外，可能被多问/拒绝；memory_tool 正常路径不受此条影响。统一分隔符，不扩大豁免范围。 |
| L03／已确认行为缺陷 | [index.js:1572](D:/ai-workspaces/7coder/index.js:1572) grep 对文件路径调用 readdir，失败被当作“无匹配”。glob maxVisited 实际计目录而非所有条目，命中上限不能限制巨大无匹配目录的全部访问。 | 误导定位、扫描预算不准确。支持单文件或明确只接受目录；记录 budget exhausted，与真正 no matches 区分；对访问条目计数。 |
| L04／潜在风险 | [index.js:2811](D:/ai-workspaces/7coder/index.js:2811) cron id 仅 Date.now；同毫秒创建会 Map 覆盖旧 job，旧 timer 没有被清除。 | 低概率失去删除/退出追踪。复用 taskSeq 或单独递增序号；固定时钟单元验证两次创建仍可分别删除。 |
| L05／小型生命周期缺口 | [webui.html:836](D:/ai-workspaces/7coder/webui.html:836) 审批倒计时只在点击/120 秒后清理，停止/切会话不统一 dispose。 | 短时持有已移除 DOM，最多约两分钟，不是已证实无限 listener 泄漏；用请求级 disposer 清理，别因此重写整套 UI。 |

日志补充：多数工具错误只返回 message，没有 stack/调用 id；audit 以首行和耗时为主，难连接“哪个 HTTP 请求、哪次上游、哪个子进程”与故障。服务终端错误未统一持久化；background.log 无轮转；audit 写失败被吞。建议增加 runId/toolCallId、PID/exit/signal/errno/路径上下文及最后成功时间，错误日志做独立限额。属于可诊断性改进与 M14 配套，不应靠无限日志解决。

## 7. 疑似问题

以下均**需要进一步验证**，没有混进已确认 Bug：

1. **grep 的其它指数回溯形态**：lint 只拒绝一层嵌套量词，`(a|aa)+$` 等歧义分支仍可进入同步匹配。理论上可阻塞事件循环；未运行可能卡死的探针。后续应在独立进程＋严格时限验证，不在 Agent 主进程直接试大输入。
2. **特殊 Windows 路径的 shell 解释**：截图用 `powershell -Command` 字符串插值工作区路径，open 用 cmd/start；路径中的 `$`、`%`、引号和某些合法 shell 字符可能改变解释。普通空格路径不应一概判不兼容；需要专门字符矩阵。优先改参数数组/EncodedCommand，避免仅靠 JSON 转义。
3. **UNC/网络盘**：Node fs 能处理某些 UNC，但 cmd 的 cwd、断网盘阻塞、不同登录/管理员会话的映射盘可见性尚未实测。不能把本地盘成功等同于网络工作区保证。
4. **真正 Win7 的本机依赖/补丁**：当前宿主能运行 Node13，不证明干净 Win7 的 DLL、运行库、系统补丁和桌面驱动满足要求。没有足够证据给出“必缺某个 VC Runtime/KB”的断言。
5. **audit 轮转与下载 writer 关闭边界**：Windows 占用 `.old.jsonl`、替换失败、writer error 与 HTTP body destroy 的组合尚未做系统注入。发现 catch 吞错不等于已经证实无限句柄泄漏；需要看句柄与流是否真正关闭。
6. **SSE 中途错误后的上游回收**：parseSSEStream reject 后未统一销毁/移除监听，close 无 end 的路径也未显式结算。axios 通常会转发部分错误，但当前依赖下所有服务器异常形态未验证；不能断言必然永久 pending。

## 8. Win7 兼容性专项结论

| 分类 | 结论 |
| --- | --- |
| 明确有兼容基础 | 官方 Node13.14 支持 Win7；本地随包 runtime 版本为 v13.14.0，当前依赖可加载，实际本地 HTTP 主流程可运行。没有 Electron 版本冲突。|
| 明确不兼容的路径 | 默认 PS2/CLR2 的网页启动器 H01；IE 不能执行当前页面 H02；Node13 不支持 `node --test` 自动测试路径；没有 npm 时不能自动运行 npm test。|
| 依赖具体版本 | 浏览器的 fetch/流/AbortController/clipboard/CSS；Git/Bash/MCP/Python/csc/tsc/eslint 各自版本；现代 PATH Node 不能因 engines>=13 就认定可在 Win7 运行。|
| 必须实机确认 | Win7 SP1 x64 干净环境、所需 DLL/系统补丁、PS2/较新版 WMF 两类、CP936、中文/空格路径、默认浏览器、桌面控制、Ctrl+C/关机回收、网络盘。|

Node13.14 的平台支持见 [固定版本 BUILDING.md](https://github.com/nodejs/node/blob/v13.14.0/BUILDING.md)。当前入口使用 Promise、async/await、Set/Map、对象展开、matchAll、padStart 等，不应因“ES6+”标签就报不兼容：它们要按 Node13.14 的实际能力判断，本轮 24 份 JS 语法检查通过。也没有发现产品后端依赖全局 fetch/AbortController 才能启动。

锁定依赖的元数据未显示必需高于 Node13 的生产 Node 下限；`require('axios')` 和 dotenv 在 Node13 的加载以及本地 HTTP 请求成功。此结论针对**当前 node_modules/lockfile**，不等于未来 `npm install` 所有 ^ 范围解析结果都已验收。打包脚本使用 fs.rmSync，需要现代构建机；INSTALL 已说明这一点，不把它当目标 Win7 必须升级 Node 的问题。Compress-Archive 也是构建机条件。

目标最小部署清单应写清：Win7 SP1 **x64**、固定 Node 二进制＋依赖、可写工作区、已验收离线浏览器、可达本地/内网模型。Git/Bash/Python/编译器/项目工具链按功能选配。2GB 内存不能理解为连本地大模型也只需 2GB；当前包没有推理模型。

### 最应该做的 Win7 实机验收

1. 干净 SP1、无系统 Node/npm/Git，默认 PS2/CLR2，双击网页入口；失败有保留的诊断，安装条件准确。
2. 用固定 Win7 浏览器在物理断外网条件下完成：配置本地模型、中文对话、tool_calls、审批、文件编辑、停止、重发、恢复会话；抓包确认没有隐式外网请求。
3. `D:\工具 目录\项目`、普通目录、盘符根、UNC；含空格/中文、不同权限、只读与锁定文件；确认错误不导致错写其它位置。
4. UTF-8/BOM/GBK/UTF-16LE/CRLF 的保真编辑和 Powershell 中文输入/输出。
5. 三层进程树：普通命令、任务、cron、MCP、持久 bash、auto_debug；超时/停止/Ctrl+C/关闭窗口/注销后不残留；强杀后重启能诊断残留状态。
6. 虚拟机快照内做断电/写入中断/磁盘满/配置损坏/端口占用/双实例；保留现场原始损坏文件和上一版本。
7. 24h→72h soak：真实工作量、模型断连恢复、周期任务、大输出、反复新会话；记录 RSS、句柄数、子进程数、目录字节和任务成功/失败/取消计数。通过后再决定数周运行门槛。

## 9. 长时间运行专项结论

**评级：C／有可用主线，但尚未达到无人值守长期运行要求。** 最可能的故障不是“某个 setInterval 忘清就一定泄漏”，而是长输出与历史积累、取消后占队列、子进程残留，以及 UI/后端状态渐渐分离。

| 资源 | 已有保护 | 尚存问题 |
| --- | --- | --- |
| timer | HTTP keepalive finally 清理；cron running 防重叠；持久 shell 命令正常结束清轮询 | 取消未打断上游/sleep/部分工具；删除 cron 丢 child；GUI 调试不可取消；审批旧 DOM 倒计时短时残留 |
| listener | 页面静态监听通常只初始化一次；没有证据表明每轮都重复绑定全部 DOM 事件 | stdin error 缺监听；question close 未结算；SSE reject 后未统一 dispose；不能宣称普遍 EventEmitter 泄漏已复现 |
| memory | 上下文压缩、工具返回限长、完成 task 数量清理 | 原始采集/读全文件无界或过大；task output 大上界；浏览器 history/DOM 不裁剪 |
| child process | task_stop、REPL /bye 对部分树 taskkill | 普通命令、MCP、持久 shell 和其它退出方式未统一；调试旧 PID；停止成功无 OS 确认 |
| file handle / stream | 多数 fs sync 操作自动关句柄；download 有 writer destroy 清理 | 没有证据证明通用 fs 句柄持续泄漏；下载错误与 MCP 管道边界需验证；background log FD 随进程退出才关 |
| cache | MCP 每 server 一个；shell 按少量 key 缓存；tool changes capped 1000 | key 的归属错误比数量泄漏更急；shell 输出仍可增长，旧实例 delete 新缓存存在竞态 |
| disk / log | audit 约 5MB 轮转，备份每源5/全局200；auto-log 60条 | 快照 refs、Web会话、截图、后台/BTW/TODO日志没有统一总字节预算 |
| state | requestGate 防止部分全局权限上下文并发；sessGen 防若干迟到响应 | 上游取消、权限切换、跨会话 shell、跨实例写、UI 部分失败、模型热切换不一致 |

现有健康信息只能说明 HTTP 在回答和用量计数；不能回答执行门是否卡住、最后一次任务成功何时、是否有孤儿、磁盘是否满。建议增加 active/queued/lastSuccess/lastError 等最少指标，仍保持普通用户界面简洁。

## 10. 测试覆盖缺口

### 10.1 本轮实际运行记录（每条只运行一次）

| 验证 | 结果 | 边界 |
| --- | --- | --- |
| Node13.14 `--check` | 24/24 文件通过 | index.js、scripts/test 的全部 JS；只证明语法，不证明全部可选 API 可用 |
| Node13.14 `index.js --help` | exit 0 | 同时加载当前生产依赖；不依赖真实模型 |
| `node test/webui-ui-sim.js`，Node24.19 | 43/43 | 人工 DOM/网络 stub，非旧浏览器 |
| `node test/webui-dom-sim.js`，Node24.19 | 12/12 | 围栏、首次保存、错误显示等；不覆盖实际后端取消 |
| 一次性审阅隔离探针 | 9 个观察点均出现，exit 0 | 见下表；“观察到问题”为复现成功，不是产品功能测试通过 |

| 探针 | 方法与观察 |
| --- | --- |
| auto_debug spawn failure | 提取原 executeToolRaw，受控失败 cycle，仍输出 OK |
| agent failure status | 提取原分支，失败子代理返回状态 ok |
| download commit failure | 原分支＋真实临时文件/stream，注入 rename EPERM，原文件消失 |
| 默认辅助模型 | 原 fallback 语义，主模型改变后轻/摘要仍旧值 |
| shell key | 提取原 key 函数，无 HTTP 身份，普通任务恒 main |
| command timeout | 原异步 runner＋真实 cmd/Node13 子进程；超时后仍写标记 |
| cancelled model gate | 实际 Node13 后端＋本地 SSE fixture；取消后下一请求仍等旧调用 |
| stream summary gate | 实际 Node13 后端；DONE 后下一请求仍等摘要 |
| settings API | 实际 POST settings 和 GET info；heavy 变、light 不变 |

探针代码/原始记录位于忽略缓存：[review-20261022-probes.js](D:/ai-workspaces/7coder/.cache/review-20261022-probes.js)、[review-20261022-evidence.json](D:/ai-workspaces/7coder/.cache/review-20261022-evidence.json)。报告中的结果已完整摘录，缓存被清理也不影响阅读。实验使用系统临时工作区、本地假模型，未调用付费/真实模型，未操作用户桌面。实验服务已关闭；临时数据保留供追查，未递归清理用户目录。

**未运行**：A–J 全量、K/R、真实浏览器回归、真实桌面注入、打包构建、Win7 真机、24/72h soak、断电和磁盘满。理由：按要求最小必要验证；全量测试存在 M16 副作用，无法把读源码审阅变成安全的全量运行。本轮没有测试失败后反复重跑或修测试追绿。

### 10.2 按优先级最值得新增的测试

| 优先级 | 场景 | 必须断言的事实 |
| --- | --- | --- |
| P0 | Win7 原始 PS2/CLR2 启动 | Node 真正启动、端口 ready、错误退出码与失败说明 |
| P0 | 模型/重试/工具中取消 | 旧执行停止、无迟到副作用、执行门释放、下一任务成功 |
| P0 | Windows 三层进程树回收 | 父子孙都结束，文件锁/端口释放；不能只看父 exit=0 |
| P0 | UI 跨端点热切换 | 默认轻/摘要随动，auto write 与压缩可用，显式 profile 保持 |
| P0 | 文件写入提交阶段故障 | 下载原文件保留、JSON/配置上一版本可恢复、错误明确 |
| P1 | GBK/UTF16/BOM/中文 shell | 未修改字节保真；不支持时拒绝写，不产生替换字符 |
| P1 | 两对话持久 shell | cwd/env 无串扰，新建/恢复/代理结束正确释放 |
| P1 | 50 个大输出任务/持续输出 | 内存峰值受预算限制，输出尾可读，child 数不累积 |
| P1 | auto_debug 的全部终态 | spawn fail/exit1/已退出/仍失败/cancel 均不是伪成功，不误杀旧PID |
| P1 | 慢 save＋下一轮/413/500 | 最后快照最终保存，失败可见，活动与部分轮恢复一致 |
| P1 | 多实例/损坏状态/第二次启动 | 不互相覆盖、不静默清空，残锁可恢复且不抢活锁 |
| P1 | MCP stdin 错误/超时/重启 | 不崩溃、错误结算、旧对象不删除新缓存，迟到结果不覆盖新任务 |
| P2 | 真实 Win7 浏览器＋实际后端 | UI 按钮停止与后端停止同义，审批400/401反馈真实 |
| P2 | 72h 工作量与磁盘保留 | RSS/句柄/进程/磁盘增长曲线有界，而非只有最终 stdout PASS |

### 10.3 现行测试中容易产生错误信心的具体位置

- [runner.js:466](D:/ai-workspaces/7coder/test/runner.js:466) 和 [runner-i.js:47](D:/ai-workspaces/7coder/test/runner-i.js:47) 是直接传 true 的信息项，不是行为覆盖；skip 也有记录为 PASS 的情况，应单独统计。
- [runner-d.js:66](D:/ai-workspaces/7coder/test/runner-d.js:66) 用 `log.length>0` 代表“完成全部路径攻击表”，只能证明发生过请求。需要每个调用 id 的真实结果。
- [runner-b.js:1865](D:/ai-workspaces/7coder/test/runner-b.js:1865) 声称 `read -t 10` 超过 timeout，但配置 timeout_ms=15000；10秒小于15秒。该断言不能稳定证明宿主超时重启。
- runner-i flush 用 `BGERR-MARK` 搜背景日志，但 bypass 的命令预览本身已包含这个文本，即使成功 stderr 被丢弃也能命中。
- [runner-j.js:181](D:/ai-workspaces/7coder/test/runner-j.js:181) 附近 steps-zero 只要求最终成功/提到limit；配置 0 被 `||30` 吃掉，不能证明“零步不执行工具”。应断言工具绝未调用。
- K real-workflow 只看文件存在，不能证明模型走 workflow；R5 不发送目标 model，只验证默认模型回复，不能证明第二 profile 路由。
- 多个 pairingValid 只检查相邻 role，没有验证每个 tool_call_id 都完整且仅匹配一次。mock-server 按请求顺序发脚本、不验证请求合法性；用重复最后一个脚本步骤填充还可能掩盖调用错序。
- 真实 Chrome 测试使用本地 UI fixture，不证明 Agent 后端取消/进程回收；DOM mock 的 setTimeout/no-op 等也不能证明真实计时器生命周期。
- RSS soak 约24个快任务，不能关闭小时级/数周内存问题；crash-recovery 在 sleep 阶段杀进程，没有击中写文件提交窗口。

这些测试仍有回归价值，建议修正 oracle 和补关键反例，不要整体删除、重写或仅追求更大断言数。

## 11. 架构和维护性

### 是否需要拆主 JS

**有必要逐步抽边界，但不是因为 279KB 这个数字。** 当前 UI 接口、模型调用、进程、状态持久化、权限和退出在同一模块共享可变状态，已经产生 H03/H05/H09 等真实生命周期问题；更关键的是测试不得不从源文本截取函数、eval/VM 注入，容易被移动代码或格式改变影响。

建议按以下边界逐步抽出，每次保留旧接口：

| 边界 | 所有权与职责 |
| --- | --- |
| runtime/config | 显式配置、动态 fallback、目标环境预检；不在各调用点复制配置逻辑 |
| process-manager | 所有子进程登记、输出预算、退出码、取消与树回收；支持 CLI/HTTP/cron 共用 |
| model-client | 协议/流解析、重试、取消、绝对截止时间、模型路由与用量 |
| workspace-store | 路径、编码、原子替换、备份、状态损坏恢复、保留策略 |
| task-context | runId、会话身份、权限上下文、任务变更、取消与 shell/MCP 归属 |
| permission / tool-registry | 保留现有元数据与顺序，让实现返回一致 ToolResult |
| HTTP / REPL adapters | 只转换输入输出、审批桥与显示，不拥有进程回收或状态写协议 |
| 页面独立小块 | conversation、activity timeline、save queue、request disposer；不必引入框架 |

当前项目已有“拆分暂缓”的历史决定，本轮只给建议，不启动大规模迁移。先修明确 Bug，再借对应修复建立小边界。不要在同一轮同时拆53工具、改权限语义、换模型协议和重做页面。

### 最好暂时不要动的区域

- Git 命令参数数组、真实路径/junction 检查、保护文件和 deny/allow 的既定先后顺序；这些已有有效修复，重写容易回归。
- cron 的 running 防重叠与长间隔分段续期；只补句柄归属/删除语义。
- 文件备份每源5/全局200、统一工具结果限长、CJK 加权上下文；可改善边界，但不需要引入复杂新依赖。
- 页面系统字体、内嵌资源、中文输入法保护、sessGen 的迟到响应保护、围栏逐行解析主体；只修具体属性转义和生命周期。
- 当前 axios/dotenv 的已锁版本与离线部署方式；没有证据支持为“现代化”先升级到不兼容的运行时或换前端框架。

没有把 parseTestOutput/formatDiagResult/git 等定义在 executeToolRaw 内直接判死代码：它们的词法位置虽不利维护，后续分支确实可达。部分旧路径常量和 lastDeclineReason 等可收敛，但优先级远低于生命周期与数据问题。历史文件不参与运行，应保留追溯价值，不因重复文字误删。

未来修改风险最高的是：取消从 UI 贯穿上游/工具/子代理，权限捕获与全局模式变更，文件路径/编码/替换策略，以及 CLI/Web 对同一状态目录的共同操作。对这些边界做少量真实反例，比继续增加 happy-path mock 数量更有收益。

## 12. 修复优先级

排序综合影响、目标环境发生概率、成本与可临时规避性；High 并不都要求同时大改架构。

### P0：部署前必须完成或明确禁用触发能力

1. **H01 启动器 PS2 兼容**：改动小，直接决定默认 Win7 能否启动；补真实镜像验证。**H02 浏览器、本地模型和 x64 条件同时写入并落实交付**。
2. **H04 统一进程树停止与退出**：先覆盖普通命令、超时、HTTP停止、Ctrl+C、one-shot；不可靠的后台/调试模式先关，避免现场残留和错写。
3. **H03 上游取消＋任务截止时间**：跟进进程回收后再释放请求门，禁止旧任务仍执行时放行新写操作。
4. **H09 模型热切换一致性**：保留显式设置，动态解析默认继承；两套本地模型服务验证。成本低、半失效概率高。
5. **H08 编码保真最小防线**：至少拒绝不可逆的非 UTF-8 编辑/追加；GBK 项目部署前不能略过。

### P1：强烈建议同一稳定性版本完成

6. **H07 下载替换＋H10 状态落盘**：先修明确的 unlink 数据丢失，再统一关键 JSON/.env 的上一版本和损坏隔离；按工作区实施单实例或锁。
7. **H05 shell 会话隔离**：最小可先禁止 HTTP persistent；新建会话不得继承旧 shell cwd/env。
8. **H06 采集预算**：先环形输出和并发上限，覆盖后台任务、持久shell、调试及大文件读取。
9. **H11 调试生命周期**：在可靠前不要默认启用真实桌面自动调试；失败不报OK、不按过期PID杀进程。
10. **M01/M03/M04/M05/M09**：摘要不占执行门，保存可见且不丢最新状态，部分失败可恢复，权威失败状态与权限回显一致。
11. **M07/M08/M10/M12/M16**：MCP管道、cron删除、REPL关闭、启动失败及测试隔离。

### P2：近期补齐

12. M02/M06/M11：内部运行时路径、PowerShell中文、根/UNC路径边界。
13. M14：磁盘/会话/Git refs 保留、必要的运行状态与故障上下文。
14. M15：属性转义小修；L01/L02 等低成本确定性错误。
15. **M13 发布一致性**：不是等以后再部署旧包；正式交付前必须用最终固定源码重建并核对 ZIP/build identity。它属于发布门槛，排序靠后只因为应在源码修复后执行。

### P3：以后按需求处理

渐进模块拆分、完善测试统计与 skip 口径、非热点 UI 增量渲染、可选诊断体验。保持单文件的稳定部分，不做“换 TypeScript/React/升级操作系统/重写整个项目”式迁移。

### 最终发布判定

| 用户最关心的问题 | 本轮答案 |
| --- | --- |
| 有没有明显不能上线的 Bug | 有：默认 Win7 启动、停止后残留执行、模型切换半失效，以及特定文件编码/替换的数据破坏路径。 |
| Win7 明显兼容问题 | 有，首先是 PS2/CLR2 启动器和未指定浏览器；主 JS 的 Node13 语法并非主要障碍。 |
| 长期最可能出什么问题 | 请求门被旧模型/摘要占住、输出内存高峰、子进程残留、磁盘历史增长和跨对话 shell 状态污染。 |
| 哪些会表面存活但不工作 | H03、H09、M01、M10、M12；健康接口200不能排除这些情况。 |
| 测试缺的核心场景 | 真实 Win7 启动、完整取消/树回收、写入提交故障、GBK保真、跨会话/跨实例及小时级真实工作量。 |
| 最好暂时不动什么 | 已有权限/路径硬边界、Git argv、cron防重叠、备份策略、离线页面主体与当前依赖。 |
| 修完如何验收 | 先做关键负向反例，再针对实际ZIP完成第8节Win7清单，最后24/72h soak。不能用本轮55项UI绿测代替。 |

本轮完成了完整产品源码与现行测试阅读、跨模块第二遍复核及一轮最小验证。**报告记录的是待修问题，不代表已修复；当前保留风险主要是未做真实 Win7、资源长测和断电级故障验收。**
