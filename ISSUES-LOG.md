# 7coder 问题与优化统一跟踪

> **本文件是唯一的问题跟踪文档**：按发现日期汇总所有问题与优化建议，逐条标注状态。
> 新问题一律追加到对应日期小节（无则新建小节）；修复后只改状态列，不删除历史行。
> `KNOWN-ISSUES.md` 与 `REVIEW-CHECKLIST-2026-09-30.md` 自本文件建立起冻结为历史快照，不再更新。
>
> 状态图例：✅ 已完成（附提交号/代码位置）｜🔶 部分完成（注明剩余部分）｜⬜ 未处理｜⛔ 不修（有明确决策）
>
> 规模快照（2026-10-01）：单文件 index.js（~3240 行），v2.16.0，套件当日复跑 A 74/74、B 93/93、I 34/34；
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
| P0-3 | index.js:2149 | HTTP 审批桥为模块级单例：并发流式客户端互相覆盖/摘除，审批丢失或串线 | ⬜ 未处理。改法：bridge 按请求创建经 processWithTools opts 传入；pendingApprovals 按连接隔离；补并发审批测试 |
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
| P1-14 | one-shot 失败退出码 | 失败仍 exit 0，脚本无法感知 | ✅ `process.exitCode = 1`（index.js:2567） |

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
| OPT-2 | 安全 | 未设 HTTP_API_KEY 时对写操作类 /api/*（settings/models-config/mode/sessions/save/delete/open/approve）默认拒绝或一次性确认 | ⬜（注意：P0-4 已⛔，本条是独立决策点，实施前先问用户） |
| OPT-3 | 结构 | index.js 拆分 tools/ + http-server.js + repl.js + security.js + context.js | ⬜（当前 ~3240 行；Win7/Node13 约束下需保持单入口） |
| OPT-4 | 测试 | 10 个 runner 公共件（rmrf/runCli/startMock/freshCwd）抽 test/_shared.js | ⬜（P0-1 正是复制粘贴的代价） |
| OPT-5 | 测试 | test/ 残渣清理：现存 313 个 cur-script-/mock-log-* 文件 + 222 个 w-* 目录；runner 结束时自清理 | ⬜ |
| OPT-6 | 并发 | 审批/会话按连接隔离后支持多客户端并发（依赖 P0-3） | ⬜ |
| OPT-7 | 测试 | RUN_ONLY 空匹配时非零退出（现仅有警告，0/0 仍 exit 0；= P1-6 剩余半） | ⬜ |
| OPT-8 | 测试 | 补回归断言：cron `every 0h` 拒绝（P0-2 剩余半）、run_tests_tool 真换行（随 P1-1）、writeWorkspaceEnv 注释保留（P1-4 剩余半）、rmrf 真删目录（P0-1 剩余半） | ⬜ |
| OPT-9 | 文档 | 冻结的历史文档（KNOWN-ISSUES.md、REVIEW-CHECKLIST-2026-09-30.md）移入 docs/history/ 或删除 | ⬜ |
| OPT-10 | 文档 | scripts/count-assertions.js 从各 runner 自动汇总断言数写入本文档头部，杜绝口径漂移（根治 P1-7） | ⬜ |
| OPT-11 | 测试 | runner 退出前清理本次运行产生的 cur-script-*/mock-log-*（OPT-5 的增量半） | ⬜ |

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
