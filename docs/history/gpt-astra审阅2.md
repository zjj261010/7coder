# gpt-astra 项目完整审阅（二）

> 审阅日期：2026-10-04（UTC+8）  
> 项目：7coder v2.18.0  
> 审阅基线：`1f52a8a7a87753796eb5533a20df16af3f3a3e3e`  
> 工作区：`D:\ai-workspaces\7coder`  
> 性质：全项目复审与问题报告；**本次没有修复或改写业务代码**。

## 一、结论先行

项目已经具备较完整的个人编程助手功能，主线回归覆盖也明显比早期版本完善。本次确认：Git 参数数组调用、下载中途失败保护、请求体大小限制、网页首次保存、流式业务错误展示、模型路由、备份保留与基础文件扫描等旧修复，均有相应实现和回归支撑。

但“待办清零”不能等同于“边界闭环已经可靠”。本轮发现 **22 项需要处理的问题：9 项 P1，13 项 P2**。问题主要集中在新功能与已有框架的接缝：

- 新增记忆工具没有复用真实路径和保护规则，能经目录联接读写工作区外文件。
- 安装级 allow 规则会吃掉工作区同名 deny 规则。
- diagnostics 被视为免审批只读工具，实际会执行项目中的 JavaScript 程序。
- 网页错误消息绕过了正常内容的 HTML 转义。
- `/fork` 在有工具调用的普通会话中会生成不完整消息链。
- bypass 分支漏传取消令牌，失败测试仍能让工作流继续执行写入步骤。
- Dream 失败会覆盖原有笔记；自动调试启动失败会直接杀死 HTTP 服务。

**建议：先暂停新增工具，优先收口权限、失败传播、取消和会话状态这四条链路。** 不必为此先进行大规模架构重写；大部分问题可以小范围修复并补充反例测试。

### 严重程度与证据口径

- **P1**：优先修复。可破坏授权边界、丢失已有数据、造成服务退出，或使核心会话不可继续。不是说所有场景都无条件可远程利用。
- **P2**：随后修复。影响可靠性、保密性、资源控制、互操作或安装体验。
- **动态**：使用当前源码、实际服务/子进程或隔离函数执行复现。
- **DOM 模拟**：执行当前网页内联脚本，用项目现有风格的 DOM/fetch 替身复现状态或 HTML 写入；**不冒充真实浏览器执行验证**。
- **静态/分发对照**：给出明确代码路径或现有包内容差异，未声称跑过完整故障现场。

本轮没有证据足够支持新增 P0 定级。历史已明确“不修/暂缓”的产品决策单独列出，不混入新增缺陷数量。

## 二、范围、方法与测试结果

### 2.1 审阅范围

基线有 35 个 Git 跟踪文件。本次覆盖：

| 范围 | 实际检查内容 |
|---|---|
| 主程序 | 完整检查 `D:\ai-workspaces\7coder\index.js`，4771 个实际文本行：CLI、配置、权限、路径、所有工具分支、MCP、持久 shell、模型请求、上下文、记忆、HTTP、REPL、退出 |
| 网页 | 完整检查 `D:\ai-workspaces\7coder\webui.html` 的结构和内联脚本；重点检查渲染、流式解析、审批、会话保存/切换、设置 |
| 工程配置 | `D:\ai-workspaces\7coder\package.json`、锁文件、环境变量示例、忽略规则、启动脚本 |
| 测试 | A–J 离线套件执行；共享运行器、mock 服务、DOM 模拟器、K/R 真实端点入口审查；针对本轮问题追加隔离探针 |
| 构建分发 | `D:\ai-workspaces\7coder\scripts\pack-offline.js`、断言计数脚本，以及现有 v2.18.0 解包目录 |
| 文档 | README、INSTALL、LICENSE、统一问题日志和历史审阅对照；历史结论仅作为线索，不作为本轮实测结果 |

边界：没有逐行审计所有第三方依赖源代码，也没有逆向内置运行时；没有把忽略目录、历史缓存和用户已有的 `.workbuddy` 内容当成项目源码改动。没有在 Windows 7、macOS 或 Linux 实机上重新验证。

### 2.2 本轮实际回归

运行环境：Windows，系统 Node **v24.19.0**；另使用现有离线包中的 Node **v13.14.0** 复测核心套件。

| 套件 | Node 24 结果 | 备注 |
|---|---:|---|
| A | 84/85 | process_list 断言失败，涉及受限环境的系统进程枚举 |
| B | 215/215 | 全部通过，包括近期 memory、fork、scan-caps 等测试 |
| C | 35/35 | 全部通过 |
| D | 32/32 | 全部通过 |
| E | 21/22 | 实际 taskkill 测试失败，涉及进程管理权限 |
| F | 23/23 | 全部通过 |
| G | 29/29 | 全部通过 |
| H | 30/32 | RSS 采样为空导致两个断言失败；不是采样证明了内存增长 |
| I | 27/28 | 未运行 `input-escape`，避免向用户桌面发送按键和移动鼠标；cron-treekill 断言失败 |
| J | 16/16 | 全部通过 |
| **已执行 A–J 合计** | **512/517** | I 套件明确排除一个桌面操作场景，不能写成“全部测试全绿” |

补充验证：

- Node 13：B **215/215**；A 排除 `adv-tools` 场景后 **65/65**。
- 原有网页 DOM 模拟测试：**8/8**。
- 主程序、打包脚本语法检查通过。
- 静态 `record(` 调用计数为 **497**，与运行时断言数不同，不能相互替代。
- v2.18.0 解包目录中的主程序、网页、包清单、锁文件与工作区对应文件 SHA-256 一致。**这仅验证四个文件，不等同于对整个 zip 的完整性认证。**

五个失败断言集中在进程枚举、终止和采样相关场景。尝试申请在受限环境外重跑四个关联场景时，审批服务因限流未能完成审核，因此没有执行该重跑。**这些结果尚不能被归因为产品缺陷，也不能被宣布已排除；须在正常进程管理权限的机器上复测。**

K/R 真实端点测试未执行：本轮没有调用用户真实模型服务、使用真实密钥或产生真实模型费用。没有重新打包、下载 Node、安装依赖或实际操作桌面。依赖漏洞库的在线审计也未执行，本文不作“依赖无漏洞”的保证。

### 2.3 复现方式与保存位置

新增探针和日志仅放在已忽略的目录：

`D:\ai-workspaces\7coder\.cache\astra-review-2`

探针使用临时工作区、假密钥、回环 HTTP mock；目录联接的目标也在该审阅目录内。部分函数测试从原文件加载到隔离上下文，替换模型、终端等外围接口，不修改原文件。危险命令检测探针拦截实际执行，未运行格式化、删除磁盘等操作。

## 三、问题总览

| 编号 | 级别 | 问题 | 证据 |
|---|---|---|---|
| A2-01 | P1 | 记忆工具经目录联接越出工作区，且忽略额外保护规则 | 动态 |
| A2-02 | P1 | 跨配置层去重使 deny 被已有 allow 吞掉 | 动态 |
| A2-03 | P1 | diagnostics 免审批执行项目代码 | 动态 |
| A2-04 | P1 | 网页错误字符串未经转义进入 innerHTML | DOM 模拟＋静态数据流 |
| A2-05 | P1 | `/fork` 截断工具调用链，后续请求不合法 | 动态 |
| A2-06 | P1 | bypass 漏传取消令牌，停止不贯穿活动任务 | 动态＋调用链审查 |
| A2-07 | P1 | 测试命令失败未被工作流识别，后续写入照常执行 | 动态 |
| A2-08 | P1 | Dream 异常覆盖原笔记，新工作区启动也可能失败 | 动态 |
| A2-09 | P1 | auto_debug 未处理 spawn error，整个服务退出 | 实际 HTTP/子进程 |
| A2-10 | P2 | 配置 HTTP_API_KEY 后，待办接口仍匿名返回内容 | 实际 HTTP |
| A2-11 | P2 | tsc 配置/启动错误被报告为 clean | 动态 |
| A2-12 | P2 | 单标签内切换/新建会话会串入回答、覆盖错误存档 | DOM 模拟 |
| A2-13 | P2 | 记忆召回预算允许首条笔记无限超额 | 动态 |
| A2-14 | P2 | `/clear` 不清持久 shell，状态跨“新会话”残留 | 动态 |
| A2-15 | P2 | 上游 SSE 未完成即 EOF，被当作成功回答 | 动态 |
| A2-16 | P2 | 保存模型设置重写无关键值，破坏多行环境变量 | 实际 HTTP |
| A2-17 | P2 | 超危险命令硬拦截只覆盖部分命令入口 | 隔离拦截执行＋静态 |
| A2-18 | P2 | 审计日志结果首行仍记录明文敏感数据 | 动态 |
| A2-19 | P2 | Windows 示例 MCP 配置无法直接启动 npx | 两个运行时实际 spawn |
| A2-20 | P2 | 扫描预算不约束正则运算和实际遍历工作量 | 动态＋静态 |
| A2-21 | P2 | 打包清理异步重试可能删除正在构建的新目录 | 静态 |
| A2-22 | P2 | 安装示例、包内容及版本说明仍有可操作性错误 | 文件/分发对照 |

## 四、P1：应优先处理

### A2-01｜记忆工具未遵守工作区和文件保护边界

**位置：** [index.js:2239–2275](D:/ai-workspaces/7coder/index.js#L2239)、[index.js:3456–3476](D:/ai-workspaces/7coder/index.js#L3456)、[index.js:734–749](D:/ai-workspaces/7coder/index.js#L734)。

`memoryTopicValid()` 只限制主题名称；`memoryFilePath()` 直接拼接路径，读写与删除都没有校验真实路径。`memory_tool` 又位于 AUTO_SAFE_TOOLS 中。只要 `.7coder/memory` 已是指向外部目录的 junction，合法主题名称也会访问外部文件。

**复现：** 在临时工作区放置 `.7coder/memory -> 审阅目录中的另一目录`；default 模式执行 read 和 save。结果为：

```text
read  -> ## review / OUTSIDE-ONLY-FAKE-DATA
save  -> [OK] Memory note updated
外部 review.md -> CHANGED-OUTSIDE
```

另一个独立探针配置 `protected_extra: [".7coder/memory/**"]`，`memory_tool save` 仍免审批写入。原因是 `isProtectedTarget()` 根本不处理该工具。

**前提与影响：** 需要已有联接或相关保护配置；本轮不是声称模型在无权限时能自行创建联接。问题在于一旦存在联接，已宣称的工作区边界不再成立。

**建议：** 对内建状态目录也校验真实路径和预期目录；为 memory 的 read/save/delete 显式映射到文件权限检查，不依赖工具名豁免。对技能、会话、备份、自动日志等直接文件访问点一起做同类审查。

**验收：** 普通笔记 CRUD 仍通过；外部 junction、文件 symlink 和 `protected_extra` 三类反例必须拒绝，且外部文件内容不变。

### A2-02｜安装级 allow 可以吞掉工作区 deny

**位置：** [index.js:788–816](D:/ai-workspaces/7coder/index.js#L788)。

`loadPermRules()` 对所有文件、所有 bucket 共用一个 `seen`，键仅是规则字符串。先读取安装级配置，再读取工作区配置。如果安装级 allow 已出现 `write_file(blocked.txt)`，工作区 deny 中同一字符串会被当成重复条目丢弃。

**复现：** 安装级 `allow: ["write_file(blocked.txt)"]`，工作区 `deny: ["write_file(blocked.txt)"]`。加载结果：

```text
allow = ["write_file(blocked.txt)"]
deny  = []
执行结果 = Written: blocked.txt
```

同一文件内 deny 在 allow 前读取，现有简单测试因此容易通过；问题出在两层配置组合。

**建议：** 去重键至少包含 bucket；更稳妥的是分别合并 allow、deny、protected_extra，执行时固定 deny 优先。不允许上层 allow 在解析阶段消灭下层 deny。

**验收：** 覆盖两层配置、相同字符串、相反 bucket、不同读取顺序；default/auto/bypass 均应遵守 deny。

### A2-03｜diagnostics 不是免审批只读操作

**位置：** [index.js:513–520](D:/ai-workspaces/7coder/index.js#L513)、[index.js:2693–2722](D:/ai-workspaces/7coder/index.js#L2693)。

判断依据是“只执行当前项目 node_modules 中的 tsc/eslint”。但本地 JavaScript 文件本身就能执行任意进程权限内的操作；实际 ESLint 还会加载项目配置与插件。**执行文件在工作区内，不代表程序只读。**

**复现：** 临时工作区的 `node_modules/typescript/bin/tsc` 只做两件事：写入无害标记文件，然后输出诊断。default 模式调用 `diagnostics_tool`，没有任何审批，标记文件被创建。

这无需模型得到 shell 工具授权；只要用户让助手审阅一个未信任项目，或项目中已有此类执行入口，就与“默认代码执行需要批准”的契约冲突。

**建议：** 从 AUTO_SAFE_TOOLS 中移除；默认走代码执行审批。若将来支持可信工具链白名单，应明确区分可信可执行文件与仍会执行的项目配置。不要把 `--noEmit` 当成进程沙箱。

**验收：** 默认模式且用户未批准时，伪 tsc、含副作用的 ESLint 配置都不能创建标记文件；批准后仍可完成正常诊断。外部依据见文末 R2、R4。

### A2-04｜网页错误消息存在 HTML 注入/XSS 路径

**位置：** [webui.html:386–399](D:/ai-workspaces/7coder/webui.html#L386)、[webui.html:543](D:/ai-workspaces/7coder/webui.html#L543)、[webui.html:584–588](D:/ai-workspaces/7coder/webui.html#L584)。

正常回答经过 `render()`/`esc()`，但错误路径调用 `addMsg('err', '错误: ' + e.message)`；`addMsg()` 会直接设置 `innerHTML`。模型服务或兼容代理返回的错误消息沿 SSE 进入这里。

**DOM 模拟复现：** 上游错误为无害测试载荷：

```html
<img src=x onerror="window.__review_xss=1">
```

错误气泡的 `innerHTML` 原样包含该标签，而非 `&lt;img ...&gt;`。

**证据边界：** 已执行真实前端脚本并确认未转义 sink；未在用户浏览器中运行事件处理器。利用还需要攻击者能影响错误消息。不能因为正常聊天内容已转义，就断言整个页面无 XSS。

**影响：** 若在实际浏览器中执行，同源页面的会话、API key 输入和管理接口均处于风险范围，具体利用范围取决于部署与浏览器策略。

**建议：** 错误消息使用 `textContent`，或对错误文本调用 `esc()`；将“文本消息”和“受信 HTML”接口拆开。同步检查审批发送失败路径。

**验收：** HTTP 错误、SSE 错误、网络错误都以纯文本显示 `<>&"` 等字符；增加真实浏览器反例测试。外部依据 R1。

### A2-05｜`/fork` 把工具调用和工具结果拆开

**位置：** [index.js:4677–4693](D:/ai-workspaces/7coder/index.js#L4677)。

实现保留第 N 个 user 以及“紧邻的一个 assistant”。如果该 assistant 是 `tool_calls`，后面的 tool 结果和最终 assistant 回答全部被删掉。

**复现：** 原会话为：

```text
system → user1 → assistant(tool_calls id=t1) → tool(t1) → assistant(final1)
       → user2 → assistant(final2)
```

执行 `/fork 1` 后实际只剩：

```text
system → user1 → assistant(tool_calls id=t1)
```

再追加新任务时，待配对的 tool_call 后直接出现 user，且第一轮最终答案丢失。原有 fork 测试使用纯文本回答，未覆盖正常的编程工具回合。

**建议：** 以“下一条 user 消息之前”为回合边界，保留完整 assistant/tool 链；如产品希望丢弃工具历史，必须成组移除 tool_calls 和对应结果，保留最终答复，不能只留半边。

**验收：** 测试单工具、多工具、多步工具链、纯文本、压缩摘要；fork 后请求消息配对合法，所选回合最终答案仍在。

### A2-06｜bypass 分支丢失取消，停止按钮不能可靠止损

**位置：** [index.js:3139–3142](D:/ai-workspaces/7coder/index.js#L3139)。关联：[index.js:460–478](D:/ai-workspaces/7coder/index.js#L460)、[index.js:1872–1879](D:/ai-workspaces/7coder/index.js#L1872)、[index.js:3233–3236](D:/ai-workspaces/7coder/index.js#L3233)。

普通路径调用 `executeToolRaw(..., cancelled)`，bypass/--danger 路径少了最后一个参数。已取消的相同工具调用在隔离执行中表现为：

```text
bypass -> Command OK
普通 auto 路径 -> [aborted: client disconnected]
```

还有同族缺口：子代理的 `processWithTools(agentMessages)` 未继承取消；持久 shell 只在 `sh.run()` 返回后检查取消；上游 axios 调用没有活动取消；等待审批时断连没有立即 dispose，通常仍要等审批超时。

**建议：** 先补 bypass 参数遗漏，再让上下文对象贯穿子代理、模型请求、持久 shell、审批等待。活动子进程需要正确终止进程树；`child.kill()` 与“整棵进程树已终止”不是同一保证。取消后禁止下一次副作用，也应立即释放无需继续占有的资源。

**验收：** 分别测试 default/auto/bypass，在模型流、普通命令、持久 shell、子代理、审批等待中取消；观察延迟标记文件不再写入，而不是只断言客户端连接关闭。进程树部分本机受限环境未完成验证，不能写成已验证修复。外部依据 R2。

### A2-07｜失败测试没有停止工作流

**位置：** [index.js:2666–2679](D:/ai-workspaces/7coder/index.js#L2666)、[index.js:3251–3252](D:/ai-workspaces/7coder/index.js#L3251)、[index.js:2609–2615](D:/ai-workspaces/7coder/index.js#L2609)。

`run_tests_tool` 即使退出码非零，也返回以 `[TESTS]` 开头的文本。统一失败正则不识别这个返回；工作流据此继续执行下一步并宣称成功。

**复现：** 工作流第一步执行只返回退出码 3 的无害 Node 程序，第二步写入标记文件。实际结果：

```text
[OK] Workflow complete
step 1: [TESTS] command finished (exit=3) ...
step 2: Written: after-failed-tests.txt
```

即使终端最后打印了 `1 passed`，也不能用它覆盖进程失败状态。当前散落的错误文本还包括 `Fetch error`、`Tests error` 等未纳入统一判断的分支。

**建议：** 至少让失败退出码返回标准失败前缀；长期将 `ok/exitCode/errorKind/text` 与显示文案分开。工作流应根据结构化状态决定是否继续。

**验收：** 非零退出、超时、无法识别摘要、识别到失败数等场景；`optional=false` 不得执行后续写入，`optional=true` 可以继续但必须保留失败状态。

### A2-08｜Dream 失败会覆盖笔记，首次启动还缺状态目录

**位置：** [index.js:1377–1395](D:/ai-workspaces/7coder/index.js#L1377)、[index.js:1426–1432](D:/ai-workspaces/7coder/index.js#L1426)、[index.js:4771](D:/ai-workspaces/7coder/index.js#L4771)。

**主要问题：** `runDreamSession()` catch 直接将整个 `7CODER.md` 改成 DREAM FALLBACK，没有保留旧正文，也没有备份。只是网络/模型失败，就会丢掉用户已有整理成果。

**复现：** 预置 `IMPORTANT-USER-NOTES`，注入模型请求失败。执行后文件只剩 fallback 标题、时间和失败说明，备份目录不存在。

**附带启动问题：** 新工作区设 `DREAM_ALLOW=true`，不存在 `.7coder` 时，`triggerDreamIfNeeded()` 写 `dream.lock` 抛 ENOENT，模型请求数为 0。迁移函数不会无条件创建目录。最外层 `main().catch(console.error)` 也没有明确设置失败退出码。

**建议：** Dream 异常只记录错误，绝不覆盖原笔记；成功后以备份＋临时文件替换提交。写锁前创建目录，使用排他创建避免并发检查/写入竞争；锁释放进入 finally。启动失败返回非零退出码。

**验收：** 模型失败、写入失败、初次启动、残留锁和两个进程并发；原文在失败后逐字节不变。

### A2-09｜auto_debug 启动失败使服务崩溃

**位置：** [index.js:2999–3016](D:/ai-workspaces/7coder/index.js#L2999)。

两条 `child_process.spawn()` 路径都未监听 `error`。不存在的可执行文件、缺失解释器等错误通过异步事件抛出，不会被外层工具的 try/catch 接住。

**真实 HTTP 复现：** 临时服务启用自动调试，mock 返回对不存在 `definitely-missing-review.exe` 的调用。没有启动真实 GUI。结果：

```text
请求：ECONNRESET
服务进程：exit 1
stderr：Unhandled 'error' event / spawn ... ENOENT
```

**建议：** 绑定 error/exit/close，等待明确的启动结果；失败作为工具结果返回，不能终止整个宿主。循环应在进程已退出时结束。达到修复上限时也不能无条件声称“Remaining issues: only warnings or benign”。

**验收：** 不存在的 exe、缺失解释器、退出非零、退出零但无输出；工具失败后健康接口和下一个聊天请求依然可用。

## 五、P2：可靠性、保密性与分发

### A2-10｜有 HTTP key 时待办接口仍匿名可读

**位置：** [index.js:3932–3938](D:/ai-workspaces/7coder/index.js#L3932)。

`GET /api/todos` 在鉴权前返回完整待办。临时服务设置 key 后，不带凭证访问 settings 得到 401，访问 todos 却得到 200 和 `CONFIDENTIAL-FAKE-TASK`。

这与历史“无 key 的个人本机服务不强制鉴权”是不同问题：**用户已经选择启用 key，新增私有内容接口却遗漏了检查。** 建议复用统一鉴权入口，只保留确有需要的最小公开健康信息；缺失、错误、正确 key 分别测试。

### A2-11｜tsc 配置错误被误报为 clean

**位置：** [index.js:2708–2715](D:/ai-workspaces/7coder/index.js#L2708)。

只解析 `file(line,column): error TS...`；`error TS18003: No inputs...` 等全局错误匹配不到。如果错误输出非空，又绕过当前异常判断，最终返回 `[DIAG] clean (0 problems)`。

**复现：** tsc shim 打印 TS18003 并退出 2，返回 clean。与 A2-03 使用同一夹具，但这里是独立的状态解析缺陷。

建议将非零退出且未解析到诊断视为“诊断执行失败/未知”，保留 stdout/stderr 摘要；支持全局 TS 错误。不要将“解析器没识别”映射为“没有问题”。

### A2-12｜单标签会话切换与保存响应存在竞态

**位置：** [webui.html:409–422](D:/ai-workspaces/7coder/webui.html#L409)、[webui.html:478–488](D:/ai-workspaces/7coder/webui.html#L478)、[webui.html:578–583](D:/ai-workspaces/7coder/webui.html#L578)、[webui.html:788–794](D:/ai-workspaces/7coder/webui.html#L788)。

两个 DOM 模拟均已复现：

1. A 正在回答，点击载入 B。`loadSessionFile()` 不检查 busy，替换了全局 history/sessFile。A 完成后将回答追加到 B，并自动保存 B。
2. 旧会话首次保存还未返回时点击“新对话”。新会话的保存被 autoSaving 丢弃；旧请求返回后把旧文件名写回 sessFile。下一次保存会把新内容写入旧存档。

第二个探针实际请求体为：

```json
{"messages":[{"role":"user","content":"new-conversation"}],"file":"OLD-MINTED.json"}
```

这是**单标签即可发生**的状态错误，不等同于历史已暂缓的多标签同步功能。建议为会话加不可变 generation/id；异步回调只修改所属会话。切换时明确取消/等待活动请求；保存队列合并最新快照，不能静默丢弃。

### A2-13｜记忆召回首条笔记可以突破全部预算

**位置：** [index.js:3505–3515](D:/ai-workspaces/7coder/index.js#L3505)。

预算判断附带 `&& picked.length`，因此第一条超额笔记仍全文插入。实测 `MEMORY_RECALL_CHARS=100`，召回文本达到 **16075 字符**。磁盘手动创建的笔记没有 save 工具的长度限制，实际可更大。

`MEMORY_MAX_FILES=20` 也只是“读取目录时截取前 20 个”，不是限制保存总数；保存成功的后续主题可能不出现在 list/自动召回中。

建议严格限制总加权单位，首条也截断并注明；保留标题/索引开销。索引和存储容量要采用一致契约。中文关键词连续无空格时召回质量另需测试，但本文不把其所有语言场景都判为必然失效。

### A2-14｜清空会话没有清空持久 shell

**位置：** [index.js:964–969](D:/ai-workspaces/7coder/index.js#L964)、[index.js:4605–4611](D:/ai-workspaces/7coder/index.js#L4605)。

shell key 固定为 main/agent-depth/wf-depth，没有会话标识。实测先 `export REVIEW_STATE=previous_conversation`，执行 `/clear` 后再次读取，仍返回 `previous_conversation`；cwd 也会类似残留。

不同的先后子代理均使用 agent-1；不同工作流也重用相同深度键。建议 clear、resume、fork 等边界明确 shell 处理策略；新子代理使用运行实例 ID，结束时释放。若刻意保留终端，应对用户明示，不能继续称为完全新会话。

### A2-15｜未完成的 SSE 被当作成功回答

**位置：** [index.js:1569–1576](D:/ai-workspaces/7coder/index.js#L1569)。

解析器看到过任意 choices 后，即使没有 finish_reason、没有完成标记，流一结束仍默认 `finish_reason: 'stop'`。

**实测：** 只发送一条 `unfinished-answer` 内容事件后 EOF，结果却为 stop。代理提前结束响应等场景会把残缺内容当作正常最终结果保存。

建议区分“明确完成”“EOF 中断”“业务错误”；中断向界面显示未完成状态，不保存为完整成功。另需覆盖首段已显示后网络失败重试的情形，避免重试将前缀重复写到客户端；本轮没有将该重试组合标为已动态复现。

### A2-16｜保存模型设置破坏无关的多行环境变量

**位置：** [index.js:4424–4440](D:/ai-workspaces/7coder/index.js#L4424)。

函数先解析整个 `.env`，再对所有 existing 键重写，而非只修改 updates。dotenv 解析后已经展开的转义换行直接被拼接为裸行，丢失原有引号语义。

**真实 HTTP 复现：** 原文件 `CUSTOM="first\nsecond"` 的解析值为 `first`＋换行＋`second`；只保存主模型名称后，CUSTOM 的解析值变成 `first`，接口仍返回成功。

建议只修改受管键，未知行逐字保留；为写入值实现与当前 dotenv 版本匹配的序列化。更新应先写临时文件并校验可重读，再替换正式配置。测试引号、转义、换行、重复键、注释及失败回滚。

### A2-17｜命令硬拦截在替代入口失效

**位置：** [index.js:3119–3121](D:/ai-workspaces/7coder/index.js#L3119)。关联：[index.js:1268–1273](D:/ai-workspaces/7coder/index.js#L1268)、[index.js:2642–2666](D:/ai-workspaces/7coder/index.js#L2642)、[index.js:2330–2343](D:/ai-workspaces/7coder/index.js#L2330)。

super-dangerous 检查仅覆盖 run_command/bash/powershell/task_create。run_tests、cron 的 command 不经过它；legacy MCP npx 又直接调用原始执行函数。

**隔离复现：** 用无害字符串 `echo mkfs REVIEW-NONEXECUTING-PROBE` 检查同一规则。run_command 被硬拒绝；run_tests 到达被替换的执行器。这里验证的是**入口不一致**，并没有运行真实危险操作，也不把字符串黑名单描述为完整沙箱。

建议所有命令执行入口调用相同的最后一道验证，并测试定时任务实际触发时的策略。继续保留规则的误报/漏报限制说明；不要只靠提示词补洞。

### A2-18｜审计日志明文记录结果中的敏感数据

**位置：** [index.js:381–387](D:/ai-workspaces/7coder/index.js#L381)、[index.js:3054–3066](D:/ai-workspaces/7coder/index.js#L3054)。

sanitizeAuditArgs 只处理 entry.args，`result`、`reason`、`argsPreview` 等路径不统一脱敏。对紧凑一行 models.json 的合法读取，会把 API key 写入日志首行。

**复现：** 使用假值 `review-FAKE-KEY`，读取后审计记录的 result 原样包含 `{"apiKey":"review-FAKE-KEY"}`。

历史 AST-04 对受保护文件名单和 Git 排除已有修复，但日志再次复制敏感值的问题仍在。建议敏感读取只记路径、长度、状态；其他结果经过统一脱敏；避免把“参数已脱敏”当成“整条事件已脱敏”。

### A2-19｜Windows 下 README 的 npx MCP 示例不能直接启动

**位置：** [index.js:248–252](D:/ai-workspaces/7coder/index.js#L248)；示例见 [README.md](D:/ai-workspaces/7coder/README.md)。

stdio 客户端直接 `spawn(cfg.command, args)`。本机 npx.cmd/npx.ps1 均存在，但 Node 24 与包内 Node 13 执行 `spawn('npx', ['--version'])` 都返回 **ENOENT**，还没进入 MCP 握手。

原有 MCP 测试启动的是 Node echo server，不覆盖 Windows 常见的 npm 命令 shim。建议支持显式运行 node＋npx-cli.js，或对 .cmd/.bat 采用经过严格参数处理的 Windows 启动器；不能简单把所有参数拼接后开 shell。给 Windows 和 Unix 分别提供已验证配置。外部依据 R2。

### A2-20｜扫描预算没有覆盖正则运算和全部遍历工作量

**位置：** [index.js:1121–1152](D:/ai-workspaces/7coder/index.js#L1121)、[index.js:1178–1228](D:/ai-workspaces/7coder/index.js#L1178)。

正面：新增大目录跳过、大小/二进制检查和匹配条目上限确实生效。剩余问题：

- grep 将模型字符串直接编译为正则，并在主线程同步匹配，没有运算预算。
- grep 没有深度/已访问真实目录限制；maxFiles 只计已实际读取的文本文件，不能限制大量空目录、跳过文件或环形联接的遍历。
- glob 的 maxEntries 计匹配结果，不是扫描条目总数。无匹配时仍可扫描大量文件。
- perFileCap 只在扫完整个文件后控制提示，未停止匹配计算。

**动态探针：** 仅 29 字节的 `a…a!` 文件，正则 `(a+)+$`，在隔离子进程中开始扫描后 1 秒仍未返回，被测试驱动终止。这个实验只证明该小输入已超出探针时限，不给出未经测量的最坏耗时。

建议区分文件数、目录数、访问数、输出数和执行时间预算；对遍历维护真实目录 visited 集合。正则需要可取消的隔离执行或受限语法，也可提供默认字面量搜索。

### A2-21｜打包清理失败后的延迟删除存在竞态

**位置：** [pack-offline.js:40](D:/ai-workspaces/7coder/scripts/pack-offline.js#L40)、[pack-offline.js:74–84](D:/ai-workspaces/7coder/scripts/pack-offline.js#L74)。

`rmrf(stage)` 首次失败后设置 300ms 的删除定时器，却立即返回。主流程继续 mkdir/copy。定时器随后运行时，目标仍是同一路径，可能删除已重建的内容；第二次失败又被吞掉，构建继续进行。

**证据等级：静态。** 本轮没有实际执行清理失败的打包，不把竞态描述为本机已经发生。

建议将清理设为同步重试或可 await 的阶段，重试耗尽立即失败；构建到唯一临时目录，成功后再发布。删除前验证绝对路径在预期 dist 范围内。补充 EBUSY/EPERM 故障注入，验证新目录不会在复制后被旧清理任务删除。

### A2-22｜安装示例和分发说明仍会误导用户

**位置：** [INSTALL.md](D:/ai-workspaces/7coder/INSTALL.md)、[README.md](D:/ai-workspaces/7coder/README.md)、[pack-offline.js:34–38](D:/ai-workspaces/7coder/scripts/pack-offline.js#L34)。

本轮文件对照确认：

1. INSTALL 的 API key 示例带行尾注释；布尔功能开关也使用 `true # 注释`。项目自己在 `.env.example` 说明 dotenv 8 不剥除这种行尾注释。复制后可能形成错误 key，或使 `=== 'true'` 的开关失效。
2. INSTALL 要求运行断言统计脚本，但打包白名单没有 scripts；现有 v2.18.0 解包目录也没有该脚本。
3. INSTALL 列出根目录 KNOWN-ISSUES.md，实际已在历史目录，且不进入离线包。
4. INSTALL 声称 dotenv 8.2.0；锁文件、当前安装和现有离线包实际都是 **8.6.0**。
5. README 页首仍为 v2.16.0；自动恢复说明出现空白占位 `to ) ... with  (or type )`；备份说明仍写最多 100，实际实现是每源文件 5、全局 200。
6. “凭证永远不可改写”等文案应与 default 模式的显式人工批准分支对齐，不要超出实现承诺。

建议将版本/依赖/包清单生成化；所有可复制 env 示例使用独占注释行；打包后验证文档引用的文件和命令确实存在。无需增加运行时依赖。

## 六、其他已观察到的边界与待补测项

以下不计入上面的 22 项，避免将所有疑点扩大为正式缺陷：

- **受保护文件的硬链接别名：** 假 models.json 与 alias.json 建立硬链接后，修改 alias 会改变原文件。已动态复现，但需要预植链接；这是按文件名保护的局限。应结合工作区信任策略决定是否拒绝多硬链接文件。相反，`.env.` 尾点探针在本机**没有**改写 `.env`，不得把它写成已证实绕过。
- **下载最后提交步骤：** [index.js:1991–1992](D:/ai-workspaces/7coder/index.js#L1991) 先 unlink 旧目标再 rename。中途下载失败保护已改好，但最终 rename 失败仍没有旧文件回滚；建议专门加提交失败故障注入。本轮未在真实文件系统上复现该最后阶段故障。
- **模型发现：** 实际 HTTP 对照发现 `/api/info` 使用完整 modelList，而 `/v1/models` 只列 heavy/light，漏掉 profile 模型；客户端自动发现列表不一致。可作为小修项处理。
- **cron 重叠：** [index.js:1268–1293](D:/ai-workspaces/7coder/index.js#L1268) 在上一次命令结束前可再次启动，而 job.child 只留一个句柄；老回调还会把新句柄清空。应补重叠、删除时活动实例、退出时全实例清理测试。不要把本轮受限环境的 cron-treekill 失败直接归因于这个独立路径。
- **结构化输出：** 当前仅校验顶层 required/type，不能等同于完整 JSON Schema；嵌套属性、数组 items、enum 和 null/object 的区别仍需完善契约。
- **内存/磁盘资源：** 普通 read_file 在 offset/limit 前整读，网络 GET 默认整缓冲，持久 shell 在命令期间持续累积输出，Web 会话保存没有与 CLI 相同的保留上限。建议单独做资源压力测试。
- **真实模型与平台：** mock 不能验证模型对工具 schema 的理解、真实流协议差异、费用行为或 Windows 7 API 支持；未将本机 Node 13 通过夸大为 Win7 实机通过。

## 七、历史结论复核与已明确的产品决策

### 7.1 已修复部分继续认可，但关闭范围需要精确

| 旧项 | 本轮判断 |
|---|---|
| AST-01 Git shell 注入 | 当前 git helper 使用 execFileSync 参数数组；不重复报旧 shell 注入 |
| AST-02 自动日志路径绕过 | 原归一化与受保护 basename 检查仍在；新增 memory 路径绕过是 A2-01，不等同旧例子复发 |
| AST-03 工作流/请求串线 | 请求门仍串行化聊天，旧回归通过；规则加载和取消传递是另外的缺口 |
| AST-04 models.json 与 Git | 名单、`.7coder/` 排除已实现；结果日志脱敏仍需 A2-18 |
| AST-05 下载失败删原文件 | 临时文件方案保护了下载失败阶段；不要将其描述成所有提交阶段都已事务化 |
| AST-06/07 Web 首存和 SSE 错误 | 现有 DOM 8 项通过；并不覆盖错误转义和延迟保存/切换竞态 |
| AST-08 env 注入 | 新输入的 CR/LF/NUL 校验存在；A2-16 是旧配置重序列化的独立问题 |
| AST-09 异步执行与取消 | 异步化有效；bypass、子代理、持久 shell 等取消缺口仍在 |
| AST-10 请求体限制 | 当前公共读取器会拒绝超限并停止累积，相关回归通过 |
| AST-11 工具失败统一 | 有统一正则，但不是完整状态协议；run_tests 失败仍漏判 |
| GAP-2/5/9/14、P2-3 | 新功能基本路径通过；本轮揭示的是组合与边界场景，不否认基础功能已实现 |

### 7.2 不擅自重开既有决策

统一日志中，免 key 本机服务、界面返回配置 key、大规模模块拆分、多标签执行上下文和真实 tokenizer 等已有不修/暂缓记录。

本轮再次用临时无 key 服务验证：带任意 Origin/Host、text/plain 的模式变更请求仍返回 200。这与已记录的 OPT-2 证据一致，**不是本轮新增问题，也不自行把“免 key”改成强制鉴权**。若未来扩大部署范围，再按既有重开条件处理 Origin/Host、CSRF 与绑定地址政策。外部依据 R3。

同样，不建议为了本报告立刻放弃 Win7/Node 13 目标。兼容验证与安全维护是不同维度；旧运行时用于明确受信任、隔离的兼容场景，现代系统可另提供较新运行时分发。运行时维护状态应以官方 EOL 信息为准（R5）。

## 八、测试与工程改进建议

### 8.1 为什么 B 215/215 仍漏掉这些问题

现有测试对“曾经修过的那个例子”覆盖较好，但不少新功能只测理想路径：

- fork：只用纯文本回合，没测 assistant/tool 完整配对。
- memory：只测普通目录，没测 junction、protected_extra、超额首条笔记。
- permissions：没覆盖两层配置、同字符串、相反 bucket。
- diagnostics：使用受控 tsc shim 验证行格式，没测试免审批副作用和无文件定位的错误。
- DOM：当前把“并发保存请求被丢弃”当作通过条件，没有验证最终最新版会话确实落盘。
- MCP：echo server 是原生 Node 启动，不覆盖 Windows npm shim。
- workflow：文本错误格式覆盖扩充了，但测试工具退出码没有接入失败契约。

这些不是多跑几遍同样的测试就能发现的问题，需要添加新的反例。

### 8.2 最小工程改造

1. **工具声明收口。** 一个元数据表集中声明：是否执行代码、读写哪些资源、是否支持取消、是否可并行。避免 AUTO_SAFE、风险表、变化表和失败正则各自漂移。
2. **统一 ToolResult。** 先在 run_tests、diagnostics、workflow 之间引入结构化状态，保留旧文案兼容；无需一次重写全部工具。
3. **统一文件访问门。** 用户路径和内建状态路径都要有明确根目录与真实路径策略，不因“路径是程序自己拼出来的”就跳过检查。
4. **统一取消契约。** 以小型上下文对象替代不断增长的位置参数，减少少传最后一个参数造成的静默问题。
5. **统一会话所有权。** 每个异步请求绑定所属会话 ID，避免回调修改已切换的全局变量。
6. **可发现测试入口。** 当前 npm test 只跑 A，B 单独入口，C–J 无总入口。增加离线总入口、可选桌面测试入口和明确的真实端点入口；K/R 保持显式启用。
7. **测试替身的边界。** 保留轻量 DOM 单测，但增加少量真实浏览器测试验证 XSS、剪贴板、取消、中文输入法和会话切换。模拟 DOM 不应被描述为浏览器级验证。
8. **避免仅做正则静态覆盖。** 工具 schema、实现分支、权限表的一致性校验应验证“至少解析到若干真实项”；避免空集合也通过。覆盖率不能只靠搜索 record 调用数。

这些建议不要求突破“运行时只保留 axios、dotenv”这一现有约束；测试与构建辅助能力可以单独管理。

## 九、建议修复顺序与完成定义

### 第一批：授权与数据止损

A2-01、02、03、04、08、09。

完成定义：未批准的代码执行/越界记忆写入不再发生；网页错误只显示文本；模型/启动失败不丢笔记、不杀宿主服务；每项新增反例先红后绿。

### 第二批：任务执行闭环

A2-05、06、07、11、15、17。

完成定义：fork 后消息配对合法；所有权限模式都能取消；失败测试停止非可选工作流；未知诊断不是 clean；流中断不是成功完成。

### 第三批：会话、资源和分发

A2-10、12、13、14、16、18、19、20、21、22。

完成定义：单标签会话不串档；已启用 key 的私有接口拒绝匿名；预算实质生效；清空会话的终端策略明确；配置可往返解析；Windows MCP 示例可启动；打包失败不发布不完整产物，包内说明可直接执行。

### 发布前验证

- 在可正常管理子进程的 Windows 环境重跑本轮五个未确认失败断言。
- A–J 离线套件与 DOM 套件执行并保留真实结果；桌面注入测试显式选择，不偷偷操作用户桌面。
- Node 13 与现代 Node 至少覆盖权限、记忆、fork、取消、MCP 启动及配置序列化的新反例。
- 以离线包内容运行包内烟雾测试，而非只测试源码目录。
- 需要时再单独授权真实模型补测，不把历史真实测试结果算作本轮结果。

## 十、证据索引与外部依据

### 10.1 本地证据

所有路径位于审阅缓存内，均不包含用户真实密钥：

- 基础与双运行时日志：`D:\ai-workspaces\7coder\.cache\astra-review-2\suite-*-node*.log`
- 原有 DOM 结果：`D:\ai-workspaces\7coder\.cache\astra-review-2\webui-dom-sim.log`
- 主要隔离探针：`D:\ai-workspaces\7coder\.cache\astra-review-2\probes.js`
- 主要复现结果：`D:\ai-workspaces\7coder\.cache\astra-review-2\probe-results.json`
- 权限合并、日志、shell 等：`D:\ai-workspaces\7coder\.cache\astra-review-2\probe-extra-results.log`
- 实际 HTTP 探针及结果：`D:\ai-workspaces\7coder\.cache\astra-review-2\probes-http.js`、`D:\ai-workspaces\7coder\.cache\astra-review-2\http-probe-results.json`
- 前端状态复现：`D:\ai-workspaces\7coder\.cache\astra-review-2\dom-probe-results.log`
- SSE 与统计结果：`D:\ai-workspaces\7coder\.cache\astra-review-2\summary-probe-results.log`
- 正则运算预算结果：`D:\ai-workspaces\7coder\.cache\astra-review-2\grep-probe-results.log`

注意：探针中也保存了阴性/对照结果，如 `.env.` 没有改写原文件、同一配置文件内 deny 优先正常，不能把日志中每一项都算成漏洞。临时探针不是正式回归套件；合入修复时应迁移成可维护、具备清理机制的测试。

### 10.2 外部技术依据

外部资料仅用于解释平台/安全机制，不替代本地源码与复现。查阅日期：2026-10-04。

- **R1｜MDN：Element.innerHTML**。HTML injection sink 的安全注意事项；对应 A2-04。`https://developer.mozilla.org/en-US/docs/Web/API/Element/innerHTML`
- **R2｜Node.js：Child process**。spawn 的 error 事件、Windows .cmd/.bat 启动、kill 与子进程生命周期；对应 A2-03/06/09/19。`https://nodejs.org/api/child_process.html`
- **R3｜OWASP：Cross-Site Request Forgery Prevention Cheat Sheet**。简单请求与 Content-Type/Origin 防护；对应既有 OPT-2 风险说明。`https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html`
- **R4｜ESLint：Configuration Files**。项目 JavaScript 配置加载机制；对应 diagnostics 信任边界。`https://eslint.org/docs/latest/use/configure/configuration-files`
- **R5｜Node.js：End-Of-Life**。运行时维护状态与风险边界。`https://nodejs.org/en/about/eol`

---

**最终判断：** 7coder 的主功能已经能工作，现有测试也有实质价值；当前最需要的不是再增加功能数量，而是使新功能真正服从已有的权限、取消、失败和持久化契约。本报告保留已完成修复的认可，同时以可复查反例说明仍未闭合的边界。
