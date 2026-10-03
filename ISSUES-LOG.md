# 7coder 问题与优化统一跟踪

> **本文件是唯一的问题跟踪文档**：按发现日期汇总所有问题与优化建议，逐条标注状态。
> 新问题一律追加到对应日期小节（无则新建小节）；修复后只改状态列，不删除历史行。
> `KNOWN-ISSUES.md` 与 `REVIEW-CHECKLIST-2026-09-30.md` 自本文件建立起冻结为历史快照，不再更新。
>
> 状态图例：✅ 已完成（附提交号/代码位置）｜🔶 部分完成（注明剩余部分）｜⬜ 未处理｜⛔ 不修（有明确决策）
>
> 规模快照（2026-10-03）：单文件 index.js（~3500 行），v2.16.0；AST 修复轮后 A–J 全绿 434 项（A 80/B 131/C 35/D 32/E 22/F 23/G 29/H 32/I 34/J 16）；
> 其余套件规模 C35/D32/E22/F23/G29/H32/J16 + K/R 真实端点 9+10 项，末次全绿见 git 历史。

<!-- assert-count:start -->
| 文件 | 静态断言点数 |
| --- | ---: |
| runner-b.js | 120 |
| runner-c.js | 36 |
| runner-d.js | 25 |
| runner-e.js | 22 |
| runner-f.js | 23 |
| runner-g.js | 31 |
| runner-h.js | 27 |
| runner-i.js | 32 |
| runner-j.js | 17 |
| runner-k.js | 11 |
| runner-r.js | 11 |
| runner.js | 52 |
| **合计** | **407** |

注：以上为静态断言点数（源码中 `record(` 调用次数，文件内 `function record` 定义已扣除），与套件实测通过数（套件运行输出统计）是两个口径，请勿混用。
<!-- assert-count:end -->

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
| P0-2 | index.js:665 | cron `every 0h` → ms=0 → armNext 同步无限递归崩溃 | ✅ 状态回翻 2026-10-03（此前漏翻）：代码 h<=0 返回 null 已修，OPT-8 的 a23 断言（every 0h → Unsupported schedule）已补齐剩余半 |
| P0-3 | index.js:2181-2199, 3060-3098 | HTTP 审批桥为模块级单例：并发流式客户端互相覆盖/摘除，审批丢失或串线 | ✅ 主会话实施（2026-10-01 深夜）：桥改为按请求局部对象，经 processWithTools opts.approvalBridge → safeExecuteTool → safeExecuteToolInner → askApproval 全链透传（workflow 内层经 executeToolRaw 第 4 参）；审批 id 带 6 位随机连接前缀防跨连接抢答；请求结束 dispose 清理未决审批；子代理/REPL/非流式路径行为不变；新增 approval-iso 并发场景 6 项断言（双流各得审批、id 前缀互异、批准 A 仅完成 A、B 保持挂起、批 B 后完成、写入真实落地） |
| P0-4 | index.js（GET /api/settings） | 明文下发 apiKey（未设 HTTP_API_KEY 时本机任意进程可读） | ⛔ 用户决策（2026-09-30）：不修，与使用场景无关 |

### P1 — 中

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| P1-1 | index.js:1715 | run_tests_tool 输出含字面 `'\n'`（单引号嵌在双引号串里） | ✅ 状态回翻 2026-10-03（此前漏翻）：真换行早已修复，OPT-8 的 ts3 断言（含 '[TESTS] command finished'、真 
、无字面 '
' 文本）已锁定该行为 |
| P1-2 | index.js /api/info | 未返回 version，Web UI 右上角恒显 "v?" | ✅ 状态回翻 2026-10-03（此前漏翻）：=DS-3，APP_VERSION 已注入 /api/info |
| P1-3 | webui.html | 模型选择只读不写 localStorage；模式下拉不回显 | ✅ setItem + `modeSel.value = info.mode`（webui.html:612,614） |
| P1-4 | writeWorkspaceEnv | 保存设置时整文件重序列化，注释与格式全丢 | ✅ 状态回翻 2026-10-03（此前漏翻）：逐行原地改写已实现，OPT-8 的 settings-api 注释保留断言（# KEEP-ME-COMMENT）已补齐剩余半 |
| P1-5 | index.js 默认值 vs 文档 | HTTP_PORT 8000/7103；MAX_TOKENS 2048/42000；TEMPERATURE 0.7/0.6 | 🔶 前两项已对齐文档（7103、42000）；TEMPERATURE 代码仍 0.7，.env.example 写 0.6 |
| P1-6 | INSTALL.md + runner | 验证命令场景名全不匹配 → 假绿（0/0 退出码 0） | ✅ 状态回翻 2026-10-03（此前漏翻）：=DS-9，十个 runner 空匹配 exit 1 已实现 |
| P1-7 | INSTALL/KNOWN-ISSUES | 套件数/断言数三处口径打架（"10 套件 334 项" vs 实际 12 runner 且 B 已 93 项） | ⬜ 未处理（建议脚本自动汇总，见 OPT-10） |
| P1-8 | README | 已决策不发 npm 但保留 "Now on NPM!" 教程 | ✅ npm 安装教程已移除 |
| P1-9 | pack-offline.js + dist/ | copyRec 排除 `e === 'w-'` 恒假；未排除 cur-*；dist 陈旧 v2.6.0 | 🔶 mock-log-/cur-script- 排除已加（pack-offline.js:47）；`w-` 前缀判断仍错、dist 未重打（仍是 7coder-v2.6.0-offline） |
| P1-10 | README + KNOWN-ISSUES | 内联代码整段丢失；KNOWN-ISSUES D4 条目重复 3 遍 | ✅ 状态回翻 2026-10-03（此前漏翻）：KNOWN-ISSUES 已随 OPT-9 归档 docs/history/，冻结快照不再修正文 |
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
| P2-4 | index.js:2353,2365 | backupFile 前后各调一次 pruneBackups（双全量遍历） | ✅ 状态回翻 2026-10-03（此前漏翻）：DS-14 重写 pruneBackups 时已删除写前调用，仅保留写后一次 |
| P2-5 | 审计日志 | argsPreview 原样落盘，可能记录密钥 | ✅ 状态回翻 2026-10-03（此前漏翻）：=OPT-1，sanitizeAuditArgs 已入库并有 audit-log 断言 |
| P2-6 | index.js / webui.html | server.listen 无 error 处理（EADDRINUSE 直接崩）；UI 每请求同步读盘 | ⬜ |
| P2-7 | test 工装 | `ping -n 2 … >nul`、`'\\mock-log-'` 硬编码 Windows 写法 | ⬜ |
| P2-8 | README:191 | "no modern JS syntax used" 不准确（ES2018+ 特性在用） | ✅ 状态回翻 2026-10-03（此前漏翻）：=DS-10，README 已改为 syntax stays within what Node.js 13.14 supports |
| P2-9 | KNOWN-ISSUES | 头部日期未更新；A12 状态过时（代码已 fail-fast） | ✅ 状态回翻 2026-10-03（此前漏翻）：KNOWN-ISSUES 已随 OPT-9 归档，过时状态随快照冻结 |
| P2-10 | parseTestOutput | 正则嵌套量词 `(\d+)+` ×4 | ✅ 已改为 `(\d+)`（现 grep 无嵌套量词） |
| P2-11 | index.js:1742 | git_status 口径："M " 同时计入 staged 与 modified | ✅ 状态回翻 2026-10-03（此前漏翻）：=DS-4，XY 分列已实现且 git-integration 4/4 无需改断言 |
| P2-12 | web 审批 | 120 秒超时自动拒绝无倒计时提示 | ⬜ |
| P2-13 | index.js:1537 | 截图 PNG 落工作区根不清理；auto_debug 无进度输出 | ⬜（截图进 .7coder/） |
| P2-14 | README/INSTALL | 打包机需现代 Node（pack-offline 用 rmSync）未声明 | ⬜ |
| P2-15 | ask_user_tool | 非交互模式返回 "skipped"，模型可能误读为已作答 | ⬜（改强指令文案） |
| P2-16 | webui.html:345,400 | 死代码 var keyOk / var sessionPath；.cursor 样式未定义 | ⬜ |
| P2-17 | .npmignore | 已决策不发 npm，文件去留未决 | ⬜ |

### 方向性优化建议（OPT）

| # | 方向 | 内容 | 状态 |
|---|------|------|------|
| OPT-1 | 安全 | 审计日志参数脱敏（=P2-5） | ✅ sanitizeAuditArgs：敏感键名→***，其余值清洗 Bearer/sk- 令牌；audit-log 场景断言明文不落盘 |
| OPT-2 | 安全 | 未设 HTTP_API_KEY 时对写操作类 /api/* 默认拒绝或一次性确认 | ⛔ 用户决策（2026-10-01）：维持现状不修——本机个人工具，loopback 默认 + 文档已有 LAN 警告；如未来需 LAN 长期暴露再重开（含 .env 重写劫持上游的升级说明，见 DS 系列核对表）。2026-10-02 补充证据（gpt-astra 探针）：无 key 时任意 Origin/Host 的 POST /api/mode 可切 bypass——重开时按 Origin/Host 校验 + CSRF token + 非 loopback 启动强制确认的低摩擦清单执行 |
| OPT-3 | 结构 | index.js（现 ~3420 行）按职责拆分模块；DS-13（audit 加 runId）随此一并 | ⬜ 用户决策暂缓（2026-10-02）：等功能需求触发或专项多轮安排；10-01 两起拼接事故说明迁移本身即高风险 |
| OPT-4 | 测试 | 12 个 runner 公共件抽 test/_shared.js | ✅ 2026-10-02 用户批准实施：主会话设计 _shared.js 并试点迁移 A/B（11e9a29），GLM-5.3-Flash 照配方迁移 C–J（8 文件 -892 行/+55 行，场景代码零改动）；rmrf/record/freshCwd/runCli/httpReq/汇总块收敛为单份实现；A–J 409 项全绿与迁移前一致。k/r 为真实端点套件结构不同，按设计不迁移。静态断言计数刷新为 382（每套件 -1，崩溃场景记录移入 _shared） |
| OPT-5 | 测试 | test/ 残渣清理 | ✅ 2026-10-02 存量清零（102 cur-script + 100 mock-log + 170 w-* + 4 杂项，14MB→~0）；增量由 OPT-11 自清理兜底 |
| OPT-6 | 并发 | 多客户端会话保存语义（审批隔离 P0-3 已就绪） | ⬜ 用户决策挂起（2026-10-02）：常用多标签时再做，需先定分桶语义 |
| OPT-7 | 测试 | RUN_ONLY 空匹配时非零退出 | ✅ 随 DS-9 关闭（10 个 runner exit 1） |
| OPT-8 | 测试 | 四条补断言（cron 0h / run_tests 真换行 / .env 注释保留 / rmrf 真删） | ✅ 全部落地于 adv-tools(a23)、tests-runner(ts3)、settings-api、rmrf-check 场景 |
| OPT-9 | 文档 | 冻结的历史文档移入 docs/history/ | ✅ 三份（含 deepseek 审阅原文）已归档并提交 |
| OPT-10 | 文档 | scripts/count-assertions.js 自动统计（--write 回填标记段） | ✅ 已入库并在 Node 13 运行时验证；静态口径 392 与实测 403 并列标注互不混淆 |
| OPT-11 | 测试 | runner 退出前自清理本次产物（ownArtifacts/ownWorkdirs 追踪） | ✅ 10 个 runner（k/r 用 tmpdir 无需）；验证：连续三套运行残渣零新增 |

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

## 2026-10-02 —— 编程 AI 工具能力差距审阅（GAP 系列）

> 视角：不是找 bug（历轮已扫），而是对标现代编码 agent（Claude Code / Aider / Cline 类）盘点 7coder 作为"编程 AI 工具"缺什么、什么值得优化。
> 方法：逐机制实码勘察（行号取自当前 HEAD ~3450 行版本），非印象流。
> 先说已有的优势面（避免片面）：路径沙箱 fail-closed、四权限模式 + 审批经济学（确定性风险表）、审计日志、备份/undo、会话持久化、双运行时 409 项测试纪律——这些在同体积工具里是超配。

### A 级——直接影响编程体验

| # | 现状（实码证据） | 差距 | 建议 | 代价 |
|---|------|------|------|------|
| GAP-1 | mcp_tool 走自定义协议 `POST {url}/invoke {tool,arguments}`（index.js:1429 附近）；MCP 生态实际标准是 JSON-RPC 2.0（stdio 传输为主，HTTP+SSE 次之） | **生态服务器一个都连不上**，"支持 MCP"名不副实 | 实现 stdio transport：spawn 子进程 + Content-Length 帧收发（零新依赖可行，纯管道不需要 PTY）；HTTP+SSE 二期；无配置时报错文案已修（P1-12） | 中 |
| GAP-2 | 三个命令工具全部 `execSync/execFileSync`，`cwd: launchDir` 写死（index.js:1143/1158/1167）；无交互进程支持 | ① `cd`/环境变量不跨命令保持，模型每条命令都从工作区根重来 ② REPL 型交互程序（python/node 交互式、npm login）完全无法运行 | bash_tool 维持常驻子进程（spawn + 命令队列 + 输出缓冲），保持 cwd/env；输出用"等待静默 N ms 或遇提示符"截取。Win7 无 conPTY，真终端不做，文档明示 | 中 |
| GAP-3 | read_file 全量读取**无行号**（仅 offset/limit 分支有 cat -n，index.js:1078-1090）；**无二进制检测**（=老 P1-6 未修，图片读成 U+FFFD 糊）；无 repo map，大仓库冷启动靠模型自己 ls/glob 摸索 | 编辑锚点不稳（无行号时 old_string 全靠记忆）；二进制白烧上下文；冷启动慢 | ① 全量读也带行号 ② 前 4KB 含 NUL 即拒绝并提示 ③ 任务启动时注入目录树摘要（git ls-files 或 glob 顶层两层，截断至 ~200 行）——三件都是小改动 | 小 |
| GAP-4 | 聊天通道**丢弃 image part**（套件断言即如此，runner-b httpx）；computer_use 截屏只返回文件路径（index.js:1582），模型"看不见"自己截的图；仅 web_browser 对图片 URL 调 describeWithVision（index.js:1279） | 视觉闭环断裂：不能看截图→不能真正基于屏幕决策；用户也不能贴图问问题 | ① 截屏后自动转 base64 data URL 走 VISION_MODEL describe 回填（管线已存在，只差接线）② 上游多模态时聊天透传 image_url | 中 |

### B 级——agent 能力增强

| # | 现状 | 差距 | 建议 | 代价 |
|---|------|------|------|------|
| GAP-5 | 无 LSP（=D3 老项未排期）；编辑后类型/语法错误只能等跑测试才发现 | 修错反馈环长 | 最小版先不做 LSP：加 diagnostics_tool 包装 `tsc --noEmit` / `eslint -f json`（按项目探测），编辑后模型可主动调用；完整 LSP 仍是周级工程 | 小→大 |
| GAP-6 | todo_write_tool 只是往 TODO.md 追加文本行 | 无结构化任务列表，无状态流转（doing/done），web UI 也无从展示进度 | 结构化 {id,title,status,updated} 存 `.7coder/todos.json`，工具改读写 JSON；web UI 侧栏渲染进度 | 小 |
| GAP-7 | REPL 仅固定命令（/bye /clear /undo /btw /resume /execute-task-now）；无 hooks | 用户无法沉淀自定义工作流（一键"跑测+修复"类），无法注入 pre/post-tool 规则（如"禁止改 src/legacy/**"） | ① `.7coder/commands/*.md` 斜杠命令展开为 prompt ② 工具调用前后钩子（复用审批管线位置，用户脚本 exit≠0 即拦截） | 中 |
| GAP-8 | 上游响应的 usage 字段完全未用（grep 无 prompt_tokens/usage 统计） | 无 token/费用可观测，长会话无感知 | callOpenAI 累计 usage 入会话与审计日志；REPL 提示符旁与 web UI 设置面板显示累计值 | 小 |
| GAP-9 | 记忆=7CODER.md 单文件（auto-log 标记节 + dream 整理）+ BTW.md | 扁平无分层：项目事实/用户偏好/临时笔记混一处，长了靠压缩 | 分层 memory（.7coder/memory/*.md 按主题）+ 任务启动时按关键词召回注入；dream 改为整理归档 | 中 |
| GAP-10 | web_search_tool 抓 lite.duckduckgo.com 的 HTML 用正则提链接（index.js:1262-1268） | 无 API、正则脆弱、易限流、无降级 | 保底可用的同时留 API 提供方配置（SearXNG/Bing/Brave 任一 key 即切换）；失败时明确告知而非空结果 | 小 |

### C 级——打磨与可选

| # | 现状 | 差距 | 建议 | 代价 |
|---|------|------|------|------|
| GAP-11 | PROTECTED_FILES 硬编码 12 项（index.js:489-493）；权限仅四模式 | 用户不可扩展保护清单，也无 allow/deny 规则 | `.7coder/permissions.json`：protected_extra/allow/deny（glob 规则），启动加载并公告 | 小 |
| GAP-12 | 备份按文件 5 份可 /undo 单文件；git_commit_tool 可整树快照 | 缺"本次任务改了什么"的汇总视图/检查点 | 任务结束时输出改动清单（backup/audit 已有数据可聚合）；或任务前自动 git stash-create 检查点 | 小 |
| GAP-13 | 上下文压缩按字符数近似（=C9 老项） | 字符≠token，CJK 尤其失真，压缩触发偏晚 | 引入轻量 tokenizer 估算（需验证 Node 13 兼容的纯 JS 实现）；或按 (字符+CJK×2) 折算近似 | 中 |
| GAP-14 | 会话线性：resume 载入最新一份，无分支 | 无法"回到三轮前试另一条路" | 低优先；sessions/ 已有时间戳副本，补"从第 N 轮分叉"命令即可 | 中 |

### 与既有条目的关系

- GAP-3 的二进制半 = 老 P1-6（09-30 清单，一直 ⬜）；GAP-5 = D3 的务实降级版；GAP-13 = C9；GAP-1 修正了 README 对 MCP 的表述基础（当前文档宣称的 MCP 支持实为自定义协议，建议文档同步改口或实施本项）。
- 全部 GAP 为新增待决项，不与已关闭条目冲突；实施顺序建议：GAP-3（纯小改）→ GAP-8/10/6（小）→ GAP-1（生态价值最大）→ GAP-2/4/5/7/9/11/12 → GAP-13/14。

---

## 2026-10-02（晚）—— gpt-astra 审阅核对（AST 系列）

> 输入：`gpt-astra审阅.md`（双运行时探针复现 + 隔离目录安全验证 + 真实模型补测 20/20）。
> 核对方式：主会话逐条对当前代码验证（本节行号为 HEAD 6963444 后版本）。
> 总评：**11/11 条 AST 问题全部对码属实，无不实条目**（对照 deepseek 报告 5 条不实，本报告的"已复现"标签与代码事实全部一致）。其核心论断成立：现有测试通过不能证明权限边界、数据保存与错误传播正确。
> 用户指令为核对合并、未要求本轮修复；建议修复批次 = 报告阶段一（AST-01~06 先行）。

### P1 — 破坏审批边界 / 泄露 / 丢数据（全部核对属实）

| # | 位置 | 问题（核对结论） | 状态 |
|---|------|------|------|
| AST-01 | index.js:1774-1777, 1801-1810 | **只读 Git 工具 shell 注入**：git() 用 `execSync("git " + args)` 字符串拼接；git_diff_tool 把模型可控的 path 经 JSON.stringify 后拼入（JSON 转义≠shell 转义），且在 AUTO_SAFE 清单免审批——一次"只读 diff"可执行任意命令，还绕过 isSuperDangerous。commit 的 message 同模式 | ✅ 13a4b70：git() 全部参数数组化（execFileSync + shell:false 语义），路径/提交信息为单参数；注入探针零落盘（ast-security 2 断言） |
| AST-02 | index.js:2095-2107 | **受保护文件写入审批被绕过**：auto-safe 分支只排除 protectedRead 未排除 protectedWrite；`write_file("7coder.md/../.env")` 命中 `includes('7coder.md')` 自动放行，实际写入 .env（basename 检查已算出 .env 却被字符串包含判断劫持） | ✅ 13a4b70：auto-safe 分支否决 protectedWrite，7CODER.md 豁免改规范化后精确匹配工作区根；穿越写 default 被拒 / bypass 被 BLOCK（ast-security 2 断言） |
| AST-03 | index.js:265-269, 2129-2141 | **auto 模式 workflow 全程零审批 + 全局状态跨请求泄漏**：外层 workflow_tool 无条件放行（注释称"内层逐步检查"，但内层继承分支恰恰跳过检查——注释与实现自相矛盾）；探针证实"审批模型设为永远拒绝，普通写被拒、放进 workflow 却执行"。workflowStepDepth/subAgentModeOverride/agentDepth 均为模块级全局，并发请求互相污染（P0-3 只修了审批桥这一个全局） | ✅ 13a4b70：auto 模式 workflow 外层恢复 isAutoApprovalSafe 审批（拒绝型轻模型现在能拦住计划）；三个全局变量用 requestGate 请求级串行隔离（HTTP 请求端到端串行，语义变化记录在案：多标签排队，与 OPT-6 挂起决策一致）；approval-iso 重写为串行语义 5 断言 |
| AST-04 | index.js:489-493, 2087-2090；.gitignore | **模型配置密钥可被模型自动读取并可入 git**：models.json（含 apiKey）不在 PROTECTED_FILES，read_file 是 AUTO_SAFE → 免审批全文返回给模型；`.gitignore` 未忽略 `.7coder/`，git_commit_tool 默认 `add -A` 可把含密钥的 models.json 提交进库。审计首行泄露仅在紧凑 JSON 时成立（次要）。注意：这与 P0-4 ⛔（界面显示密钥）是不同问题——本条是模型可读 + 可提交 | ✅ 主会话终检调整后合并：models.json 入 PROTECTED_FILES（读走审批/写被 BLOCK，断言 ×2）；git_commit_tool 的 add -A 改 pathspec 排除 :(exclude).7coder/（主会话将 GLM 的自动改写用户 .gitignore 方案替换为此最小侵入方案，已有意跟踪的文件不受影响）；仓库 .gitignore 增 .7coder/；断言 ls-files 无 .7coder/ |
| AST-05 | index.js:1231-1262 | **下载失败删除既有文件**：dest 先建流（truncate 已有文件），catch 无条件 `unlinkSync(dest)`——503/断网即毁掉原文件，无需攻击者 | ✅ 同目录 .part- 临时文件事务：成功才替换，失败只清 temp 绝不碰 dest；ast-download 场景 6 断言（连接拒绝后原文件原样、无 .part 残留、200 下载逐字正确） |
| AST-06 | webui.html:342, 401-408 | **Web 新会话永不首次保存**：autoSaveSession 在 `!sessFile` 时早退，而 sessFile 只在加载旧会话时设置——首次保存鸡生蛋。既有测试只测服务端路由、未测前端触发（盲区实锤）；此前"会话自动保存"实际只覆盖"已加载会话"的增量 | ✅ autoSaveSession 允许首存（不带 file，响应回传后 rememberSessFile）；三重验证：服务端契约场景 webui-firstsave 5/5、GLM 自建 test/webui-dom-sim.js DOM 模拟 8/8、主会话浏览器实测（首条消息后 web-*.json 落盘两轮完整） |

### P2 — 可靠性 / 可观测性（核对属实）

| # | 位置 | 问题（核对结论） | 状态 |
|---|------|------|------|
| AST-07 | webui.html:538 | **SSE 业务错误被吞**：catch 仅当 message 含 `upstream` 才重抛；`API error 401`/`Max retries reached` 等被当普通内容忽略，用户看到空回复不知失败 | ✅ JSON.parse 独立 try/catch，j.error 脱离吞错 catch 原样上抛；非 upstream 文案不再被吞；webui-dom-sim 3 断言 + 浏览器实测（死端点 → 气泡显示 错误: Max retries reached.——正是旧过滤器吞掉的类型） |
| AST-08 | /api/settings + writeWorkspaceEnv | **设置值换行注入环境变量**：仅校验字符串类型，值含 `\nPERMISSION_MODE=bypass` 可落盘成独立配置行；且运行时全局先改后写盘，写失败出现"接口报错但已切换"的不一致 | ✅ /api/settings 拒绝含 CR/LF/NUL 的值（400），endpoint 强制 http(s) 前缀；落盘成功后才更新内存；settings-api 场景 5 条新断言（注入 400、.env 无污染、正常路径不回归） |
| AST-09 | 全部 exec 路径 | **同步子进程阻塞 HTTP 事件循环 + 取消不贯穿**：execSync 单次可跑数分钟，期间健康查询/审批/取消全部排队；cancel 只在工具循环边界生效，未传入 axios/子进程/子代理（与 GAP-2 部分重叠但角度不同：本条是阻塞与取消，GAP-2 是状态与交互） | ⬜ |
| AST-10 | 各 POST 路由 | **请求体上限只设标志不停止累积**：聊天路由 oversized=true 后继续 `body += chunk` 到 end 才 413；其余 POST 路由（approve/save/settings/mode 等）完全没有上限 | ⬜ |
| AST-11 | index.js:1706-1709 vs 2057-2060 | **两张失败判定正则漂移**：workflow 步骤失败正则比审计正则少 `List error`/`Download error`/`Input error`/`Kill error` 等前缀——list_dir 失败后工作流继续执行后续写步骤并报 `[OK] Workflow complete`；`Auto-approval declined` 两边都不认；denial 拒绝在审计里记 `status:"ok"`。= deepseek 建议 5.2（结构化 ToolResult）的实证，二者合并处理 | ✅ 13a4b70（最小版）：TOOL_FAIL_RE 单一失败判定源统一喂 workflow 步停判定与审计状态映射；denial 记 blocked、List error 步骤停批（ast-security 2 断言）。完整结构化 ToolResult 仍留待后续（随 P2-5/建议 5.2） |

### 测试与打包配套问题（核对属实）

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| AST-12 | test/runner.js cli-exit 场景 | r3 直连 `https://api.openai.com`（空 key 的真实外网请求）；r1/r2/r3 均未设隔离 cwd → 每次跑套件 A 都在仓库根产生 7CODER.md/.7coder_last_interaction（此前误归因于主会话手动测试，实为套件自身污染仓库根） | ✅ cli-exit 三子进程全部隔离 cwd；r3 端点改 .example 保留域（仍触发远端告警、DNS 秒败无真实外网）；跑后仓库根零污染 |
| AST-13 | scripts/pack-offline.js:34-47 | COPY_FILES 仍引用已归档的 KNOWN-ISSUES.md（OPT-9 移动后未同步，缺失时静默跳过）；`e === 'w-'` 恒假的老 P1-9 半截仍在；依赖树直拷非干净构建（P1-9 升级合并至此） | ✅ COPY_FILES 移除已归档的 KNOWN-ISSUES.md；排除规则 w-/cur- 前缀修正（fail-first 实证 w-packprobe/cur-zzz.json 曾泄漏入 dist，修复后干净） |

### 真实模型补测的观察（R1/R2 已于 2026-10-03 正式立项，见下表；Origin/Host 探针并入 OPT-2 备注，⛔ 决策不变，重开时按低摩擦清单执行）

### 补充发现（修复过程中 + 真实模型补测）

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| AST-14 | test/mock-server.js + 各 runner | 裸字符串 mock 步骤（如 'WF-DONE'）没有 .content 属性 → mock 发空 delta → 客户端报 empty streamed response → 错误路径也写 [DONE]。多数场景恰好在工具结果上断言所以仍过，但意味着这些用例的最终回复从未真实到达、7CODER.md 摘要被跳过。approval-iso 已改对象步骤根治；其余场景的字符串尾步骤属已知无害怪癖 | ⬜ 低优先清理（改对象步骤 + 可选让 mock 对字符串步骤报错） |
| AST-15 | requestGate 语义 | HTTP 聊天请求端到端串行后，长审批等待会阻塞后续请求（单用户工具可接受；approval-iso 已锁定该语义）。根治=ExecutionContext 线程化（AST-09 同族） | 🔶 随 AST-09 一并考虑 |
| AST-R1 | index.js summarizeAction | 真实模型补测实测：7 次任务摘要吃掉 71.1% 输出 tokens / 67.7% 上游耗时——summarizeAction 无独立 maxTokens、与主模型共用配置（同 4096 上限），非流式请求同步等待摘要 | ⬜ 已立项（2026-10-03）：摘要独立 maxTokens（如 512）+ 可配 SUMMARY_MODEL；低价值短回复跳过摘要；非流式不等待（后台化）。省钱立竿见影，小改 |
| AST-R2 | 审批链路 | 语义等价的编辑因参数表述不同被轻模型先拒后批（declined→ok 实录）——YES/NO 单字判定承担硬边界过载 | ⬜ 已立项（2026-10-03）：审批拒绝原因结构化入审计（declined 的 reason 字段）；确定性规则为主、模型判断为辅；与 GAP-11（可配置 allow/deny 规则）天然同族可合并实施 |


- 5.3 Node 13 EOL 双轨构建：离线包已捆绑运行时并明确面向 Win7，现状覆盖主要诉求；LTS 双轨是新工程，不并入待办，重开 OPT-3 时参考。
- 7.4 "机器可维护状态索引"：与 OPT-10 同方向，并入 OPT-10 备注（统一 ID/状态/提交/验收字段）。
- 第十一节 11.6/11.7/11.8（端点对账、qwen3.8-flash 单次验证）为环境验证记录，非项目问题，不入表。

---

## 维护约定

1. **唯一事实来源**：本文件。修复某条后：改状态列 + 附提交号；新问题追加到当日期小节；跨日期的大问题可新建日期小节用 INC-/NEW- 编号。
2. **提交纪律**：状态变更与对应代码修复同一提交；提交信息引用条目号（如 `fix(P1-1): ...`）。**跨号联动（2026-10-03 增补）**：当以新编号（DS-/AST-/OPT- 等）修复的问题在旧表有同源行时，必须在同一提交内回翻旧行状态——2026-10-03 盘点发现 11 行"账实不符"正是只记新区块、漏翻旧行所致。
3. **归档（OPT-9 已执行 2026-10-02）**：KNOWN-ISSUES.md、REVIEW-CHECKLIST-2026-09-30.md、deepseek4.1flash审阅.md 已移入 `docs/history/`，只读历史快照，不再更新。
4. **套件计数防漂移（OPT-10 已执行 2026-10-02）**：`scripts/count-assertions.js --write` 回填头部标记段；实测通过数在规模快照行手写，两口径并列标注。
