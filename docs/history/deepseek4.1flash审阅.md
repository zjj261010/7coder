# 7coder 代码审阅报告（deepseek4.1flash）

> 审阅对象：`index.js`（全 3345 行）、`webui.html`、`package.json` / `.env.example` / `.gitignore` / `.npmignore`、
> `README.md` / `INSTALL.md` / `KNOWN-ISSUES.md` / `REVIEW-CHECKLIST-2026-09-30.md`、
> `test/`（runner.js 及 runner-b~r、mock-server.js、chaos-mock.js）、`scripts/pack-offline.js`、`dist/` 打包产物、`LICENSE`。
> 审阅方式：纯静态阅读（完整通读 `index.js` 全部 3345 行）+ 与既有 `REVIEW-CHECKLIST-2026-09-30.md` / `KNOWN-ISSUES.md` 逐条比对。
> 本次未运行测试、未修改任何文件（除本报告）。
>
> **说明**：本文与既有审阅清单**不重复**。既有清单中已确认修复的条目（cron `every 0h` 崩溃、`run_tests_tool` 字面 `'\n'`、
> `writeWorkspaceEnv` 注释丢失、webui 模型/模式持久化、`--prompt ""` fail-fast）本次复核**已确认修复**，不再列出；
> 仍存在的本清单会标注「沿用」并给出当前行号（代码已增长约 240 行，旧行号多数已漂移）。

---

## 〇、更正声明与实证结果（2026 追加）

### 更正：初稿的 P0-1「8 个工具全部不可达」是**错误的**，已撤回

初稿把 `index.js:1624`–`1663` 的括号归属判断错了，据此断言 8 个工具不可达。**该结论完全错误。**
本会话获得完整权限后已实证：

| 证据 | 结果 |
|---|---|
| `node --check index.js` | 退出码 **0**（语法正确） |
| `executeToolRaw.toString()` | **889 行**，且**包含** `parseTestOutput`、`if (name === 'run_tests_tool')`、末尾 `return \`Unknown tool: ${name}\`` |
| `node test/runner-b.js` | **93/93 全绿**，含 `git: commit created with requested message + snapshot recorded` |

结论：`index.js:1663` 的 `  }` **就是** `if (name === 'workflow_tool') {`（`1624`）的闭括号
（`1620`–`1622` 的 `computer_use` 分支收尾同样是 2 空格的 `  }`），`1665` 之后的全部内容都位于
`executeToolRaw` 的**函数顶层**。**8 个工具全部可达、全部正常。**

**错误根源**：我仅凭缩进外观推断括号归属（`1665`–`1729` 的辅助函数被写成 0 缩进，`1686`–`1906` 的工具分支写成 2 缩进），
且自己写的花括号计数脚本被模板字符串与正则字面量干扰，给出 `d=1` 的错误深度，**把错误结论"独立证实"了一遍**。
**教训**：缩进不是语法；括号归属必须用 AST 或运行时反射判定，不能靠肉眼 + 自制正则。

### 实证：测试套件真实结果（Node v24.19.0，本机全量执行）

| 套件 | 结果 | 套件 | 结果 |
|---|---|---|---|
| A `runner.js` | **74/74** | F `runner-f.js` | **23/23** |
| B `runner-b.js` | **93/93** | G `runner-g.js` | **29/29** |
| C `runner-c.js` | **35/35** | H `runner-h.js` | **32/32** |
| D `runner-d.js` | **32/32** | I `runner-i.js` | **34/34** |
| E `runner-e.js` | **22/22** | J `runner-j.js` | **16/16** |

**合计 390/390 全绿，零失败。** 另有：
- `runner-k.js`：未设 `REAL_TEST` 时打印 SKIPPED 并 **退出 0**（按设计跳过）。
- `runner-r.js`：**1/10**，9 条失败，退出码 1 —— **见 P1-12**，这是本次唯一实测失败的套件。

**据此对既有文档的判定**：`KNOWN-ISSUES.md:86` 记「A(74)/B(74)/C(35)/D(32)/E(22)/F(23)/G(29)/H(32)/I(34)/J(16) = 373 项」
—— **A 与 B 的计数过时**：A 现为 74（一致），**B 现为 93（文档写 74）**，其余八项逐项一致。**实测合计 390 项**，不是 373 项。

---

## 一、结论摘要

代码整体质量高于同类单文件 AI CLI：权限四模式、路径沙箱 fail-closed、受保护文件、审计日志、
上下文压缩配对安全、断连取消、Windows 代码页处理等都有真实实现与注释说明，工程意图清晰。

**本会话已获完整权限并实测 12 个测试套件：A–J 全部通过，合计 390/390 全绿，零失败**（详见第〇节）。

初稿的 P0-1「8 个工具全部不可达」已被实证**推翻并撤回**——那是我的误判，不是产品缺陷。
真正成立的 P0 是 **3 项安全/并发问题**，均为既有清单已提出但**至今未修**的项。

| 等级 | 数量 | 概述 |
|---|---|---|
| **P0 严重** | 3 | 平台密钥明文 HTTP 下发；审批桥全局单例并发串扰；服务端无 key 时管理接口全裸 |
| **P1 中** | 16（含 1 项已撤回） | 审计日志串会话、git 状态口径错误、TOCTOU、退出码恒 0（**已实测复现**）、静默空读、SendKeys 转义顺序错、`ask_user` 在服务端挂起、`runner-r.js` 实测 1/10 等 |
| **P2 低** | 12 | 备份上限导致跨文件误删、grep 无大小上限、同步 IO 阻塞事件循环、错误前缀正则耦合、死代码、平台分支未测等 |
| **测试套件** | 12 | 假绿退出码（实测未触发，但仍是结构性隐患）、孤儿 runner（**已实测失败**）、恒真断言、盲等而非就绪探测、POSIX 不兼容、残渣不清理、破坏性 junction 用例等（详见第七节） |
| **建议** | — | 单一声明表、错误契约、安全收口、结构拆分、测试补齐、文档对齐 |

### 验证等级图例

初稿写作时本会话 shell 被 Windows 文件权限拒绝（`SetNamedSecurityInfoW failed (Win32 5)`），无法执行任何代码；
**后续已获完整权限并完成实测**，因此下表标签区分证据来源：

| 标签 | 含义 |
|---|---|
| **[测]** | **本会话实际执行命令得到的结果**（最可信，本次新增） |
| **[读]** | 我本人用 read 工具直接读到该行原文（引文与行号可逐字复核） |
| **[推]** | 基于已读到的代码做的逻辑推演，**未经执行验证**（若推演有误，结论即不成立） |
| **[转]** | 来自子代理对 `test/` 的审阅报告，我只抽查了其中一部分，**多数行号未经我逐条核对** |
| **[档]** | 来自仓库既有文档（`KNOWN-ISSUES.md` 等）的转述 |
| **[待]** | 明确标注为需人工复核、本次无法判定的项 |

**关于 `[推]` 的警告**：初稿唯一的 `[推]` 级重磅结论（P0-1）就是**错的**，而且它当时看起来"证据充分"。
请对本文中所有未标 `[测]` 的结论保持同样的怀疑。

---

## 二、P0 — 严重问题

### P0-1 ~~工具分发结构性失效~~ **【已撤回 — 我的误判】**

> **结论：此项不成立，是我的分析错误。** 初稿据此断言「8 个工具不可达」，**完全错误**，详见文首「更正声明」。
>
> 实证：`executeToolRaw.toString()` 共 889 行，**确实包含** `parseTestOutput`、`run_tests_tool` 分支与末尾的
> `Unknown tool` 返回；`index.js:1663` 的 `}` **就是** `if (name === 'workflow_tool') {`（`1624`）的闭括号
> （`1620`–`1622` 的 `computer_use` 分支收尾同样是 2 空格的 `  }`，与 `1624`/`1663` 一致）。
>
> 因此 `1665` 之后的所有内容都位于 `executeToolRaw` 的**函数顶层**，8 个工具全部可达、全部正常。
> `node test/runner-b.js` 实证 **93/93 全绿**，含 `git_commit_tool` 真实建出提交。
>
> **错误的根源**：我仅凭缩进外观（`1665`–`1729` 的辅助函数与工具分支写作 0 缩进）推断括号归属，未做解析验证；
> 自己写的花括号计数脚本又被模板字符串与正则干扰，给出 `d=1` 的错误深度，把错误结论"证实"了一遍。
> **教训**：缩进不是语法；判定括号归属必须靠 AST/反射，不能靠肉眼。

---

### P0-2 **[读]** `GET /api/settings` 与 `GET /api/models-config` 明文下发平台密钥

**位置**：`index.js:2818`–`2832`（`GET /api/settings`）、`index.js:2860`–`2869`（`GET /api/models-config`）

```js
2818  if (req.method === 'GET' && req.url === '/api/settings') {
2819    if (HTTP_API_KEY && req.headers.authorization !== `Bearer ${HTTP_API_KEY}`) { ...401... }
...
2830    res.end(JSON.stringify({ endpoint: OPENAI_ENDPOINT, apiKey: OPENAI_API_KEY || '', model: HEAVY_MODEL, profiles }));
```

`/api/models-config`（`2867`）更直接把整个 `modelProfiles` 原样返回，其中每个 profile 都含 `apiKey`。

**问题**：`HTTP_API_KEY` **默认未设置**（`.env.example:42` 为空）。此时这两个 GET 接口**没有任何鉴权**，
且默认只要服务在跑就可达；`HTTP_BIND=0.0.0.0` 时（`.env.example:38-40` 明确允许的 LAN 用法）
任何网络内主机都能直接读走上游 OpenAI/中转站的**明文密钥**，可被用于盗刷。本机场景下也存在
DNS rebinding / 任意本地进程读取的风险（既有清单 P0-4 已提出，**本次复核仍未修复**）。

**修复建议**：
- 默认只返回 `apiKeySet: true/false` 与掩码 `sk-…尾 4 位`；完整密钥永不下发。
- 保存时约定「留空 = 不修改」，前端不再回填真实密钥（`webui.html:666`、`677` 改为占位符）。
- `GET /api/models-config` 同样掩码，或与 `/api/settings` 合并并统一加鉴权。
- 未设 `HTTP_API_KEY` 时，对所有**写操作类**以及**任何回显配置**的 `/api/*` 默认拒绝（而非仅靠 loopback 信任）。

---

### P0-3 **[读]** HTTP 审批桥为全局单例，并发流式请求互相摘桥 / 审批串线

**位置**：`index.js:2149`–`2152`、`index.js:3001`–`3013`、`index.js:3020`；`askApproval` 见 `2154`–`2165`

```js
2149  var httpApprovalBridge = null;      // <-- 模块级单例
2150  var httpApprovalRefs = 0;           // <-- 声明后从未被读写（死代码）
...
3001  httpApprovalBridge = { ask: function (question) { ... pendingApprovals.set(id, resolve) ... } };
3018  const result = await processWithTools(...);
3020  httpApprovalBridge = null;          // <-- 任一请求结束就摘掉全局桥
```

**问题**：
1. 两个并发流式客户端时，后到的请求**覆盖**前者的 bridge，先到者的审批请求会被投递到错误连接的 SSE 流。
2. 任一请求完成即把全局桥置 `null`（`3020`），此时仍在运行的另一请求**审批静默丢失**——
   `askApproval` 回落到 `2158` 的非交互分支直接 `return false`，表现为「模型的所有工具调用被莫名拒绝」。
3. `pendingApprovals`（`2152`）是全局 `Map`，`id` 用自增序号（`3004`），跨连接可被枚举/抢答
   （`POST /api/approve`，`2707`–`2732`，仅校验 id 是否存在）。
4. `KNOWN-ISSUES.md` C7 声称「6 并发零串扰」，但该场景**未覆盖审批路径**——这正是盲区所在。

**修复建议**：bridge 与 `pendingApprovals` 改为**按请求创建**，经 `processWithTools` 的 `opts` 传入（例如 `opts.approval`），
`askApproval(question, ctx)` 优先使用请求级 ctx；`id` 改为「连接随机前缀 + 序号」防止跨连接抢答。
删除死变量 `httpApprovalRefs`。

---

### P0-4 **[读]** 未设 `HTTP_API_KEY` 时，全部管理/副作用接口无鉴权（且 `.env.example` 引导用户暴露到 LAN）

**位置**：`index.js:2603`（`GET /`、`/ui`）、`2614`（`GET /api/info`）、`2619`（`GET /v1/models`）、
`2766`（`POST /api/open`）、`2905`（`POST /api/mode`）、`3070`（`writeWorkspaceEnv`）

这些接口的鉴权写法是 `if (HTTP_API_KEY && ...)`——**只有设置了 key 才校验**。默认无 key，于是：

- `POST /api/mode`（`2905`）可把权限模式**远程切换为 `bypass`**，此后 AI 的一切命令/文件操作免审批；
- `POST /api/open`（`2766`）在服务端宿主上拉起资源管理器/编辑器；
- `POST /api/settings`（`2833`）会调用 `writeWorkspaceEnv`（`3070`）**改写工作区 `.env`**，把攻击者指定的 endpoint/apiKey 写进去，
  实现「把 AI 的上游指向攻击者端点」——这是比读密钥更严重的一步（可完全劫持后续对话与工具结果）。

代码在 `2595`–`2600` 对非 loopback 绑定**只做了 `console.warn`**，`.env.example:38-40` 又明确指导用户
「Only use 0.0.0.0 for LAN access」，两步组合等于把上述能力直接放到局域网。

**修复建议**：
- 无 `HTTP_API_KEY` 时，非 loopback 绑定应**拒绝启动**（fail-closed），或至少把所有写接口默认拒绝并返回明确指引；
- `POST /api/mode` 切到 `bypass` 增加二次确认（webui.html:745 已有前端 `confirm`，但后端不能只依赖前端）；
- 为 `/api/*` 引入统一的 `requireAuth()` 前置，避免逐接口复制粘贴 `if (HTTP_API_KEY && ...)` 时漏写。

---

## 三、P1 — 中等问题

### P1-1 全仓无 lint / 语法守护，缺少结构性回归拦截
**位置**：`package.json:27`–`32`（scripts 仅 `start`/`server`/`test`/`test:b`）

无 `eslint`、无 `tsc`、无 CI 配置，`package.json:27`–`32` 仅注册了 A/B 两个套件。此类工具最需要的是静态检查与「断言数为 0 即失败」的护栏（见 T1）。
**只有断言能发现**；现有测试虽覆盖了这些功能，但既然缺陷在库中，说明对应断言并未真正执行到这 8 个工具。
**建议**：加入最小 `eslint`（含 `no-unreachable`、`no-fallthrough`、`indent`）与一条「8 个工具逐个冒烟断言」，
并在打包脚本前置 `node --check index.js`。

### ~~P1-2~~ **【已撤回 — 我的误判】** 快照「从未生成」（残留：一处静默吞错）

> **结论：初稿的三条指控全部不成立。** 我实测了完整链路，快照机制**工作正常**。

**实测证据（`[测]`）**：在临时 git 仓库中按 `index.js:1781` 的原样逻辑执行——

| 我的初稿指控 | 实测结果 |
|---|---|
| 「`refs/.../snapshots/<sha>` 前缀自带冒号，ref 名非法，`update-ref` 必然失败」 | ❌ **错**。`git check-ref-format "refs/7coder/snapshots/<sha>"` **退出码 0**（冒号不在禁列） |
| 「`-m "..."` 的双引号被 `cmd.exe` 吃掉，`-m` 只拿到 `7coder`」 | ❌ **错**。经 `cmd /c` 原样执行 **退出码 0**；`git for-each-ref` 显示 `refs/7coder/snapshots/3445dcd6…` 已创建，`rev-parse --verify` 解析成功 |
| 「快照对象会被 gc、无法恢复」 | ❌ **错**。`git cat-file -t <sha>` 返回 `commit`，对象被 ref 锚定、可长期恢复 |

`node test/runner-b.js` 中 `git: commit created with requested message + snapshot recorded` 也**实测通过**（93/93）。
顺序亦正确：先 `stash create` 抓取工作区状态，再 `add -A` + `commit`。

**残留的低危问题（唯一成立的一点）**：`index.js:1781` 的 `catch (e) {}` 会静默吞掉真实失败，
而 `snapshot` 变量照旧赋值 ⇒ 返回文案仍宣称 `(snapshot … recorded for recovery)`。
即**失败时不会告知用户**。建议在该 `catch` 中记录并回报失败（这是健壮性问题，不是功能缺失）。

**同时暴露一个测试弱点**：`runner-b.js:787` 的断言只检查输出里**含字符串** `snapshot`，
**未校验 ref 是否真的存在** —— 属假阳性断言，建议补 `git rev-parse --verify refs/7coder/snapshots/<sha>`。

### P1-2 自动生成的提交信息来自**全工作区历史**审计日志，而非本次会话
**位置**：`index.js:1769`–`1775`

读取 `.7coder/audit.jsonl` 并统计**全部** `type: "tool"` 行。该文件是**跨会话累积**的（仅在 5 MB 时才轮转，`198`），
于是新仓库/新任务的提交信息会引用几个月前别的任务的工具名（如 `tools: read_file, run_command, edit_file`），完全无信息量。
**建议**：审计条目增加 `session`/`runId` 字段，提交信息只统计本次会话；或直接改用 `git diff --stat` + 变更文件清单生成信息。

### P1-3 `git_status_tool` 的 staged/modified 口径错误（同一文件重复计数）
**位置**：`index.js:1739`–`1744`

```js
const x = l.charAt(0), y = l.charAt(1);
if (x !== " " && x !== "?") counts.staged++;
if (y === "M" || x === "M") counts.modified++;
```

对 `"M "`（已暂存的修改）：`staged++` 且 `x === "M"` ⇒ `modified++`，两项都 +1；
对 `"MM"`（暂存后又改）同样双计。报告数字与 `git status` 直觉不符（既有清单 P2-11 提出，本次仍在）。
**建议**：按 XY 分列统计（staged 看 X、worktree 看 Y），并在输出中标注口径。

### P1-4 路径校验存在 TOCTOU：校验用 realpath，实际读写用未解析路径
**位置**：`index.js:458`–`467`（`sanitizePath`）、`1074`–`1091`、`1093`–`1110`

`sanitizePath()` 内部用 `realPathSafe()` 解析符号链接后判定是否在沙箱内，但返回的是 `path.relative(base, real)`，
调用方再 `path.join(launchDir, ...)` **重新拼出路径**并读写（`1076`、`1085`、`1095`）。
若在校验与写入之间把某级目录替换为指向沙箱外的 junction/软链接，写入会落到沙箱外。
（注：`realPathSafe` 的 fail-closed 与深度守卫本身写得很好，问题在「校验结果未被使用」。）
**建议**：`sanitizePath` 直接返回**已解析的绝对路径**（或返回 `{ rel, real }`），读写一律使用该 real 路径；
Windows 上写文件前对目标父目录再 `lstat` 一次拒绝 reparse point。

### P1-5 **[测] 已实测复现** one-shot 失败时退出码仍为 0（沿用旧清单 P1-14，仍未修）
**位置**：`index.js:84`–`89`（`flushExit`）、`2565`–`2568`（`executeTask` 的 catch）、`3160`

`executeTask` 的 catch 设置了 `process.exitCode = 1`，但 `3160` 的 `flushExit(0)` **硬编码 0**，把错误码丢弃 ⇒
脚本化调用（CI/批处理）无法感知失败。

**实测**：
```
$ $env:OPENAI_ENDPOINT='http://127.0.0.1:1/v1'; node index.js --prompt "hi"
[WARN] API attempt 1/1 failed: connect ECONNREFUSED 127.0.0.1:1
[ERROR] Error: Max retries reached.
EXITCODE=0        <-- 任务彻底失败，退出码仍是 0
```
**建议**：`flushExit(code)` 内部改为 `process.exit(process.exitCode || code || 0)`，或在 `3160` 传 `process.exitCode || 0`。

### P1-6 `read_file` 越界/空文件静默返回空串；二进制文件不设防
**位置**：`index.js:1059`–`1073`

`offset` 越界或 `limit` 为 0 时返回 `''`，模型无法区分「文件为空」「越界」「读失败」——配合 `systemPrompt:398`
「读被截断的文件禁止整写」的告诫，空串反而可能诱导模型整文件重写。
另外 `fs.readFileSync(fullPath, 'utf8')` 对二进制文件（图片/`.exe`/`.zip`）不做检测，返回大量 U+FFFD，
白烧上下文（`capToolResult` 只截长度不判内容）。
**建议**：返回空时给出显式说明（`(empty file)` / `(offset beyond EOF, file has N lines)`）；
读取前检查扩展名或前 4 KB 是否含 NUL，命中则返回「疑似二进制，已拒绝读取，请用 download/命令处理」。

### P1-7 `computer_use` 的 `type_text` 未走 `escapeSendKeys` 即写入 ps1 双引号命令
**位置**：`index.js:1590`–`1600`

```js
`[System.Windows.Forms.SendKeys]::SendWait('${escapeSendKeys(args.text).replace(/'/g, "''")}')\n`
```
外层是**双引号** shell 字符串（`1567` `execSync(\`powershell ... -File "${file}"\`)` 那条路径写入 `input.ps1`，
本身没问题），但 `input.ps1` 内容用单引号包裹：文本中的 `'` 已翻倍、SendKeys 元字符已转义——**这一处是对的**。
真正的问题是 `escapeSendKeys`（`1569`–`1571`）的**变换顺序反了**：它**先**转义元字符
（`([+^%~(){}[\]]) → {$1}`，`1569`–`1570`），**后**才把换行替换成 `{ENTER}`/`{TAB}`（`1571`）。
于是 `{ENTER}` 里新插入的 `{` `}` 是**生**的，逃过了元字符转义；而用户文本里原本的 `{`
已被转成 `{{}`。两者混在一串里语义不同却外观相同，SendKeys 解析结果取决于组合：

- `type_text("a\nb")` → 最终 `a{ENTER}b`（正确）；
- `type_text("{ENTER}\nx")` → `{{}ENTER}{ENTER}x`，其中的 `{ENTER}` 被解释为**按键**，等于凭空多按一次回车。

**建议**：改为「先把控制字符映射为 `{XXX}` 占位，**最后**统一对结果做一次元字符转义」，
或直接逐字符白名单映射，彻底消除顺序歧义。

### P1-8 `ask_user_question_tool` 在服务端模式下会**挂起 2 分钟/永久**
**位置**：`index.js:1301`–`1307`、对比 `askApproval:2154`–`2165`

```js
if (DANGER_MODE || effectivePermissionMode() === 'bypass') return 'Question skipped in non-interactive mode';
const answer = await new Promise(resolve => rl.question(`${args.question}\nAnswer: `, resolve));
```
**问题**：它**没有** `INTERACTIVE` 判断（`askApproval:2158` 有）。`INTERACTIVE` 在 `303` 定义为
`!promptArg && !serverMode && !backgroundMode`，所以 `--server`（`3148` 已 `close()`，由 `1303` 拦住）与
`-p/--prompt`（`promptArg` 非空 ⇒ 非交互）两条路**都是安全的**。
真正的裸露面是：`ENABLE_HTTP_SERVER=true` 由**环境变量**开启、命令行却没带 `--server` 时，
`serverMode=false` 且 `promptArg=null` ⇒ `INTERACTIVE=true`，而 stdin 是**管道**（服务化部署、`< /dev/null`、CI）。
此时 `rl.question` 会在 EOF 后**不回调**（项目在 `3106`–`3109` 自述了 Node 13 这一行为），
`await` 永久挂起并卡死该任务/请求（无超时）。`ask_user_question_tool` 又不在 `AUTO_SAFE_TOOLS`（`311`），
`auto` 模式下需先过一次轻模型审批才会走到这里。
**建议**：与 `askApproval` 统一守卫：`if (!INTERACTIVE || rlClosed) return '...用户不可达，请自行决策并在最终答案说明...'`
（沿用旧清单 P2-15 的措辞建议），并为 `rl.question` 统一加超时兜底。

### P1-9 流式响应固定回显 `HEAVY_MODEL`，忽略请求指定的 `model`
**位置**：`index.js:2992`（`writeChunk` 内 `model: HEAVY_MODEL`）、对比 `2964`（`reqModel` 已解析）

客户端请求 `model: "qwen3.8-max"`（`2964` 已正确取用并传给 `processWithTools`），但 SSE 每个 chunk 的 `model` 字段
都写死 `HEAVY_MODEL`。多模型 UI（`README.md:176`「web UI model dropdown」）读到错误模型名。
**建议**：`writeChunk` 闭包捕获 `reqModel`。

### P1-10 `flushExit(0)` 与「摘要/7CODER.md 写入」的竞态（非流式与 CLI 路径）
**位置**：`index.js:3028`、`3036`、`3159`–`3160`

CLI 一次性模式：`executeTask()` 内部已 `await` 摘要与 `updateCompleteSummary`，这条 OK。
HTTP 流式路径：`res.end()`（`3027`）**之后**才 `await summarizeAction(...)` + `updateCompleteSummary(...)`（`3028`–`3029`）——
客户端已收到 `[DONE]`，而 7CODER.md 的写入仍在进行；若此时进程退出（`/bye`、容器终止）会**丢失摘要**，
且该 `await` 位于外层 try 之外的部分分支中，异常会打到 `3051` 的 catch 走「已发送响应头」分支，用户看不到任何提示。
**建议**：摘要写入与响应解耦为后台任务（带自身 catch 与日志），或至少在 `res.end()` 前完成。

### P1-11 `download_tool` 无域名/内容校验，与 `run_command` 组合构成远程代码执行链
**位置**：`index.js:1212`–`1242`

仅校验「URL 以 http(s) 开头」和 500 MB 上限，不限制目标主机、不校验内容哈希/签名。
`download_tool` 是 `MEDIUM` 风险（`2077`），在 `auto` 模式下由轻模型判断即可放行；随后 `run_command` 执行下载物
（`README`/`systemPrompt` 都在鼓励「下载并运行」的工作流）。这是一条**完整的 RCE 链**，
只需一个仓库内被投毒的 README/issue 指引 URL。
**建议**：默认对 `download_tool` 的**可执行扩展名**（`.exe/.dll/.ps1/.bat/.cmd/.sh/.js/.vbs`）升级为 `HIGH` 并强制人工确认；
对 `run_command` 增加「目标文件在近 N 分钟内被 `download_tool` 写入」的关联告警。

### P1-12 **[测]** `runner-r.js` 必然失败（唯一实测报红的套件）

**位置**：`test/runner-r.js:11`（硬编码第三方网关）、`:12`（`KEY` 默认空）、`:14`（端口 19500）、`package.json:27`–`32`

**实测**：
```
$ node test/runner-r.js
FAIL  R5: default model responds after models.json loaded  :: content=
===== SUITE R SUMMARY: 1/10 passed in 8s =====
FAILED: R1: files created :: files=[]            FAILED: R2: turn 2 recalls all 3 facts :: a2=
FAILED: R1: fib.js has iterative implementation  FAILED: R2: haiku references the session context
FAILED: R1: generated test passes independently  FAILED: R2: reasoning chain captured
FAILED: R3: counter.txt created with correct content :: content=""
FAILED: R4: CJK streaming - no replacement chars :: content=""
exitcode=1
```
**问题**：该套件**没有** `runner-k.js:17/177` 那样的 `REAL_TEST` 跳过守卫，因此任何人在离线环境跑它都得到
「1/10 + 退出码 1」，看起来像产品坏了，实际是缺配置。它同时是**唯一没有任何入口的孤儿 runner**
（`package.json` 只注册了 `test`→A 与 `test:b`→B；`INSTALL.md:115` 只写「十个测试套件（A–J）」，漏掉 K 与 R）。
**建议**：加与 K 一致的守卫，或把它明确列为「需真实端点」的可选套件并在 README/INSTALL 中说明。

### P1-13 `webui.html` 显示恒为 `v?`（`/api/info` 未返回 `version`）
**位置**：`webui.html:615`（`$('ver').textContent = 'v' + (info.version || '?')`）vs `index.js:2616`

`/api/info` 的返回体只有 `model/light/workspace/mode/keyRequired/models`，没有 `version`；`index.js` 也**从未读取**
`package.json` 的 `version`（全文只有 `1690` 读**工作区**的 package.json，且仅用于找 `scripts.test`）。
（既有清单 P1-2，未修复。）**建议**：启动时 `require('./package.json').version` 缓存一份，`/api/info` 返回 `version`。

### P1-14 `AUTO_SAFE_TOOLS` 与 `DETERMINISTIC_RISK` 等表存在「声明了但走不到」的死条目
**位置**：`index.js:311`–`316`（含 `synthetic_output_tool`、`bickering_tool`）、`2075`–`2084`（含 `run_tests_tool`、`git_*`）

这些表与实现分处四个位置独立维护（`tools[]`、`AUTO_SAFE_TOOLS`、`DETERMINISTIC_RISK`、`executeToolRaw` 的 if 链），
本会话实测证明四处**当前是一致的**（8 个工具全部可达），但分散定义使「漏改一处」的风险长期存在。
**建议**：把「工具名 → { 免审批?, 风险等级, 解释器, 实现 }」收敛为**单一声明表**（见建议 2.1），权限与实现从同一来源派生，
从根本上消除「三张表漂移」。

### P1-15 `mcp_tool` 的 npx 分支把参数交给 `run_command`，风险等级标注与实际执行不一致
**位置**：`index.js:1451`、`2060`–`2062`

`mcp_tool` 被标 `HIGH`（`2082`），这没问题；但它在 `1451` 内部**回调 `executeToolRaw('run_command', ...)`**，
**绕过了 `safeExecuteToolInner` 的全部检查**——包括 `2060` 的 `isSuperDangerous` 拦截。
当前靠 `1440`/`1446` 的正则白名单兜底（写得很谨慎），但「工具内部直接调另一个工具的 raw 实现」这种做法
会随重构悄悄扩散权限缺口。**建议**：内部调用改为 `safeExecuteTool`（受同一权限管线）或显式注释声明已复核的等价约束。

### P1-16 `brief_tool` 的 `.summary` 落点可能逃出预期位置 / 无大小控制
**位置**：`index.js:1309`–`1318`

`sanitizePath(args.folder)` 对**目录**调用（目录存在时 realpath 成功，OK），但随后 `path.join(launchDir, folderRel + '.summary')`
把摘要写到**工作区根**（沿用旧清单 P2-1 的根目录污染），且 `files.join('\n')` 对超大目录无上限（可能是几十万行），
直接进模型上下文（虽有 `capToolResult` 兜底 30 k）。**建议**：摘要写 `.7coder/summaries/<name>.summary`，条数上限 + 截断提示。

---

## 四、P2 — 低（体验 / 整洁 / 性能）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| P2-1 | `index.js:2349`–`2385` | `backupFile` 每次写入调用 **2 次** `pruneBackups`，每次全量遍历备份目录（双 `stat`/条）；备份上限 100 是**全目录共享**，写几个大文件就能把**其它文件**的历史备份全部挤掉，而 `README.md:148` 只写「max 100 backups kept」，用户不知情 | 写后 prune 一次即可；改为**每文件保留 N 份**（如 5）+ 总量上限 |
| P2-2 | `index.js:622`–`656` | `grepSearch` 对**每个文件整读入内存**、无单文件大小上限、不跳二进制、不排除 `node_modules`/`.git`/`dist`；本仓实测 `test/` 下就有 300+ 残渣文件（含单个 5.2 MB 日志，见旧清单） | 单文件 >2 MB 跳过；按扩展名/首 4 KB 判二进制；默认排除 `node_modules`/`.git`/`dist`；结果条数上限并提示 |
| P2-3 | `index.js:576`–`620` | `recursiveReaddir` 无深度上限、无排除目录，且对**每个**条目 `lstatSync`+`statSync` 两次系统调用 | 合并为一次 `lstatSync`；加入排除表与 `maxDepth` |
| P2-4 | `index.js:2022`、`2207`、`2244` 等 | 同步 IO（`readFileSync`/`writeFileSync`）位于 HTTP 请求与流式发送路径上（如 `2605` 每请求同步读 `webui.html`、`2668`、`2755`） | `webui.html` 启动读一次缓存；会话读写改 `fs.promises` |
| P2-5 | `index.js:2025`–`2028`、`1656` | 错误判定依赖**返回字符串前缀正则**（`BLOCKED|Tool error|Parse error|...`），与其余工具的措辞变化都会静默破坏判定（例如 `Unknown tool` 就不在该表内） | 改为统一结果对象 `{ ok, code, content }`，`capToolResult` 只序列化 `content`（见建议 2.2） |
| P2-6 | `index.js:200` 附近 | 审计日志 `argsPreview` 原样记录前 200 字符，`run_command` 里的 `curl -H "Authorization: Bearer sk-…"` 会**明文落盘**（沿用旧清单 P2-5） | 对 `key/token/secret/password/authorization` 键与 `Bearer\s+\S+` 做脱敏 |
| P2-7 | `index.js:3091` | `server.listen` 无 `error` 监听，端口占用直接抛 `EADDRINUSE` 使进程崩溃（无友好提示） | `server.on('error', ...)` 给出「端口被占用，改 HTTP_PORT」 |
| P2-8 | `index.js:2975`–`3027` | 流式分支**未设置 `res.setTimeout`/写入背压**（`res.write` 返回 false 被忽略）；大响应下内存可能堆积 | 尊重 `write()` 返回值 / 用 `pipeline`；或至少在 `writeChunk` 里判断背压 |
| P2-9 | `index.js:2149`–`2152`、`250`、`236` | 死代码：`httpApprovalRefs` 赋值 0 后从未使用；`workflowStepDepth` 的语义注释在 `248`–`250` 与实现在 `2091`/`2129` 有分歧（注释说「跳过轻模型检查」，实现是「跳过审批询问」） | 删除死变量；注释与实现统一 |
| P2-10 | `index.js:1699`、`1693` | 测试自动探测只看**工作区根**的 `*.test.js` 与 `package.json`，不递归、不看 `__tests__`/`test/` 目录 ⇒ 本仓（测试全在 `test/`，`package.json` 的 `scripts.test` = `node test/runner.js`）在**非工作区根**运行时探测不到 | 探测加入 `test/`、`tests/`、`__tests__/`、`*.spec.js` |
| P2-11 | `index.js:1156`、`1540`、`1552` | 有的路径用 `-EncodedCommand`（安全，好），有的把路径拼进 shell 字符串（`"${shotPath}"`）。`shotPath` = `launchDir` + 固定名，虽非模型可控，但 **`launchDir` 来自 `process.cwd()`**：macOS/Linux 分支的 `import -window root "${shotPath}"` 在含 `"`/`` ` ``/`$` 的目录名下会被破坏 | 统一改 `execFileSync(prog, [args])` 数组形式，消除所有引号拼接 |
| P2-12 | `index.js:3345`、`3160` | `main().catch(console.error)` 只打印不设 `process.exitCode`；`flushExit` 在 HTTP 分支**完全未调用**（`3149`–`3150` 直接返回），服务端异常退出路径无统一收尾 | 顶层 catch 设置 `process.exitCode = 1`；统一收尾函数 |

---

## 五、优化建议（方向性）

### 5.1 用单一声明表收敛「工具表 / 权限表 / 实现 / 文档」四处漂移
**（预防性建议，不是当前缺陷的直接修复）**：P1-15 指出同一工具的元信息被写在 4 个地方
（`tools[]`、`AUTO_SAFE_TOOLS`、`DETERMINISTIC_RISK`/`DETERMINISTIC_EXPLAIN`、`executeToolRaw` 的 `if` 链）。
本会话实测已证明这 4 处**当前是一致的**（8 个工具全部可达），所以这是**降低未来改动风险的投入**，而非修 bug。
建议改为：

```js
const TOOL_SPECS = {
  read_file:   { safe: true,  risk: 'LOW',    explain: a => `Read ${a.path}`,        run: async (a, ctx) => {...} },
  git_status_tool: { safe: true, risk: 'LOW', explain: () => '... read-only',        run: async (a, ctx) => {...} },
  ...
};
```
`tools[]`（给模型看的 schema）、权限判定、审批文案、实现全部由该表派生；`executeToolRaw` 变成
`TOOL_SPECS[name]?.run(...)` 单点分发——**结构性地**消灭「漏改一处导致工具消失」这类缺陷。
同时把 `parseTestOutput`、`git`、`inGitRepo` 这类辅助函数移到模块作用域（不要块级函数声明）。

### 5.2 引入统一工具结果契约，取代字符串前缀判定
`{ ok: boolean, code?: 'BLOCKED'|'ERROR'|'NOT_IMPLEMENTED'|..., content: string }`。
`capToolResult` / 审计 / workflow 的失败停步判定全部基于 `ok`/`code`。
这能直接修复 P2-5，并让「兜底字符串被误判为成功」这类问题不再可能。

### 5.3 安全收口（按优先级）
1. 密钥永不下发（P0-2）+ 审计参数脱敏（P2-6）；
2. 无 `HTTP_API_KEY` 时非 loopback 绑定**拒绝启动**（P0-4）；
3. 审批桥/待审批表按连接隔离（P0-3）；
4. `download_tool` 可执行扩展名升为 `HIGH`（P1-12）；
5. 危险命令表补齐 PowerShell 方言（沿用旧清单 P1-13：当前表**已有** `remove-item -recurse -force`/`format-volume`/`stop-computer`/`clear-disk`/`initialize-disk`，
   但 `Remove-Item -Recurse -Force` 的**大小写**靠 `toLowerCase()` 兜住了，仍缺 `rm -rf *`、`rmdir /s /q` 之外的变体与误报收窄）。

### 5.4 工程结构
`index.js` 已 3345 行单文件，建议按职责拆分（**保持 CommonJS 与 Node 13 兼容**）：
`tools/index.js`（声明表）、`security.js`（沙箱/受保护文件/危险命令）、`http-server.js`、`repl.js`、`context.js`（压缩）、`persist.js`（会话/备份/审计）。
拆分的直接收益：`executeToolRaw` 单个函数已达 **889 行**（实测），任何改动的影响面都难以评估；拆分后爆炸半径可降到单文件百余行。

### 5.5 测试
- **必补**：8 个工具（`run_tests_tool`/`git_*`/`synthetic_output_tool`/`plan_mode`/`bickering_tool`/`auto_debug_tool`）的冒烟断言；`git_commit_tool` 快照 ref **真实存在**的断言（`runner-b.js:787` 现仅检查字符串，属假阳性）；
  `git status` 计数口径断言（P1-4）；`/api/info` 含 `version`（P1-13）；`/api/settings` 不含明文 key（P0-2）；
  并发双流审批不串线（P0-3）。
- 测试工装公共件（`rmrf`/`runCli`/`startMock`/`freshCwd`）抽 `test/_shared.js`——12 个 runner 的复制粘贴是
  已记录的 `rmrf` 自递归成因，建议按旧清单结论一次改净。
- `test/` 残渣（300+ 个 `cur-*.json`/`mock-log-*.jsonl`，含 5.2 MB 单文件）应由 runner 结束时自清理；
  `.gitignore:5-13` 虽已忽略，但**磁盘**仍在，且 `scripts/pack-offline.js` 的排除规则若不修（旧清单 P1-9：`e === 'w-'` 恒假），
  重新打包会把这些残渣打进发行包。
- `package.json` 只暴露 `test`/`test:b` 两个 runner，其余 10 个（`runner-c`…`runner-r`）**无法从 scripts 触发**，
  建议加 `test:all` 串跑并汇总断言数（顺带解决文档里套件数/断言数三处打架的问题）。

### 5.6 文档对齐（会误导使用者，优先级不低）
| 位置 | 问题 |
|---|---|
| `README.md:98`–`99` | `run_tests_tool` / `git_*` 实测可用（B 套件 93/93），此二行**无需修改** |
| `README.md:130`–`131` | 「Mouse/keyboard input injection is **not implemented**」与 `KNOWN-ISSUES.md` A7「已实现 Windows 真实输入」**直接矛盾**（`README.md:95` 又写「simulated no-ops」） |
| `README.md:136` | 整段内联代码丢失：「(to ) - start the REPL with  (or type )」，缺 `.7coder/session.json`、`--resume`、`/resume`（沿用旧清单 P1-10） |
| `README.md:185` | 「HTTP OpenAI endpoint — works with any **non-streaming** OpenAI-compatible UI」与 `README.md:53`「Both non-streaming and streaming … are supported」矛盾 |
| `README.md:191` | 「no modern JS syntax used」不准确（对象展开 `{...notebook.metadata}`、无参 `catch {}`、`async/await`、`String.matchAll` 均 ES2018+） |
| `README.md:23`–`32` | 与 `KNOWN-ISSUES.md` B5「决定不发布 npm」矛盾（旧清单 P1-8） |
| `KNOWN-ISSUES.md:74`–`78` | D4 段落**重复 3 遍**且内联代码同样丢失 |
| `KNOWN-ISSUES.md:86` | 「十一个套件 A-J」只列出 10 个，实际 `test/` 有 12 个 runner |
| `KNOWN-ISSUES.md:3` | 头部「末次核对 2026-09-27」未随 09-29/09-30 内容更新；A12 状态过时（代码已改为 fail-fast） |
| `LICENSE:1` vs `LICENSE:3` | 标题写 `Revision 5 Sub-Revision 3 (SPL-R5 SR2)`，同一行内 `SR3` 与 `SR2` 自相矛盾 |
| `.npmignore` | 仅一行 `.env`；既已决策不发 npm（B5），文件去留应明确（旧清单 P2-17） |
| `package.json` vs `dist/` | 根 `2.16.0` vs `dist/7coder-v2.6.0-offline/package.json` `2.6.0`，相差 10 个版本，属陈旧产物（旧清单 P1-9） |

---

## 六、本次已复核确认「已修复」的旧条目（供维护者更新清单）

| 旧编号 | 结论 | 证据 |
|---|---|---|
| P0-2（cron `every 0h` 栈溢出） | **已修复** | `index.js:665` 新增 `if (h <= 0) return null;` |
| P1-1（`run_tests_tool` 字面换行符） | **已修复并实测通过** | `1715`/`1718`/`1719` 已改为真换行；B 套件断言 `3 passed, 1 failed` 实测通过 |
| P1-3（webui 模型/模式持久化） | **已修复** | `webui.html:612` `setItem('7coder-model')`、`614` `modeSel.value = info.mode` |
| P1-4（`writeWorkspaceEnv` 丢注释） | **已修复** | `index.js:3070`–`3087` 已改为**逐行原地替换**受管键，保留未知行与注释 |
| A12（`--prompt ""` 静默进 REPL） | **已修复** | `index.js:56`–`59` fail-fast 并 `exit(1)` |
| P0-4 / P1-2 / P1-9 / P1-10 / P1-14（旧清单编号） | **仍未修复** | 见本文 P0-2、P1-13、P1-11、P1-5、P2-1 |

---

## 七、测试套件专项审阅（**[测]** + [转] + 抽查）

> ### 7.0 实测结果（本会话全量执行，Node v24.19.0）
>
> | 套件 | 结果 | 耗时 | 套件 | 结果 | 耗时 |
> |---|---|---|---|---|---|
> | A `runner.js` | **74/74** | 90s | F `runner-f.js` | **23/23** | 46s |
> | B `runner-b.js` | **93/93** | 87s | G `runner-g.js` | **29/29** | 35s |
> | C `runner-c.js` | **35/35** | 48s | H `runner-h.js` | **32/32** | 47s |
> | D `runner-d.js` | **32/32** | 49s | I `runner-i.js` | **34/34** | 116s |
> | E `runner-e.js` | **22/22** | 39s | J `runner-j.js` | **16/16** | 23s |
>
> - **合计 390/390 全绿，零失败**，退出码全部为 0。
> - `runner-k.js`（**[测]**）：未设 `REAL_TEST` 时输出 `SUITE K SKIPPED: ...` 并**退出 0** —— 按设计跳过。
> - `runner-r.js`（**[测]**）：**1/10**，9 条失败，**退出码 1** —— 本次唯一实测失败的套件，见 P1-12。
> - **[测] 文档口径纠正**：`KNOWN-ISSUES.md:86` 记「A(74)/…/J(16) = 373 项」，其中 **B 现为 93 项**（文档写 74），
>   其余九项与文档逐项一致。**实测合计 390 项，不是 373 项。**
> - **[测] 结论**：**KNOWN-ISSUES.md 声称的「双运行时全绿」在当前代码上依然成立**（Node 24 侧已验证；
>   Node 13 侧本次未验证，因无可用 13.14.0 运行时）。
>
> ### 证据来源说明
>
> 本章的行号级细节由子代理独立审阅 `test/` 下 12 个 runner 得出，**我本人没有逐行通读这些文件**。
> 我只抽查并**确认**了以下几条，其余行号请以复核为准：
> - ✅ `test/runner.js:594` 假绿退出码 —— 已亲自读到原文并复算（零断言时 `0===0` ⇒ 退出 0）
> - ✅ `test/runner-g.js:278` 恒真断言 —— 已亲自读到；左侧 `JSON.stringify([].concat(...[]).sort())` 恒为 `'[]'`
> - ✅ `plan_mode` / `bickering_tool` 在 `test/` 零命中 —— 已亲自 `grep` 全目录确认
> - ✅ `auto_debug_tool` 仅覆盖 `disabled` 分支、`synthetic_output_tool` 有真实断言 —— 已亲自读到（`runner.js:284/288/315`）
> - ⚠️ 顺带纠正一处：[T3] 的恒真断言**并未让整条供应链检查失效**——`runner-g.js:280`（依赖恰为 axios+dotenv）
>   与 `:281`（axios 已离开 0.x）是**独立断言且有效**，另有 `package-lock.json:41` 实际锁定 axios **1.20.0**。
>   故该项危害等级应从「检查失效」降为「该条断言形同虚设、存在冗余覆盖」。
> - ⚠️ 另需注意：子代理与我一样**无法执行任何命令**（同一 shell 权限故障），且本工作区**没有 `.git`**（只有 `.gitignore`），
>   因此「残渣文件已被提交进仓库」是**推断而非证实**。

对 `test/` 下 12 个 runner、`mock-server.js`、`chaos-mock.js`、`kill-orphans.ps1` 的审阅结论：

**先说一个关键交叉验证**：`KNOWN-ISSUES.md:71`–`72` 记录 Suite B 的 git/tests 场景**曾经全绿**，
且 `test/runner-b.js:782`–`787`、`751`–`753` 明确断言 `[GIT] branch`、`3 passed, 1 failed`、
`git: commit created with requested message + snapshot recorded`。
本会话实测这些断言**全部通过**（93/93），证明那 8 个工具完全可达。
而是 **v2.16.0 引入、且当前必然为红的新回归**——`node test/runner-b.js` 的
`git-integration`（4 条）与 `tests-runner`（2 条）现在应当全部失败。这既是缺陷的独立佐证，
也说明**初稿的 P0-1 结论是错的**——详见第〇节更正声明。

### 7.1 P1（测试有效性）

| # | 位置 | 问题 |
|---|---|---|
| T1 | `test/runner.js:594` 及 runner-b~j 同款（b:950, c:518, d:440, e:456, f:439, g:442, h:536, i:454, j:376） | **假绿隐患**：`process.exit(pass === results.length ? 0 : 1)`，当 `RUN_ONLY` 未匹配任何场景时 `results.length === 0` ⇒ `0===0` ⇒ **退出码 0**（`runner.js:591` 只打印 WARNING）。CI 无法区分「全绿」与「一条都没跑」。**[测]** 本次全量运行未触发该分支（各套件均跑了 16–93 条断言），故它是**结构性隐患而非当前故障**。**修**：断言数为 0 时非零退出 |
| T2 | `test/runner-r.js:11`、`:14`、`:12` | **[测] 已实测复现，本次唯一失败套件**：`node test/runner-r.js` → **1/10 passed，9 条 FAIL，退出码 1**；失败详情为 `content=`（空响应），因为它硬编码了第三方网关 `https://maas.qianwenaiapi.com/compatible-mode/v1`、端口 19500、`KEY` 默认空，且**没有**像 `runner-k.js:17/177` 那样的跳过守卫。它同时是**唯一未被任何地方引用的孤儿 runner**（无 npm script、`INSTALL.md:115` 只写「十个测试套件（A–J）」漏掉 K 与 R）。**修**：加 `REAL_TEST` 守卫 + 补进 `package.json`，或在文档中明确标注为需真实端点的可选套件 |
| T3 | `test/runner-g.js:278` | **恒真断言**：`JSON.stringify([].concat(...[]).sort()) === '[]' \|\| …` 左操作数永远为真 ⇒ 供应链检查无论 `foreign` 内容如何都通过。另有 3 处裸 `record(..., true, ...)`（`runner.js:539`、`runner-g.js:116`、`runner-i.js:133`）。`runner-d.js:158` `r2done()` 只判断「日志非空」，却标称验证「完整攻击表」 |
| T4 | `test/runner-i.js:435` | 断言文案为「string content unchanged」，实际只断言「至少存在 1 条 user 消息」——文案与断言语义不符 |
| T5 | 全 `test/` | **盲等代替就绪探测**：每次起 mock 后 `setTimeout(600)`（`runner.js:126` 等），起服务后 2500 ms（`runner.js:512`）；mock 以 `stdio:'ignore'` 启动（`runner.js:29`）⇒ **EADDRINUSE 被丢弃**，CLI 会静默连上「别人的」旧进程（正是 `ISSUES-LOG.md:169` INC-6 描述的现象）。端口全部硬编码基址（`17600`/`17850`/…/`19500`）无动态分配 |
| T6 | `test/runner-g.js:271`–`284`、`runner-h.js:229`–`290`、`runner-i.js:104`–`109`、`:324`–`335` | **白盒文本耦合**：用 `extract()` 从 `index.js` 里抠代码/正则做断言，`runner-i.js:301` 甚至 `eval()` 抠出来的片段。只要 `index.js` 重新格式化（例如建议 5.1 的拆分重构），这些套件就会以 `extraction failed` 报错——**测试与被测源码的排版强耦合**，是重构的直接阻力 |

### 7.2 P2（可移植性 / 卫生 / 破坏性）

| # | 位置 | 问题 |
|---|---|---|
| T7 | `test/mock-server.js:9`、`test/chaos-mock.js:14` vs `test/runner.js:31` | **跨平台硬伤**：mock 端用字面量拼接 `__dirname + '\\mock-log-' + PORT + '.jsonl'`，runner 端用 `path.join(ROOT,'mock-log-'+port+'.jsonl')`。**POSIX 上两者文件名永不相同** ⇒ `readLog` 返回 `[]` ⇒ 所有基于 mock 日志的断言全灭。与 `KNOWN-ISSUES.md` C4「macOS/Linux 兼容」目标直接冲突 |
| T8 | 多处 | Windows 专属工装未做平台分支：`ping -n 2 … >nul`（`runner.js:51` 等 9 处）、`mklink /J`（`runner-c.js:217`、`runner-h.js:398`、`runner-j.js:128`）、`cmd.exe /c dir /s /b`（`runner-c.js:476`）、`tasklist`（`runner-h.js:106`）、真桌面（`runner-i.js:312`）、盘符相对路径 `C:bait.txt`（`runner-d.js:124`）。其中 `runner-c.js:218`、`runner-j.js:130` 在 `mklink` 不可用时**记 FAIL 而非 skip**，非 Windows 环境必然红 |
| T9 | `test/` 目录 | **残渣未清理**：317 个生成文件（158 个 `cur-script-*.json`、155 个 `mock-log-*.jsonl`、4 个 `cur-*.json`），由工装自己写出（`runner.js:25`–`26`、`mock-server.js:10`）且**从不删除**；另有 `test/w-*` 残留工作区（489 个文件 / 236 个 JSON）。`.gitignore:5-13` 已忽略，但**磁盘**仍在。建议 runner 结束时自清理（`try/finally`），并给 `scripts/pack-offline.js` 补上排除规则（旧清单 P1-9：`e === 'w-'` 恒假） |
| T10 | `test/runner-j.js:128`、`:146` | **潜在破坏性**：先建 junction `jself -> cwd`（即测试工作区自身），随后**递归 `rmrf` 它**。若运行时解引用 junction，递归删除会打到工作区树而非链接本身。（本次无法执行确认，标记为需人工复核的高危项） |
| T11 | `test/kill-orphans.ps1:1`–`8` | 按命令行匹配对**全机所有** `node.exe` 执行 `Stop-Process -Force`，且硬编码 `7coder` 路径；在他人机器上误杀无关 Node 进程 |
| T12 | 全 `test/` | **复制粘贴**：约 100 行公共前导/收尾（`rmrf`/`IDX`/`NODE_BIN`/`record`/`startMock`/`readLog`/`toolResults`/`tr`/`freshCwd`/`runCli`/`httpReq`/summary）在 12 个文件中各存一份——这正是旧清单 P0-1（`rmrf` 自递归只在 11 个副本里存在）的成因。另有死代码：`runner-d.js:23/27`–`30` 的 `customServerCode` 无任何调用者；`runner-c.js:166`–`173`、`runner-e.js:143`–`144` 起了又立刻杀掉的 mock。**约 70 处 `catch (e) {}`** 静默吞掉 kill/rm/parse 失败 |
| T13 | `test/runner-i.js:160` | 硬编码兄弟目录名 `w-i-i2b`，当 `freshCwd`（`runner-i.js:55`）走 `Date.now()` 兜底分支时路径不再匹配 |

### 7.3 覆盖缺口（与工具表对照）

| 工具 | 覆盖情况 |
|---|---|
| `synthetic_output_tool` | 有（`runner.js:284` 调用，`:313` 断言） |
| `run_tests_tool` | 有（`runner-b.js:743`→`:751`），**实测通过** |
| `git_status_tool` / `git_diff_tool` / `git_commit_tool` | 有（`runner-b.js:773`→`:782`–`787`，含非仓库分支 `:789`），**实测通过** |
| `plan_mode` | **零覆盖**（`grep` 全 `test/` 无命中） |
| `bickering_tool` | **零覆盖**（同上） |
| `auto_debug_tool` | 仅覆盖 `disabled` 分支（`runner.js:288` 调用，`:315` 只断言字符串 `disabled`）——与 `KNOWN-ISSUES.md` C1 自述一致 |
| `computer_use` | 仅覆盖禁用分支（`runner.js:287`/`:314`） |

**结论**：Suite B 的 git/tests 断言措辞精确（`[GIT] branch`、`untracked:1`、`-v1/+v2`、`snapshot`），
说明缺陷是**实现侧新引入**而非测试虚设；而 `plan_mode`/`bickering_tool` 零覆盖、
`auto_debug_tool` 只测禁用分支，属于真实盲区（C1 已自述，建议排期补最小断言）。

---

## 八、建议的修复顺序

> **P0-1（初稿第一优先项）已撤回**，修复顺序相应调整。以下按「实测证据强度 × 危害」排序。

1. **P0-2 / P0-4**（密钥掩码 + 无 key 时写接口拒绝 / 拒绝非 loopback 绑定启动）——**[读]** 级、危害最高的安全面。
2. **P0-3**（审批桥与 `pendingApprovals` 按连接隔离，`id` 加连接前缀）——**[读]** 级、并发正确性。
3. **P1-13**（`runner-r.js` 加 `REAL_TEST` 守卫 + 接进 `package.json`）——**[测]** 已实测失败，改动最小、立刻消除"跑测试就报红"的困扰。
4. **快照静默吞错**（P1-2 撤回后的残留项）——`index.js:1781` 的 `catch (e) {}` 应记录并回报失败。
   同时**加强测试**：`runner-b.js:787` 只断言输出含字符串 `snapshot`，**未校验 `refs/7coder/snapshots/*` 真的存在**，
   属假阳性断言，建议补 `git rev-parse --verify refs/7coder/snapshots/<sha>`。
5. **P1-14 / 建议 5.1**（单一工具声明表）——结构性预防「漏改一处」类回归（**注意：P0-1 撤回后，此类缺陷目前并未实际发生**，属预防性投入）。
6. **T1 / T3**（断言数为 0 时非零退出；补掉恒真断言）——**[读]+[测]**，没有这两条，后续所有"绿"的可信度都打折。
7. 其余 P1/P2（P1-4 TOCTOU、P1-5 退出码、P1-11 下载链、T5 就绪探测、T7 POSIX 兼容等）与文档对齐（5.6，含 **[测]** 发现的 373→390 口径修正）。

---

*报告结束。*

> **测试执行说明**：本报告的实测部分在 **Node v24.19.0 / Windows** 上完成，
> 执行了 `node --check index.js`、`node test/runner.js` 及 `runner-b`…`runner-r` 共 12 个套件、
> 一次一次性任务失败退出码验证（P1-5）、一次 git 快照链路验证（P1-2 撤回依据），
> 以及在临时仓库中的 `git check-ref-format` / `update-ref` 复现。
> **未下载任何依赖或外部资源**；除本报告外**未修改仓库内任何文件**。
>
> 为定位 P0-1 的括号归属，曾在 `index.js` 末尾临时插入一行插桩读取 `executeToolRaw.toString()`，
> 该行**已删除并验证**：文件 3345 行 / 169,224 字节、`node --check` 退出 0、
> `grep toString()` 仅剩 5 处原有调用、`node test/runner-b.js` 复跑仍 93/93。
> （说明：插桩前后未预先记录哈希，故为「逐项复验」而非「哈希比对」。）
>
> Node 13.14.0 运行时本次**未验证**（本机无该版本），因此 `KNOWN-ISSUES.md` 声称的
> 「双运行时全绿」只复核了 Node 24 一侧。
