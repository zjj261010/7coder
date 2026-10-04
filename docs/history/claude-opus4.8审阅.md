# claude-opus4.8 审阅 —— 7coder v2.18.0

> 审阅人：Claude Opus 4.8（1M context）
> 日期：2026-10-04
> 代码基线：`main` @ 1f52a8a（v2.18.0），工作树除 `.workbuddy/` 外干净
> 独立于 `ISSUES-LOG.md` 的既有结论，逐条对**当前代码**核验；凡标注"已验证"的均附复现证据。

---

## 0. 审阅范围与方法

- **通读**：`index.js`（4771 行，全文逐段读完）、`webui.html`（render/SSE/审批/会话路径）、`scripts/pack-offline.js`、`test/_shared.js`、`ISSUES-LOG.md`（52KB，全部历史轮次）。
- **抽样**：`test/runner-b.js` 相关断言（run_tests / ast-security），`.env.example`、`README.md`、`.gitignore`、`package.json`。
- **动态验证**（在 `.cache/` 临时脚本中执行，已清理）：
  - 复现 `run_tests_tool` 的实际输出串；
  - 实测 `parseTestOutput` 正则的回溯耗时曲线；
  - `node --check index.js` 语法通过；
  - `grep`/逐行核对 `isSuperDangerous` 接线点与 HTTP 路由鉴权点。
- **未做**：没有跑完整测试套件（会拉起 mock server / 子进程，可能留孤儿进程污染你的机器）。本报告结论来自静态分析 + 针对性动态验证，不依赖"套件全绿"这一既有记录。

**一句话结论**：这是一个**工程水准明显超出其体积**的单文件 agent。路径沙箱、四权限模式、审批经济学、审计脱敏、备份/undo、请求门隔离、双运行时测试纪律都是同类玩具项目里的超配。但本轮核验发现 **`ISSUES-LOG.md` 里至少两条标 ✅ 的条目与代码不符（P1-1、P2-10）**，其中 P2-10 对应一个**真实可复现的指数级 ReDoS**；另发现 **cron 工具绕过"超级危险命令"硬防线**、**部分 HTTP 读接口在设了 key 时仍未鉴权** 两处新问题。详见第 4、5 节。

---

## 1. 总体评价

| 维度 | 评价 |
|---|---|
| 架构清晰度 | 单文件但分节清楚；职责边界合理。体量已到应拆分的临界点（见 OPT-3，用户已决策暂缓，同意其风险判断）。 |
| 安全设计 | **优**。`realPathSafe` fail-closed、受保护文件、deny/allow 规则分层语义、审计脱敏都做得专业。个别硬防线有缺口（第 4 节 F3）。 |
| 并发正确性 | **良**。`requestGate` 串行化 + 每请求审批桥，解决了真实的跨请求串线。代价是多标签排队（已知 AST-15）。 |
| 可靠性 | **良**，但有一个同步正则 DoS 点抵消了 AST-09 的异步化收益（F2）。 |
| 测试纪律 | **优**（真实断言、双运行时、自清理、exit 码契约）——但个别断言"锁错了目标"，放过了真实缺陷（F1）。 |
| 文档 | **良**。README/INSTALL 已多轮纠偏；仍有 2 处"过实"表述（F5）。 |

---

## 2. 架构速览

```
index.js (单进程, CommonJS, 仅 axios + dotenv)
 ├─ CLI 解析 (两遍) → 权限模式 / server / background / prompt
 ├─ 配置加载: .env(install) ← .env(workspace) ← models.json ← permissions.json ← mcp.json
 ├─ MCP stdio transport (JSON-RPC 2.0 / NDJSON, 惰性拉起+重拉)
 ├─ 工具层: executeToolRaw (~45 个工具的实现, 840 行)
 │    ↑ safeExecuteTool (审计包装) → safeExecuteToolInner (权限/风险/审批决策)
 ├─ 模型调用: callOpenAI (流式 SSE + 非流式, 重试/用量统计)
 ├─ 上下文: compressConversationIfNeeded (CJK×2 加权) + capToolResult
 ├─ 持久化: 7CODER.md auto-log / .7coder/memory / session.json / audit.jsonl / backups
 └─ HTTP: webui + /v1/chat/completions(SSE+审批桥) + /api/* 管理面
```

权限判定主链（`safeExecuteToolInner`, index.js:3070）顺序正确且已被多轮加固：
`denial → protectedWrite(bypass/auto 拦) → deny 规则(全模式) → auto-safe/auto-log 豁免 → 超级危险命令 → computer_use 门 → allow 规则(仅跳审批) → bypass 直放 → 风险分级 → auto 结构化审批 / default 真实 diff 审批`。

---

## 3. 做得好的地方（应保留，勿在重构中丢失）

1. **路径沙箱 fail-closed**（`realPathSafe` index.js:679）：对最长存在前缀解析 realpath，解析不出就**抛错而非降级为词法检查**，junction/symlink 逃逸被 `linkStaysInside` 挡住。这是整个文件最硬的一块。
2. **审批经济学**（`DETERMINISTIC_RISK`/`DETERMINISTIC_EXPLAIN` index.js:3146/1655）：常见工具零轻模型调用，既省 token 又去掉了 LLM 在硬边界上的不确定性。
3. **真实 diff 审批**（`simpleLineDiff` index.js:3642）：default 模式下写文件按真实 `-/+` 行审批，而非 LLM 转述——用户看到的就是将落盘的东西。
4. **审计脱敏**（`sanitizeAuditArgs` index.js:371）：敏感键名→`***`，其余值清洗 `Bearer`/`sk-` 令牌，再落 `audit.jsonl`。
5. **Web UI 的 XSS 防御是对的**（`render` webui.html:357）：**先 `esc()` 再做 markdown**，所以即便模型回显了 `web_fetch` 抓来的攻击者 HTML，也只会变成实体文本。顺序对了，这点很多人会写反。
6. **下载事务化**（AST-05, index.js:1961）：`.part-` 临时文件，成功才 rename，失败只删 temp 绝不动既有文件。
7. **git 全程数组化 argv**（AST-01, index.js:2745）：`execFileSync('git', argsArr)`，路径/提交信息是单一 argv 条目，shell 注入面被彻底消除。
8. **测试是真断言**（`_shared.js` `record(name, boolean, detail)`）+ 退出码契约 + 自清理。这在"玩具项目"里极少见。

---

## 4. 本轮新发现（已验证，按严重度排序）

### 🔴 F2 — `parseTestOutput` 嵌套量词导致指数级 ReDoS（中）
**位置**：`index.js:2626-2628`
**状态矛盾**：`ISSUES-LOG.md` P2-10 标 ✅"已改为 `(\d+)`（现 grep 无嵌套量词）"——**不实**。当前代码仍是 `(\d+)+`（三处）。

```js
let passed  = num(/(\d+)+\s+pass(?:ing|ed)?/i);
let failed  = num(/(\d+)+\s+fail(?:ing|ed)?/i) || num(/#\s*fail\s+(\d+)/i);
const skipped = num(/(\d+)+\s+skipped/i) || num(/#\s*skipped\s+(\d+)/i);
```

`(\d+)+` 是经典 evil regex（结构同 `(a+)+`）。当输入含一段长数字且其后**不是** `\s+pass/fail` 时，回溯呈指数增长。

**实测复现**（纯数字串 + 一个非数字尾字符）：

| 连续数字位数 | 耗时 |
|---:|---:|
| 20 | 20 ms |
| 26 | 184 ms |
| 30 | 2 964 ms |
| 34 | **52 401 ms** |

每 +4 位 ≈ ×16，典型指数。38 位 ≈ 14 分钟。

**危害链**：`run_tests_tool` 把命令**原始输出**整体喂给 `parseTestOutput`（index.js:2673）。`parseTestOutput` 本身是**主线程同步** CPU 计算——AST-09 只把子进程 exec 异步化了，这段正则没被异步化。只要被测程序打印一行 ≥30 位的连续数字（大整数/BigInt/纳秒时间戳/快照数字），事件循环就冻结数秒到数分钟；**`--server` 模式下等于冻结整个服务器**（所有并发客户端 / 健康检查 / 审批）。这正是 AST-09 想消除的那类冻结，却从另一条路漏回来了。

对"在不可信仓库上跑 agent"的威胁模型，这是可被构造的 DoS（一个 `console.log('9'.repeat(44))` 的测试 ≈ 冻结 ~14 分钟）。

**修复**：把三处改成 `(\d+)`（P2-10 本就该做的）。更稳妥的是在 `parseTestOutput` 入口对 `t` 限长（如只扫末尾 N KB），并给模型侧正则统一加"无嵌套量词"的 lint。

---

### 🟠 F3 — cron 工具绕过"超级危险命令"硬防线（中）
**位置**：`index.js:3119`（接线点）vs cron 处理 `index.js:2396`、运行 `scheduleCronJob` `index.js:1270`
**问题**：`isSuperDangerous` 只接到四个工具上：

```js
if (['run_command', 'bash_tool', 'powershell_tool', 'task_create_tool'].includes(name)) {
  if (isSuperDangerous(args.command)) return 'BLOCKED: ...(even in danger mode).';
}
```

`schedule_cron_tool` / `cron_create_tool` **不在**此列，但它们最终都用 `child_process.exec(command)` 周期性跑 shell（index.js:1270）。于是在 **bypass/danger 模式**下：

```
cron_create_tool { schedule:"30s", command:"rm -rf / --no-preserve-root" }
```

一路走到 `if (mode==='bypass'||DANGER_MODE) return executeToolRaw(...)`（index.js:3139），**从不触发超级危险拦截**，然后每 30s 执行一次。

README 明确承诺："Even in bypass mode, super-dangerous commands (`rm -rf /`, `format`, `dd`, etc.) are still blocked." —— 这条承诺对 cron **不成立**。注意 `permRuleArgText`（index.js:829）**确实**把 cron 纳入了 deny 规则的命令文本匹配，说明设计者知道 cron 命令是 shell 命令；只是内置硬防线漏接了。

**修复**：把 `schedule_cron_tool`/`cron_create_tool` 加入 3119 的列表（用 `args.command` 判定）；更彻底的做法是在 `scheduleCronJob` 的 `runCommand` 里 fire 时也 `isSuperDangerous` 一次（防止创建后配置漂移）。

> 旁注：同样未经硬防线的还有 `mcp_tool` 的 legacy npx 分支（index.js:2343 直接递归 `executeToolRaw('run_command', …)`，绕过 `safeExecuteToolInner`），但该路径的包名/参数已被元字符白名单限制，难以构造危险命令，风险低。建议顺手也走正规审批链。

---

### 🟡 F1 — `run_tests_tool` 输出仍含游离单引号；P1-1 实为"关错了"（低，但属账实不符）
**位置**：`index.js:2674, 2677, 2678`
**状态矛盾**：`ISSUES-LOG.md` P1-1 标 ✅"真换行早已修复…OPT-8 的 ts3 断言（含真换行、无字面 `'\n'` 文本）已锁定"。**真换行确实对**，但**作者本想写成换行的那些 `'` 单引号还留在输出里**，从未被修掉。

当前代码（原样）：
```js
if (!r.parsed) return "...but no recognizable summary.'\n'Output tail:'\n'" + out.substring(...);
...
res += (r.failures.length ? "Failures:'\n'" + r.failures.join('\n') : "All green.");
res += "'\n''\n'Raw tail:'\n'" + out.substring(...);
```

**实测实际输出**（JSON 转义以显形）：
```
"[TESTS] exit=1 3 passed, 1 failed, 0 skipped (of 4).\nFailures:'\n'FAIL foo\nnot ok bar'\n''\n'Raw tail:'\n'SOME TEST OUTPUT\nsecond line"
```
即模型/用户看到的是：
```
Failures:'
'FAIL foo
not ok bar'
''
'Raw tail:'
'SOME TEST OUTPUT
```
`"...'\n'..."` 里 `\n` 在双引号串里**本来就是真换行**（这从来不是 bug），真正的瑕疵是包在换行两侧的 `'` 字面字符。

**为什么测试放过了它**（`test/runner-b.js:879`）：
```js
record('... (no literal backslash-n text)',
  ts3 && ts3.c.includes('[TESTS] command finished') && ts3.c.includes('\n') && !ts3.c.includes("'\\n'"), ...);
```
断言查的是 `!c.includes("'\\n'")`——4 字符序列 `'`\`n`'`（反斜杠 n）。而实际产物是 3 字符序列 `'`+真换行+`'`。断言**锁错了目标**：它永远为真（这段代码从不产生字面反斜杠 n），于是在缺陷仍在时照样 PASS——典型 false-green。

**修复**：把三处 `'\n'`（以及 `'\n''\n'`）改成真正的 `"\n"` 拼接；同时把 ts3 断言改成"输出不含游离单引号"之类**对准真实产物**的检查。本条本身是 cosmetic（低危），但它是**结构化工具输出**，脏串会污染模型读到的测试结论。

---

### 🟡 F4 — 设了 `HTTP_API_KEY` 时，`/api/info`、`/api/todos`、`/v1/models` 仍不鉴权（低，信息泄露）
**位置**：`index.js:3927`（`/api/info`）、`3932`（`/api/todos`）、`3940`（`/v1/models`）
**问题**：这三个 GET 路由**没有** `HTTP_API_KEY` 校验行（对比同文件 `/api/sessions` index.js:3948→3949 立即有鉴权门）。于是在"**设了 key + 绑 LAN**"这一 README 明确支持的暴露场景下，任意 LAN 主机**无需 key**即可读到：

- `/api/info`：version、HEAVY/LIGHT 模型名、**workspace 绝对路径**、权限模式、模型列表、token 用量。
- `/api/todos`：完整结构化任务清单（标题可能含项目敏感信息）。
- `/v1/models`：模型名。

这与 OPT-2（⛔，针对**未设 key** 时的写接口）是**不同问题**：本条是**设了 key 之后读接口仍裸奔**。用户为 LAN 暴露专门配了 `HTTP_API_KEY`，合理预期是"整个 endpoint 受保护"，而 `/api/info`/`/api/todos` 不符合该预期。非 RCE（chat 与写接口都已鉴权），仅信息泄露。

**修复**：给这三个路由补上与兄弟路由一致的 `if (HTTP_API_KEY && auth !== Bearer) → 401`。`/v1/models` 是否鉴权可按 OpenAI 兼容习惯取舍，但 `/api/info`/`/api/todos` 应补。

---

### 🟡 F5 — README 两处"过实"表述（低，文档/行为不符）
1. **"Even in bypass mode, super-dangerous commands … are still blocked"**（README.md:113）：对 cron 不成立（见 F3），且 `isSuperDangerous` 是**子串小黑名单**，`rm -rf /*`、`rm -fr /`、`rm --recursive --force /`、`:(){ :|:& };:`（fork 炸弹）、`find / -delete`、`chmod -R 000 /` 等均不拦。建议改为"best-effort 拦截若干已知毁灭性形态，并非完备黑名单"。
2. **"reading them [protected files] always requires approval (never auto-safe)"**（README.md:128）：在 **bypass 模式**下读 `.env` 只 `console.warn`（index.js:3088-3090）后仍直接执行（index.js:3139），**不要求审批**。严格说 bypass=无审批，但文案"always requires approval"与之冲突。建议补"except in bypass/danger mode"。

---

## 5. 重点：`ISSUES-LOG.md` 账实不符（元问题）

你们在 DS-1"虚报事故"后立了铁律："**子代理的'已完成'必须以 diff 为准**"。本轮核验发现，**这条铁律对 P1-1、P2-10 两行失效了**——它们被标 ✅ 却与 v2.18.0 代码不符：

| 条目 | 日志声称 | 代码实况 | 证据 |
|---|---|---|---|
| P2-10 | "已改为 `(\d+)`（现 grep 无嵌套量词）" | `index.js:2626-2628` 仍是 `(\d+)+`×3 | 逐行读 + 实测 ReDoS 52s@34位 |
| P1-1 | "真换行早已修复…无字面 `'\n'`" | `index.js:2674/2677/2678` 仍有游离 `'` | 执行原表达式，输出含 `Failures:'⏎'...` |

两者都带"状态回翻 2026-10-03（此前漏翻）"字样——即当时是**凭"应该在某个新 ID 下修过了"而回翻旧行**，没有对代码复核。这恰是你们自己定义的"只记新区块、漏翻旧行"的反面：这次是**旧行翻成了 ✅，但新修根本没发生/没修全**。

**建议**：
- 立刻把 P1-1、P2-10 状态改回 🔶/⬜ 并实修；
- 对所有"状态回翻（此前漏翻）"的行做一次**以 diff/grep 为准**的复核（本轮只抽到这两条，不排除同批还有）；
- 把"关闭条目须附**可执行的验证命令或 grep 证据**"写进维护约定第 2 条。

---

## 6. 其它观察（设计权衡 / 低优先，不强求改）

- **web 工具的 SSRF 面**（`web_fetch_tool` index.js:1955 等）：`axios.get(args.url)` 无主机限制，模型可访问 `169.254.169.254` 等内网/云元数据。对编码 agent 属固有能力，default 模式有审批兜底；若未来做无人值守/LAN 暴露，建议对 web 工具加内网地址黑名单。
- **间接提示注入的持久化面**：模型可**免审批** `write_file` 到 `7CODER.md` 与 `.7coder/memory/*.md`（auto-log 豁免 index.js:3104-3113），而这些内容又被 `buildTaskUserContent` 自动注入未来每个任务。即"web 抓到攻击者文本 → 写进 7CODER.md → 跨会话污染上下文"。需模型配合，风险低，但值得在威胁模型里记一笔。
- **`diagnostics_tool` 的"read-only/auto-safe"略过实**（index.js:2693）：`tsc` 基本安全，但 `eslint` 会加载项目的 `eslint.config.js`/插件，**等于执行项目定义的 JS**。在自己的工程里无所谓，但"只读安全"的措辞对 eslint 分支不够准确。
- **`/api/mode` 不经 `requestGate`**（index.js:4235）：可在一个 chat 请求持门运行期间切换 `PERMISSION_MODE` 全局，理论上让运行中的请求观察到模式变化。低危。
- **`formatDiagResult` 混入中文**（index.js:2688 `' 个问题\n'`）：周边工具输出均为英文，此处独为中文，风格不一致（非 bug）。
- **一次性模式下 cron 立即失效**：`job.timer.unref()`（index.js:1283）+ `--prompt` 跑完即退，调度的 cron 永不触发。属预期但可能让人意外，文档可提一句。
- **打包体积**：`pack-offline.js` 把整个 `test/`（~400KB，含 142KB 的 runner-b）与未经 `--production` 裁剪/校验的 `node_modules` 一并打进发行包。无正确性问题，纯卫生项。
- **`dist/` 残留**：`TS情网部_朱佳杰_925290.zip` 与 `新建文件夹` 在工作目录里（未被 git 跟踪，`.gitignore` 已含 `dist/`），看起来像误入的个人文件，建议清理以免随手打包泄露。

---

## 7. 建议优先级

| 优先级 | 项 | 动作 |
|---|---|---|
| **P0** | F2 ReDoS | 三处 `(\d+)+`→`(\d+)`；`parseTestOutput` 入口限长。顺手真正关闭 P2-10。 |
| **P0** | F3 cron 绕过硬防线 | cron 工具纳入 `isSuperDangerous` 接线；fire 时再查一次。 |
| **P1** | 账实不符复核（第 5 节） | 复核全部"状态回翻（此前漏翻）"行，以 grep/diff 为准；维护约定加"附验证证据"。 |
| **P1** | F4 读接口鉴权 | `/api/info`、`/api/todos` 补 401 门。 |
| **P2** | F1 run_tests 脏串 | 三处 `'\n'`→`"\n"`；ts3 断言改为对准真实产物。 |
| **P2** | F5 文档过实 | README:113/128 两处措辞按实际行为收口。 |
| P3 | 第 6 节各项 | 按需。SSRF 黑名单留到 LAN/无人值守需求出现再做。 |

---

## 附录：验证记录（可复现）

1. **ReDoS**：以 `/(\d+)+\s+pass(?:ing|ed)?/i.test('9'.repeat(n)+'!')` 计时，n=20/26/30/34 → 20/184/2964/52401 ms。
2. **run_tests 脏串**：原样执行 `index.js:2675-2678` 的拼接表达式，结果 `JSON.stringify` 后含 `Failures:'\n'...`（`'`+真换行+`'`）；`includes("'\\n'")===false`，故 ts3 断言恒过。
3. **cron 绕过**：`index.js:3119` 的 `includes(name)` 列表 = `['run_command','bash_tool','powershell_tool','task_create_tool']`，不含 cron；`cron_create_tool` 在 bypass 分支（index.js:3139）前未经 `isSuperDangerous`。
4. **HTTP 鉴权**：`grep` 路由与鉴权行，`/api/info`(3927)/`/api/todos`(3932)/`/v1/models`(3940) 之后**无** `HTTP_API_KEY` 校验，`/api/sessions`(3949) 起才有。
5. **语法**：`node --check index.js` 通过。
6. **gitignore**：`.7coder/`、`.env`、`dist/`、`.cache/` 均已忽略；个人 zip/文件夹未被跟踪（AST-04 落实到位）。

---

*本报告为静态审阅 + 针对性动态验证，未运行完整测试套件（避免在你机器上拉起 mock/子进程）。F1–F4 的行号与证据均基于 v2.18.0 当前代码，可直接复核。*
