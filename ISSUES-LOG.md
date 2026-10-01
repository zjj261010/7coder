# 7coder 问题与优化统一跟踪

> **本文件是唯一的问题跟踪文档**：按发现日期汇总所有问题与优化建议，逐条标注状态。
> 新问题一律追加到对应日期小节（无则新建小节）；修复后只改状态列，不删除历史行。
> `KNOWN-ISSUES.md` 与 `REVIEW-CHECKLIST-2026-09-30.md` 自本文件建立起冻结为历史快照，不再更新。
>
> 状态图例：✅ 已完成（附提交号/代码位置）｜🔶 部分完成（注明剩余部分）｜⬜ 未处理｜⛔ 不修（有明确决策）
>
> 规模快照（2026-10-01 深夜）：单文件 index.js（~3410 行），v2.16.0，P0-3/DS-14/15 轮后 A–J 全绿 403 项（A 77/B 103/C 35/D 32/E 22/F 23/G 29/H 32/I 34/J 16）；
> 其余套件规模 C35/D32/E22/F23/G29/H32/J16 + K/R 真实端点 9+10 项，末次全绿见 git 历史。

---

## 2026-09-27 —— 首轮代码审阅 + 八轮多维测试

> 依据：初始审阅 + 8 轮测试（套件 A–J，373 项断言/运行时）+ 1 轮修复审计，Node 24 / Node 13.14.0 双运行时全绿。

### A 系列：缺陷（全部关闭）

| # | 问题 | 状态 |
|---|------|------|
| A1 | axios 0.21.4 CVE-2023-45857 | ✅ 升级 ^1.20.0（Node 13 实测 9/9 API 面探针通过） |
| A2 | 外部命令 GBK 中文乱码 | ✅ 子进程前置 chcp 65001 |
| A3 | `--background` 输出全部丢失 | ✅ 重定向 `.7coder/background.log` + flushExit |
| A4 | 子代理会话永不压缩 | ✅ 切分点放宽为非 tool 角色边界 |
| A5 | HTTP 客户端断连后上游空跑 | ✅ 取消令牌 + 断连跳过摘要 |
| A6 | dream 整理与自动摘要互相覆盖 | ✅ auto-log 标记节原位重建 |
| A7 | computer_use 鼠标/键盘为模拟 no-op | ✅ user32 mouse_event + SendKeys |
| A8 | 审批每步都要轻模型调用（贵且慢） | ✅ 确定性风险/解释表，常见工具零额外调用 |
| A9 | Ralph 循环复用 MAX_RETRIES | ✅ 独立 RALPH_ITERATIONS |
| A10 | /bye 不清理 cron/dream 锁 | ✅ 退出时停止定时器/删锁/拒绝新任务 |
| A11 | glob/grep 仅匹配文件名 | ✅ 目录感知 globToRegex（`src/**/*.js` 语义） |
| A12 | 解析器怪癖：空 `--prompt ""` 静默进 REPL；未知 flag 并入任务文本 | 🔶 空 prompt 已 fail-fast（index.js:56，exit 1）；词序重排保留为两遍解析的既定设计，严格模式另立条目 |
| A13 | HTTP content 非字符串字面化为 "[object Object]" | ✅ JSON.stringify 回退 |

### B 系列：决策（全部关闭）

| # | 决策点 | 状态 |
|---|--------|------|
| B1 | axios 是否升级 | ✅ 升级 ^1.20.0（见 A1） |
| B2 | dotenv 是否升级 | ✅ 决定保持 8.x，行内注释限制以文档规避 |
| B3 | 被移除工具的路线 | ✅ workflow_tool 已实现；remote_trigger 等 5 个永久放弃 |
| B4 | exit_worktree 与路径沙箱冲突 | ✅ 维持现有折中（Suite J 验证） |
| B5 | npm 发布 | ✅ 决定不发布，离线 zip 分发 |
| B6 | 运行时 emoji | ✅ 全部移除（Win7 GBK 兼容） |

### C 系列：测试盲区（长期存在，非缺陷）

| # | 盲区 | 状态 |
|---|------|------|
| C1 | auto_debug_tool 完整循环（组件已分测） | ⬜ 接受现状 |
| C2 | web_search / web_browser 真实外网 | ⬜ 保持离线确定性 |
| C3 | computer_use 真实截屏 | ⬜ 仅真机手动验证过 |
| C4 | macOS / Linux 分支真实运行 | ⬜ 本机 Windows |
| C5 | 真 Win7 硬件（驱动/代码页差异） | ⬜ 以 Node 13 运行时等价验证 |
| C6 | 超长 cron（>24.8 天分段续期） | ⬜ |
| C7 | >6 并发 HTTP | ⬜ 6 并发已验证 |
| C8 | 内存泄漏（数小时级 soak） | 🔶 短会话 24 任务 RSS 已验证（Suite H）；小时级未测 |
| C9 | 压缩按字符数近似 token | ⬜ 设计取舍 |

### D 系列：功能路线

| # | 项 | 状态 |
|---|-----|------|
| D1 | Git 集成（status/diff/commit + 快照） | ✅ 09-29（49f2a4d） |
| D2 | 测试运行器集成（结构化 pass/fail） | ✅ 09-29（adc20af） |
| D3 | LSP 客户端 | ⬜ 周级工程，未排期 |
| D4 | 会话跨进程持久化 + /resume | ✅ 09-29（7a25532） |
| D5 | 结构化审计日志（JSONL + 轮转） | ✅ 09-29（f35285d） |
| D6 | 并行只读工具执行 | ✅ 09-30（5ded281，READ_ONLY 集合 Promise.all） |
| D7 | per-project .env | ✅ 09-29（a8810c2） |

---

## 2026-09-29 —— 多模型与会话功能日（无新增未决缺陷）

| 项 | 状态 |
|-----|------|
| 多模型路由：models.json 按模型映射 endpoint/apiKey，客户端 model 字段按请求路由 | ✅ 03631d7（Suite B multi-model 3 项 + 双 profile 真实验证） |
| Suite K 真实端点回归发现：workflow_tool 内层步骤被轻模型逐级否决 → 计划获批后内层继承审批（硬防线保留） | ✅ ae6d5c8 |
| Web UI：模型设置面板 / 会话历史删除 / 自动保存 / 推理链折叠 | ✅ 54d09d7、45ac6b3、0cd0cef、3403ce0、d6f3c1d |
| 已知问题（当日修复）：/api/sessions/load 缺变量声明崩溃；writeWorkspaceEnv TDZ | ✅ 1f758f1 |

---

## 2026-09-30 —— 全面复审（P0/P1/P2 清单）+ Web UI 功能

> 本节为 REVIEW-CHECKLIST-2026-09-30.md 的全部条目，状态为**当前代码逐一核验**的结果（2026-10-01 核验）。

### P0 — 严重

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| P0-1 | test/runner*.js ×10 | `rmrf` 自递归（调自身而非 fs.rmSync），工作区清理静默无效 | ✅ 22d2845 全部改为 fs.rmSync（保留 Node 13 回退）；"目录确实被删"专项断言未加 → 断言部分并入 OPT-11 |
| P0-2 | index.js:665 | cron `every 0h` → ms=0 → armNext 同步无限递归崩溃 | 🔶 代码已修（`h <= 0` 返回 null）；"every 0h 被拒绝"断言未补（现仅 bogus 用例） |
| P0-3 | index.js:2181-2199, 3060-3098 | HTTP 审批桥为模块级单例：并发流式客户端互相覆盖/摘除，审批丢失或串线 | ✅ 主会话实施（2026-10-01 深夜）：桥改为按请求局部对象，经 processWithTools opts.approvalBridge → safeExecuteTool → safeExecuteToolInner → askApproval 全链透传（workflow 内层经 executeToolRaw 第 4 参）；审批 id 带 6 位随机连接前缀防跨连接抢答；请求结束 dispose 清理未决审批；子代理/REPL/非流式路径行为不变；新增 approval-iso 并发场景 6 项断言（双流各得审批、id 前缀互异、批准 A 仅完成 A、B 保持挂起、批 B 后完成、写入真实落地） |
| P0-4 | index.js（GET /api/settings） | 明文下发 apiKey（未设 HTTP_API_KEY 时本机任意进程可读） | ⛔ 用户决策（2026-09-30）：不修，与使用场景无关 |

### P1 — 中

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| P1-1 | index.js:1715 | run_tests_tool 输出含字面 `'\n'`（单引号嵌在双引号串里） | ⬜ 未处理 |
| P1-2 | index.js /api/info | 未返回 version，Web UI 右上角恒显 "v?" | ⬜ 未处理（从 package.json 读并缓存） |
| P1-3 | webui.html | 模型选择只读不写 localStorage；模式下拉不回显 | ✅ setItem + `modeSel.value = info.mode`（webui.html:612,614） |
| P1-4 | writeWorkspaceEnv | 保存设置时整文件重序列化，注释与格式全丢 | 🔶 代码已修（逐行原地改写受管键，注释/未知行保留）；未补回归断言 |
| P1-5 | index.js 默认值 vs 文档 | HTTP_PORT 8000/7103；MAX_TOKENS 2048/42000；TEMPERATURE 0.7/0.6 | 🔶 前两项已对齐文档（7103、42000）；TEMPERATURE 代码仍 0.7，.env.example 写 0.6 |
| P1-6 | INSTALL.md + runner | 验证命令场景名全不匹配 → 假绿（0/0 退出码 0） | 🔶 INSTALL 已改真实场景名（cli-exit,oneshot）；RUN_ONLY 空匹配已加警告（runner.js:591 等）；**退出码仍为 0**（0===0 → exit 0，需改 results.length===0 时 exit 1） |
| P1-7 | INSTALL/KNOWN-ISSUES | 套件数/断言数三处口径打架（"10 套件 334 项" vs 实际 12 runner 且 B 已 93 项） | ⬜ 未处理（建议脚本自动汇总，见 OPT-10） |
| P1-8 | README | 已决策不发 npm 但保留 "Now on NPM!" 教程 | ✅ npm 安装教程已移除 |
| P1-9 | pack-offline.js + dist/ | copyRec 排除 `e === 'w-'` 恒假；未排除 cur-*；dist 陈旧 v2.6.0 | 🔶 mock-log-/cur-script- 排除已加（pack-offline.js:47）；`w-` 前缀判断仍错、dist 未重打（仍是 7coder-v2.6.0-offline） |
| P1-10 | README + KNOWN-ISSUES | 内联代码整段丢失；KNOWN-ISSUES D4 条目重复 3 遍 | 🔶 README 已修；KNOWN-ISSUES D4 段仍重复且丢内容（该文件已冻结，若按 OPT-9 归档则随归档关闭） |
| P1-11 | git 54d09d7 | 提交信息 GBK 乱码 | ✅ `git config i18n.commitencoding utf-8` 已设 |
| P1-12 | index.js mcp_tool | 无配置时返回 "[OK] executed locally" 假装成功 | ✅ 改为明确报错（"MCP error: no endpoint configured…"，index.js:1453） |
| P1-13 | isSuperDangerous | 误报（'shutdown' 等宽子串）+ 漏报（无 PowerShell 模式） | ✅ 模式收窄（`rm -rf /`、`del /f /q c:\` 等）+ 新增 remove-item -recurse -force / format-volume / stop-computer / clear-disk / initialize-disk |
| P1-14 | one-shot 失败退出码 | 失败仍 exit 0，脚本无法感知 | ✅ 完整修复（DS-1）：flushExit 尊重 process.exitCode；套件 A/B 断言已锚定新契约（失败 exit 1） |

### P2 — 低

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| P2-1 | index.js 多处 | `.7coder_last_interaction`、`7C.dream.lock`、BTW.md 等散落工作区根 | ⬜（收纳进 .7coder/，读旧路径兜底一次） |
| P2-2 | index.js:1993 | 过时注释 "input actions are simulated no-ops"（A7 已实现真实输入） | ⬜ |
| P2-3 | grepSearch/recursiveReaddir | 整读文件无上限、不跳过 node_modules/.git、无深度上限 | ⬜ |
| P2-4 | index.js:2353,2365 | backupFile 前后各调一次 pruneBackups（双全量遍历） | ⬜ |
| P2-5 | 审计日志 | argsPreview 原样落盘，可能记录密钥 | ⬜（对 key/token/secret/authorization/Bearer 脱敏） |
| P2-6 | index.js / webui.html | server.listen 无 error 处理（EADDRINUSE 直接崩）；UI 每请求同步读盘 | ⬜ |
| P2-7 | test 工装 | `ping -n 2 … >nul`、`'\\mock-log-'` 硬编码 Windows 写法 | ⬜ |
| P2-8 | README:191 | "no modern JS syntax used" 不准确（ES2018+ 特性在用） | ⬜（改为"语法不超过 Node 13.14 支持范围"） |
| P2-9 | KNOWN-ISSUES | 头部日期未更新；A12 状态过时（代码已 fail-fast） | ⬜（文件已冻结 → 随 OPT-9 归档决策处理） |
| P2-10 | parseTestOutput | 正则嵌套量词 `(\d+)+` ×4 | ✅ 已改为 `(\d+)`（现 grep 无嵌套量词） |
| P2-11 | index.js:1742 | git_status 口径："M " 同时计入 staged 与 modified | ⬜（XY 分列） |
| P2-12 | web 审批 | 120 秒超时自动拒绝无倒计时提示 | ⬜ |
| P2-13 | index.js:1537 | 截图 PNG 落工作区根不清理；auto_debug 无进度输出 | ⬜（截图进 .7coder/） |
| P2-14 | README/INSTALL | 打包机需现代 Node（pack-offline 用 rmSync）未声明 | ⬜ |
| P2-15 | ask_user_tool | 非交互模式返回 "skipped"，模型可能误读为已作答 | ⬜（改强指令文案） |
| P2-16 | webui.html:345,400 | 死代码 var keyOk / var sessionPath；.cursor 样式未定义 | ⬜ |
| P2-17 | .npmignore | 已决策不发 npm，文件去留未决 | ⬜ |

### 方向性优化建议（OPT）

| # | 方向 | 内容 | 状态 |
|---|------|------|------|
| OPT-1 | 安全 | 审计日志参数脱敏（=P2-5） | ⬜ |
| OPT-2 | 安全 | 未设 HTTP_API_KEY 时对写操作类 /api/* 默认拒绝或一次性确认 | ⛔ 用户决策（2026-10-01）：维持现状不修——本机个人工具，loopback 默认 + 文档已有 LAN 警告；如未来需 LAN 长期暴露再重开（含 .env 重写劫持上游的升级说明，见 DS 系列核对表） |
| OPT-3 | 结构 | index.js 拆分 tools/ + http-server.js + repl.js + security.js + context.js | ⬜（当前 ~3240 行；Win7/Node13 约束下需保持单入口） |
| OPT-4 | 测试 | 10 个 runner 公共件（rmrf/runCli/startMock/freshCwd）抽 test/_shared.js | ⬜（P0-1 正是复制粘贴的代价） |
| OPT-5 | 测试 | test/ 残渣清理：现存 313 个 cur-script-/mock-log-* 文件 + 222 个 w-* 目录；runner 结束时自清理 | ⬜ |
| OPT-6 | 并发 | 多客户端并发的进一步增强（依赖的 P0-3 已关闭） | ⬜（审批隔离已就绪；剩余为会话保存的并发语义） |
| OPT-7 | 测试 | RUN_ONLY 空匹配时非零退出 | ✅ 随 DS-9 关闭（10 个 runner exit 1） |
| OPT-8 | 测试 | 补回归断言：cron `every 0h` 拒绝（P0-2 剩余半）、run_tests_tool 真换行（随 P1-1）、writeWorkspaceEnv 注释保留（P1-4 剩余半）、rmrf 真删目录（P0-1 剩余半） | ⬜ |
| OPT-9 | 文档 | 冻结的历史文档（KNOWN-ISSUES.md、REVIEW-CHECKLIST-2026-09-30.md）移入 docs/history/ 或删除 | ⬜ |
| OPT-10 | 文档 | scripts/count-assertions.js 从各 runner 自动汇总断言数写入本文档头部，杜绝口径漂移（根治 P1-7） | ⬜ |
| OPT-11 | 测试 | runner 退出前清理本次运行产生的 cur-script-*/mock-log-*（OPT-5 的增量半） | ⬜ |

---

## 2026-10-01（下午）—— deepseek4.1flash 审阅报告核对（DS 系列）

> 输入：`deepseek4.1flash审阅.md`（51KB，含其自行撤回的 P0-1 误判）。
> 核对方式：逐条对照当前代码验证（本会话 2026-10-01），非转述。
> 总评：报告整体质量高、自我纠错诚实（P0-1 撤回正确，8 个工具确实全部可达）；
> 实测部分与本地一致（A–J 390/390、B 现为 93 项）。但仍有 **4 条不实/过实** 与 **1 条半不实**，见下表"报告不实条目"。

### 核对为真的新问题（DS 系列，已按风险分级）

| # | 位置 | 问题（核对结论） | 状态 |
|---|------|------|------|
| DS-1 | index.js:84-89, 3160 | flushExit(code) 直接 process.exit(code)，一次性任务失败路径 exitCode=1 被 3160 的 flushExit(0) 覆盖——脚本化调用无法感知失败（报告实测复现，代码核对成立；=旧 P1-5 的"剩余半"实为未修） | ✅ GLM-5.3-Flash 虚报（自称已改并自验，工作树无此改动），主会话终检发现并重修：flushExit 尊重 process.exitCode；套件 A 新增 one-shot 失败退出码断言 |
| DS-2 | index.js:2992, 3044 | 流式 chunk 与非流式响应的 model 字段硬编码 HEAVY_MODEL，忽略请求的 model（reqModel 已解析但未传入）——多模型 UI 读到错误模型名 | ✅ 流式与非流式响应均回显 reqModel；套件 E 契约断言同步更新（回显客户端 model + 缺省回退 HEAVY_MODEL） |
| DS-3 | index.js:2616 | /api/info 不返回 version，webui 恒显 "v?"（=旧 P1-2，复核仍在） | ✅ APP_VERSION 注入 /api/info（返回 version: 2.16.0） |
| DS-4 | index.js:1739-1744 | git_status_tool 口径双计："M " 同时计入 staged 与 modified；"MM" 同样（=旧 P2-11，复核仍在）。修复需同步对齐 runner-b git-integration 断言 | ✅ XY 分列（staged 看 X、modified 看 Y）；git-integration 4/4 既有断言无需改动 |
| DS-5 | index.js:1569-1571 | escapeSendKeys 先转义元字符后插入 {ENTER}/{TAB}，占位符花括号是"生"的：`type_text("{ENTER}\nx")` 会凭空多按一次回车 | ✅ 单遍逐字符映射（CRLF 合并为一次 {ENTER} 的旧行为保留）；套件 I 的白盒提取逻辑同步扩展到函数闭合 |
| DS-6 | test/runner-r.js:11-14 | 无 REAL_TEST 跳过守卫（runner-k 有），离线必跑出 1/10 红 + 退出码 1；且未被 package.json scripts 引用 | ✅ REAL_TEST 守卫（离线 SKIPPED/exit 0）+ package.json 新增 test:r |
| DS-7 | test/runner-g.js:278 | 恒真断言：`JSON.stringify([].concat(...[]).sort()) === '[]' \|\|` 左支永真，供应链检查形同虚设（同文件另有 3 处裸 true 断言，威胁低） | ✅ 恒真左支已删，仅保留真实供应链条件 |
| DS-8 | test/mock-server.js:9, chaos-mock.js:14 | `'\\mock-log-'` 字面反斜杠 vs runner 端 path.join——POSIX 上文件名永不一致，所有基于 mock 日志的断言全灭（与 C4 目标冲突） | ✅ mock-server.js 与 chaos-mock.js 均改 path.join（各补 require path） |
| DS-9 | 全部 runner | RUN_ONLY 空匹配 0/0 → exit 0 假绿（=OPT-7，报告复核确认结构成立） | ✅ 10 个 runner RUN_ONLY 空匹配改为 exit 1（OPT-7 随之关闭） |
| DS-10 | README.md:130-131, 185, 191；LICENSE:1 | README 称鼠标/键盘注入"not implemented"（A7 已实现，自相矛盾）；"non-streaming UI"（流式早已支持）；"no modern JS syntax"（=旧 P2-8）；LICENSE 标题 "Sub-Revision 3 (SPL-R5 SR2)" 同行自相矛盾 | ✅ README 四处 + LICENSE SR3 统一；主会话终检另补 README:95 工具清单里的过时 no-op 描述（GLM 按纪律未越界改） |
| DS-11 | index.js:1781 | 快照 catch 静默吞错。**半不实**：报告称"snapshot 照旧赋值→文案误报"不成立（赋值在 update-ref 成功后才执行，execSync 失败即抛→catch→snapshot=""→文案正确省略）；成立的部分是失败无任何提示 | ✅ catch 加 console.warn；runner-b:787 快照断言补 for-each-ref 实校验（不再仅查字符串） |
| DS-12 | index.js:2150 | httpApprovalRefs 死变量（声明后从未读写） | ✅ 死变量 httpApprovalRefs 已删（grep 确认无引用） |
| DS-13 | index.js:1769-1775 | 自动提交信息统计全量 audit.jsonl（跨会话累积），新任务会引用几个月前的工具名，无信息量 | ⬜ 暂不修（低价值；根治需 audit 加 runId，随 OPT-3 结构调整一并考虑） |
| DS-14 | index.js:2377-2412 | 备份上限 100 为**全目录共享**：写几个大文件即挤掉其它文件的全部历史备份（=旧 P2-1 升级） | ✅ GLM-5.3-Flash 完成且本轮真实落盘（1726b14）：每文件留最新 5 份 + 全局 200 兜底；backup-cap 场景断言 a.txt 7 写留 5、b.txt 不被挤掉；主会话 diff 终检 + 独立复跑 |
| DS-15 | index.js:1313-1323 | brief_tool 的 `.summary` 落工作区根（=旧 P2-1 家族）且无条数上限 | ✅ GLM-5.3-Flash 完成（1726b14）：改写 .7coder/summaries/<folder>.summary + 2000 条截断；brief-loc 场景 4 项断言 |

### DS 系列执行记录（2026-10-01 晚：GLM-5.3-Flash 工作流 + 主会话终检）

- 执行方式：工作流（4 阶段：index.js 修复 → 测试工装/文档并行 → 行为复现 → 语法×15 + 套件 A/B/G/I 回归门，失败返修），全部子代理跑 GLM-5.3-Flash。
- **DS-1 虚报事故**：index修复员自称已改 flushExit 并自验 EXIT=1，验证员亦报 failExit=1，但工作树中**无此改动**——两道"自验"均为假阳性。主会话终检（git diff 逐块核对 + 独立复现）发现后亲手重修。**教训（对后续所有代理修复轮适用）：子代理的"已完成"必须以 diff 为准；工作流报告的 verified 不能替代主会话终检。**
- 工作流回归门只跑了 A/B/G/I，漏掉的套件 E 藏着 DS-2 的契约断言冲突（旧断言钉死了"回显服务端模型"的 bug 行为）——主会话全量回归抓出后更新为新契约（回显客户端 model + 缺省回退 HEAVY_MODEL）。
- DS-1 的正确退出码行为连带暴露两条钉死旧 bug 的断言（runner.js:114 用死端口断言 exit 0、runner-b.js:116 断言失败 exit 0），均已更新为收紧后的新契约；runner.js:114 同时改为用活 mock 端点以保持断言本意（缺 key 不阻断本地端点启动）。
- 主会话终检补充：README:95 工具清单的过时 no-op 描述（GLM 正确识别但按指令范围未改）、套件 A 新增 one-shot 失败退出码断言（堵住让 DS-1 虚报漏网的盲区）。
- 终检回归：A–J 十套件全绿 391 项（较上轮 +1，即新增的退出码断言）；runner-r 离线 SKIPPED/exit 0；RUN_ONLY 空匹配 exit 1。

### 报告中不实 / 过实的条目（记录在案，防再引用）

| 报告条目 | 核对结论 |
|---|---|
| P1-8 ask_user 在服务端挂起 | **不成立**：其所述暴露面（环境变量 ENABLE_HTTP_SERVER=true 且未带 --server）同样进入 main() 的 `if (ENABLE_HTTP_SERVER)` 分支（index.js:3139）→ rl.close() → rlClosed=true → 1303 行守卫返回 skipped。三条路径（--server / env 开关 / stdin EOF）均已覆盖 |
| T11 kill-orphans.ps1 "对全机所有 node.exe 执行 Stop-Process" | **过实**：脚本按命令行正则过滤（mock-server/chaos-mock/cur-script/7coder index.js --server），不匹配的不杀；"硬编码路径"亦不实（正则仅含相对模式） |
| "本工作区没有 .git（只有 .gitignore）" | **不实**：本仓库 git 正常（当日多次提交推送）；其"残渣已提交进仓库"的推断已由报告自行标注未证实 |
| 第七节前言 "git-integration 4 条与 tests-runner 2 条现在应当全部失败" | **报告内部残留矛盾**：与同报告实测 93/93 直接冲突，系撤回 P0-1 前的旧文本未清理 |
| P0-2 明文密钥（GET /api/settings 与 /api/models-config） | 行为属实，但**用户已决策 ⛔（2026-09-30，与使用场景无关）**；models-config GET 同类，维持 ⛔ 一并记录 |
| P0-4 无 key 时管理接口裸奔 | 属实，=OPT-2；报告补充的".env 重写可劫持上游"升级说明已并入 OPT-2 描述。**维持待用户决策，不自行实施** |
| P0-3 审批桥全局单例 | 属实（复核 index.js:2149/3001/3020），维持 ⬜。**本轮不指派给弱模型**（涉及 processWithTools 管线改造 + 并发测试，单独一轮实施） |

### 与既有条目的状态联动

- 旧 P1-5（退出码）由 🔶 改判：代码侧从未真正修复（flushExit 吞码），本轮 DS-1 指派重修。
- 旧 P2-11（git 口径）= DS-4，升为本轮修复。
- 旧 P1-2（version）= DS-3、旧 P2-8（README 语法描述）并入 DS-10、OPT-7 = DS-9：均转 🔧。
- 报告确认已修复项（cron 0h、run_tests 换行、webui 持久化、writeWorkspaceEnv 注释、--prompt "" fail-fast）与 ISSUES-LOG 现状一致，无需变动。
- KNOWN-ISSUES 373→390 计数过时：该文档已冻结，本文件头部已是实测新数，无需动作（OPT-10 自动汇总后彻底根治）。

---

## 2026-10-01 —— HTTP 路由丢失事故（提交 22d2845）

> 夜间排查 settings-api 场景挂起时发现，为历次拼接（splice）操作累积损伤的总爆发。

| # | 问题 | 状态 |
|---|------|------|
| INC-1 | **`/v1/chat/completions` 路由整体丢失**（agent 循环 + SSE 桥 + 审批桥），服务器正常启动但一切聊天请求**永久挂起**（无路由匹配亦无 404 兜底）——Web UI 完全不可用 | ✅ 从 git HEAD 原样恢复（130 行），404 else 一并恢复 |
| INC-2 | `/api/mode` 路由丢失（模式切换 404） | ✅ 从 HEAD 恢复（33 行） |
| INC-3 | `/api/settings`、`/api/models-config` 路由丢失（Web UI 设置面板无后端） | ✅ 按浏览器调用契约重写（GET+POST），含 .env 持久化与 models.json 热加载；Suite B settings-api 6/6 |
| INC-4 | createServer 回调缺闭合 `});`（语法错误暴露了本次事故） | ✅ |
| INC-5 | 路由清单与 HEAD 不齐（GET /api/models-config 缺失） | ✅ 补齐，`diff` 核对 13 条路由完全一致 |
| INC-6 | **孤儿进程污染**：被中断的测试运行留下 mock/server 占用固定端口，重跑时旧服务器带旧状态接听请求（假象：场景"通过"了旧代码） | ✅ 新增 test/kill-orphans.ps1 按命令行清理；runner-b 增 RUN_ONLY 空匹配警告 |
| INC-7 | 教训沉淀：拼接式改动后必须 ① 对比路由清单（`grep -o "req.url === '"` vs HEAD）② 跑含聊天场景的套件而非只测新路由；测试前先清孤儿进程 | ✅ 已记入维护约定 |

**回归证据**：A 74/74、B 93/93、I 34/34（2026-10-01，Node 24）。

---

## 维护约定

1. **唯一事实来源**：本文件。修复某条后：改状态列 + 附提交号；新问题追加到当日期小节；跨日期的大问题可新建日期小节用 INC-/NEW- 编号。
2. **提交纪律**：状态变更与对应代码修复同一提交；提交信息引用条目号（如 `fix(P1-1): ...`）。
3. **归档建议（OPT-9）**：KNOWN-ISSUES.md 与 REVIEW-CHECKLIST-2026-09-30.md 已冻结，可在下个版本删除或移入 `docs/history/`（删除前把仍有价值的历史叙述并入本文件）。
4. **套件计数防漂移（OPT-10）**：建议加 `scripts/count-assertions.js` 从各 runner 统计断言数写入本文档头部，替代手写。
