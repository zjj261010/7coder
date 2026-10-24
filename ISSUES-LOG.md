# 7coder 问题与优化统一跟踪

> **本文件是唯一的问题跟踪文档**：按发现日期汇总所有问题与优化建议，逐条标注状态。
> 新问题一律追加到对应日期小节（无则新建小节）；修复后只改状态列，不删除历史行。
> `KNOWN-ISSUES.md` 与 `REVIEW-CHECKLIST-2026-09-30.md` 自本文件建立起冻结为历史快照，不再更新。
>
> 状态图例：✅ 已完成（附提交号/代码位置）｜🔶 部分完成（注明剩余部分）｜⬜ 未处理｜⛔ 不修（有明确决策）
>
> **最新待办索引（2026-10-22）**：见本文「2026-10-22 —— 双阶段审阅合并待办」：33 项修复/工程任务、8 项专项验证，以及保留的暂缓/不做项。已合并两轮审阅与既有账目；本次只整理清单，未修产品代码、未运行测试。下方历史回归通过记录不代表这些新增故障已关闭。
>
> **执行进度（2026-10-23）**：T22-01 测试隔离改造、T22-02 启动器兼容修复已落地，暂列部分完成；隔离专项10/10、CLI定向3/3、权限sec1定向10/10通过。首轮隔离fixture格式错误及获准单次复跑如实记于10-23执行记录；完整A–J、最终shim变更及Win7/清理脚本实机验收未运行，不能宣称整单完成。
>
> **第二批进度（2026-10-23）**：T22-04/T22-05已完成本批修复与定向验收：Node13语法3/3、新增stream-context 31/31、旧compress-edges 2/2，均单次执行。实际HTTP故障恢复已验证；完整回归、Win7实机、真实模型摘要质量和取消/进程树等其它发布门槛仍未完成。
>
> 当前状态（2026-10-13）：本轮修复 P1-1/OP2-3、NEW-1 模型清单、NEW-2 cron 重叠执行，并同步关闭 OPT-8 的 ts3 验收缺口。A2-10、A2-16、AST-R1 已补翻完成状态；OPT-13~16 及既有暂缓项仍保留；OPT-12 已完成统一元数据；GAP-8/12、OPT-17 与 P2-7 已按 10-13 补齐范围验收，不能称全部待办清零。详见文末清账与修复记录。
> 历史发布快照（v2.18.0，`1f52a8a`）：离线包 dist/7coder-v2.18.0-offline-win64.zip（21.6MB、449 条目、零残渣零 .env、内置 Node 13.14.0 冒烟通过）。该产物早于后续 OP2/A2 修复，不能据此宣称包含修复；本轮未重新打包。
> 本轮回归（2026-10-20，**OPT-13 第四批**）：7 个校验/查找缺口工具（skill_tool/todo_write_tool/task_create_tool/task_stop_tool/cron_delete_tool/process_kill_tool/agent_tool）迁移结构化 ToolResult（同前三批分工）。七类失败文本此前均不在 TO_FAIL_RE、被推断为 ok，现获显式 error：`Skill error:`/`Skill "x" not found`/`Task error: command is required`/task_stop 的 `Task not found`/`Cron job not found:`/`Invalid PID`/`Agent error:`。语义决定并锁定：task_stop 幂等停止（`already <status>`）保持 ok（b4 绿记录）。enter_worktree_tool 的 `Worktree error:` 缺口**本轮主动不做**——freshCwd 位于真实仓库内，活体反例会向真 .git 写 worktree 元数据（副作用），留待清扫批代码审查确认。先红后绿：实施前 runner-b 失败记录恰 4 条、runner-i 恰 1 条。全绿门禁：node --check + runner-b **335/335** + runner-i **54/54** + runner(A) 88/88 + test-all 12 目标全绿；**Node 13.14.0 复验 B 335/335、I 54/54、A 88/88**。task_create 的 shutting-down、agent/process_kill/skill 成功路径活体不可构造或不宜构造，由代码审查确认。
> 本轮回归（2026-10-20，**OPT-13 第三批**）：7 个状态读取/内容透传工具（task_get/task_list/task_output/memory_tool/list_mcp_resources/read_mcp_resource/prompt_from_file）迁移结构化 ToolResult（同批二分工：tierflow_pro 照规格执行＋门禁红绿，主会话终检）。先红后绿：实施前 runner-b 失败记录恰 4 条（任务输出/prompt 文件/MCP 资源的内容透传前缀误判×2、Task/File/Resource not found 三类推断缺口、workflow 跨错误样任务输出中断）、runner-i 恰 1 条。全绿门禁：node --check + runner-b **328/328** + runner-i **53/53** + runner(A) 88/88 + test-all 12 目标全绿；**Node 13.14.0 复验 B 328/328、I 53/53、A 88/88**。list_mcp_resources 的 catch 前缀 `MCP resource list error:` 不匹配 TO_FAIL_RE 的 `MCP error`（推断缺口）一并修复，活体反例不可构造由代码审查确认。**附带观察（不修）**：任务 id `task-<13位时间戳>-N` 含 `sk-<数字>` 子串，SSE/审计展示侧 sanitizeAuditLine（index.js:419）会把它掩码成 `task-***-1`——展示侧脱敏的预期副作用，模型侧文本未脱敏、功能无损；测试侧以同款归一化适配（b3 场景 norm 辅助）。
> 本轮回归（2026-10-20，**OPT-13 第二批**）：7 个只读工具迁移结构化 ToolResult（弱模型 tierflow_pro 照规格执行＋门禁红绿，主会话终检）。先红后绿：实施前 runner-b 失败记录恰 4 条（glob/grep/workflow 三条内容驱动误判反例＋git_diff 脏树 declined 反例——第 4 条由红测试编写员实证发现：freshCwd 在仓库内、未提交 diff 文本含 declined 被 `/declined/i` 旧推断误判，恰是本批要修的误判类）、runner-i 恰 1 条。全绿门禁：node --check + runner-b **322/322** + runner-i **52/52** + runner(A) 88/88 + test-all 12 目标全绿；**Node 13.14.0 目标运行时复验 B 322/322、I 52/52、A 88/88**。过程中修正两处我方工件缺陷（红测试规格的文本身份匹配在 process_list >12000 字符被 SSE 截断时失配→前缀键匹配；门禁把 `FAILED:` 汇总行计入失败记录数）。process_list_tool 错误路径无法构造活体反例（tasklist 难以强制失败），由代码审查确认（r.error 分支显式 error）。
> 本轮回归（2026-10-17，**v2.19.0 发布轮**）：test-all 12 目标全绿（A 88/B 314/C 35/D 32/E 22/F 23/G 29/H 32/I 51/J 16 = 609 离线断言，另有 ui-sim 43 + dom-sim + 可选真实 Chrome）；Node 13.14.0 目标运行时 A 88/88；真实端点 kimi-k2.7-code（用户指定，网关探针通过、reasoning 正常）：**R 9/10、K 5/9**——失败均为 auto 审批保守（verdict 探针：JSON 解析正常、AST-R2 拒绝理由正常浮现；qwen3.7-plus 同代码曾 10/10 与 9/9，属模型气质差异非产品缺陷）；**bypass 复跑佐证**：新增 `REAL_PERM` 透传（test/runner-k.js、test/runner-r.js）后以 `REAL_PERM=bypass` 重跑，K 6/6（real-coding/real-workflow/real-fix 全过）、R **10/10**（含 R3 counter.txt）——确认失败根因确为审批保守；离线包 dist/7coder-v2.19.0-offline-win64.zip（21.7MB、457 条目、零残渣零 .env、runtime 冒烟通过）。
> 本轮回归（2026-10-15，OPT-14）：A–J **635/635**（A85/B312/C35/D32/E22/F23/G29/H32/I51/J16）；UI mock 43/43、DOM 12/12、真实 Chrome 9/9，完整入口 13/13 targets 通过。状态路径专项 5/5；静态断言 **604**。

<!-- assert-count:start -->
| 文件 | 静态断言点数 |
| --- | ---: |
| runner-b.js | 349 |
| runner-c.js | 36 |
| runner-d.js | 25 |
| runner-e.js | 22 |
| runner-f.js | 23 |
| runner-g.js | 31 |
| runner-h.js | 27 |
| runner-i.js | 55 |
| runner-j.js | 17 |
| runner-k.js | 11 |
| runner-r.js | 11 |
| runner.js | 60 |
| **合计** | **667** |

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
| A12 | 解析器怪癖：空 `--prompt ""` 静默进 REPL；未知 flag 并入任务文本 | ⛔ 用户决策（2026-10-03）：严格解析模式不做——两遍解析的词序重排为既定设计保留；空 prompt fail-fast 部分此前已修（index.js:56 exit 1） |
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
| C9 | 压缩按字符数近似 token | ⛔ 精确 tokenizer 不做（2026-10-04 决策，见 GAP-13）；CJK 加权启发式已完成（fe360b9），不再作为未处理缺陷 |

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
| P0-1 | test/runner*.js ×10 | `rmrf` 自递归（调自身而非 fs.rmSync），工作区清理静默无效 | ✅ 22d2845 全部改为 fs.rmSync（保留 Node 13 回退）；"目录确实被删"专项断言未加 → 断言部分已随 OPT-8 的 rmrf-check 落地 |
| P0-2 | index.js:665 | cron `every 0h` → ms=0 → armNext 同步无限递归崩溃 | ✅ 状态回翻 2026-10-03（此前漏翻）：代码 h<=0 返回 null 已修，OPT-8 的 a23 断言（every 0h → Unsupported schedule）已补齐剩余半 |
| P0-3 | index.js:2181-2199, 3060-3098 | HTTP 审批桥为模块级单例：并发流式客户端互相覆盖/摘除，审批丢失或串线 | ✅ 主会话实施（2026-10-01 深夜）：桥改为按请求局部对象，经 processWithTools opts.approvalBridge → safeExecuteTool → safeExecuteToolInner → askApproval 全链透传（workflow 内层经 executeToolRaw 第 4 参）；审批 id 带 6 位随机连接前缀防跨连接抢答；请求结束 dispose 清理未决审批；子代理/REPL/非流式路径行为不变；新增 approval-iso 并发场景 6 项断言（双流各得审批、id 前缀互异、批准 A 仅完成 A、B 保持挂起、批 B 后完成、写入真实落地） |
| P0-4 | index.js（GET /api/settings） | 明文下发 apiKey（未设 HTTP_API_KEY 时本机任意进程可读） | ⛔ 用户决策（2026-09-30）：不修，与使用场景无关 |

### P1 — 中

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| P1-1 | index.js run_tests_tool | 输出含游离单引号 | ✅ 2026-10-11 修复（index.js run_tests_tool）：移除成功/失败、有摘要/无摘要四条路径中包裹换行的单引号；tests-runner 用完整分隔文案替换 ts3 错目标断言，并补另外三条路径，先红后绿。此前两次假关闭及 1beb939 的“真实关闭”声明仍保留为历史事故，见清账记录 |
| P1-2 | index.js /api/info | 未返回 version，Web UI 右上角恒显 "v?" | ✅ 状态回翻 2026-10-03（此前漏翻）：=DS-3，APP_VERSION 已注入 /api/info |
| P1-3 | webui.html | 模型选择只读不写 localStorage；模式下拉不回显 | ✅ setItem + `modeSel.value = info.mode`（webui.html:612,614） |
| P1-4 | writeWorkspaceEnv | 保存设置时整文件重序列化，注释与格式全丢 | ✅ 状态回翻 2026-10-03（此前漏翻）：逐行原地改写已实现，OPT-8 的 settings-api 注释保留断言（# KEEP-ME-COMMENT）已补齐剩余半 |
| P1-5 | index.js 默认值 vs 文档 | HTTP_PORT 8000/7103；MAX_TOKENS 2048/42000；TEMPERATURE 0.7/0.6 | ✅ TEMPERATURE 默认 0.7→0.6（与 .env.example 对齐），快赢批②（GLM-5.3-Flash + 主会话终检） |
| P1-6 | INSTALL.md + runner | 验证命令场景名全不匹配 → 假绿（0/0 退出码 0） | ✅ 全部三个半完成：二进制拒绝（[BINARY] 文案）与空文件 (empty file) 由快赢批② GAP-3b 落地；offset 越界提示（beyond EOF - file has N lines）由主会话终检补齐（readfmt 4 断言） |
| P1-7 | INSTALL/KNOWN-ISSUES | 套件数/断言数三处口径打架（"10 套件 334 项" vs 实际 12 runner 且 B 已 93 项） | ✅ 2026-10-04 尾巴批：INSTALL.md 去硬编码口径（十二套件 A–J 离线 + K/R 真实端点，断言数指向 scripts/count-assertions.js），顺带修正截图新路径与 /fork 命令表；根治工具 OPT-10 早已入库 |
| P1-8 | README | 已决策不发 npm 但保留 "Now on NPM!" 教程 | ✅ npm 安装教程已移除 |
| P1-9 | pack-offline.js + dist/ | copyRec 排除 `e === 'w-'` 恒假；未排除 cur-*；dist 陈旧 v2.6.0 | ✅ 全部完成（2026-10-04 发布轮）：排除规则 w-/cur- 前缀已修（AST-13 轮）；陈旧 v2.6.0 产物已由 v2.17.0 替代（dist/7coder-v2.17.0-offline-win64.zip，21.6MB，449 条目零残渣零 .env，内置 Node 13.14.0 冒烟通过）；旧 v2.6.0 文件夹/zip 留在 dist/ 待用户自行清理 |
| P1-10 | README + KNOWN-ISSUES | 内联代码整段丢失；KNOWN-ISSUES D4 条目重复 3 遍 | ✅ 状态回翻 2026-10-03（此前漏翻）：KNOWN-ISSUES 已随 OPT-9 归档 docs/history/，冻结快照不再修正文 |
| P1-11 | git 54d09d7 | 提交信息 GBK 乱码 | ✅ `git config i18n.commitencoding utf-8` 已设 |
| P1-12 | index.js mcp_tool | 无配置时返回 "[OK] executed locally" 假装成功 | ✅ 改为明确报错（"MCP error: no endpoint configured…"，index.js:1453） |
| P1-13 | isSuperDangerous | 误报（'shutdown' 等宽子串）+ 漏报（无 PowerShell 模式） | ✅ 模式收窄（`rm -rf /`、`del /f /q c:\` 等）+ 新增 remove-item -recurse -force / format-volume / stop-computer / clear-disk / initialize-disk |
| P1-14 | one-shot 失败退出码 | 失败仍 exit 0，脚本无法感知 | ✅ 完整修复（DS-1）：flushExit 尊重 process.exitCode；套件 A/B 断言已锚定新契约（失败 exit 1） |

### P2 — 低

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| P2-1 | index.js 多处 | `.7coder_last_interaction`、`7C.dream.lock`、BTW.md 等散落工作区根 | ✅ 2026-10-04 尾巴批：.7coder_last_interaction/7C.dream.lock/BTW.md 全部收纳进 .7coder/；migrateWorkspaceRootFiles() 启动幂等迁移（时间戳/锁 rename 保 mtime 供陈锁检查，BTW 并入后删旧）；读旧路径兜底；5 处测试断言同步（契约变更）；dream 场景新增迁移子用例 |
| P2-2 | index.js:1993 | 过时注释 "input actions are simulated no-ops"（A7 已实现真实输入） | ✅ 注释更新为真实注入现状（Windows user32/SendKeys，非 Windows 警告） |
| P2-3 | grepSearch/recursiveReaddir | 整读文件无上限、不跳过 node_modules/.git、无深度上限 | ✅ 2026-10-04（GLM-5.3-Flash + 主会话终检）：预算走 opts 可选参数默认全关——pruneBackups 内部调用零语义变化（backup-cap 回归绿）。模型侧：glob/brief 传 {skipHeavy(跳 node_modules/.git/dist/.cache), maxDepth:12, maxEntries:1000+哨兵}；grep 传 {skipHeavy}（>2MB 跳过 + 前 4KB NUL 二进制检测 + 5000 文件扫描上限 + 每文件 50 匹配行上限）。schema 说明同步。scan-caps 5 断言先红 0/5（现行为确实返回 node_modules/大文件/二进制）后绿 |
| P2-4 | index.js:2353,2365 | backupFile 前后各调一次 pruneBackups（双全量遍历） | ✅ 状态回翻 2026-10-03（此前漏翻）：DS-14 重写 pruneBackups 时已删除写前调用，仅保留写后一次 |
| P2-5 | 审计日志 | argsPreview 原样落盘，可能记录密钥 | ✅ 状态回翻 2026-10-03（此前漏翻）：=OPT-1，sanitizeAuditArgs 已入库并有 audit-log 断言 |
| P2-6 | index.js / webui.html | server.listen 无 error 处理（EADDRINUSE 直接崩）；UI 每请求同步读盘 | ✅ 两半齐：server.on(error) EADDRINUSE 友好提示 + flushExit(1)（eaddr 断言：退出码 1、含 HTTP_PORT 提示、无原生堆栈）；webui.html 启动读一次缓存 Buffer 复用；前端侧核查无每请求重读盘逻辑 |
| P2-7 | test 工装 | `ping -n 2 … >nul`、`'\\mock-log-'` 硬编码 Windows 写法 | ✅ 2026-10-13 补齐：A/B/C 三处 ping 等待改为 Node 定时器命令；mock 路径、目录枚举、唯一工作区回退已完成。10-12 提前关闭时遗漏这三处命令；此处仅关闭这些已知工装问题，不声称 Linux/macOS 全量已实测（见 C4） |
| P2-8 | README:191 | "no modern JS syntax used" 不准确（ES2018+ 特性在用） | ✅ 状态回翻 2026-10-03（此前漏翻）：=DS-10，README 已改为 syntax stays within what Node.js 13.14 supports |
| P2-9 | KNOWN-ISSUES | 头部日期未更新；A12 状态过时（代码已 fail-fast） | ✅ 状态回翻 2026-10-03（此前漏翻）：KNOWN-ISSUES 已随 OPT-9 归档，过时状态随快照冻结 |
| P2-10 | parseTestOutput | 正则嵌套量词 `(d+)+` | ✅ 真实关闭（3926e3f，OP2-1）：三处改 `(d+)` + 限长；证据 = sec1 计时/源码/形态三断言 + 本行 2026-10-04 假✅纠正记录 |
| P2-11 | index.js:1742 | git_status 口径："M " 同时计入 staged 与 modified | ✅ 状态回翻 2026-10-03（此前漏翻）：=DS-4，XY 分列已实现且 git-integration 4/4 无需改断言 |
| P2-12 | web 审批 | 120 秒超时自动拒绝无倒计时提示 | ✅ 2026-10-04 尾巴批：webui 审批条 120 秒倒计时（每秒递减、点击清除、到 0 显示超时并禁用按钮——不重复发拒绝，服务端桥本就 120s 自动 resolve(false)）；dom-sim 8/8 不受影响 |
| P2-13 | index.js:1537 | 截图 PNG 落工作区根不清理；auto_debug 无进度输出 | ✅ 2026-10-04 尾巴批：截屏改写 .7coder/screenshots/（mkdir 包裹，无显示环境失败路径不变）；无测试引用旧路径，无需迁移 |
| P2-14 | README/INSTALL | 打包机需现代 Node（pack-offline 用 rmSync）未声明 | ✅ README/INSTALL 各加打包机 Node >= 14.14 声明（fs.rmSync 两处已核实） |
| P2-15 | ask_user_tool | 非交互模式返回 "skipped"，模型可能误读为已作答 | ✅ 非交互两分支改强指令文案（User is unreachable... Do NOT assume an answer...）；runner-h 旧文案断言同步收紧；sub-agent 分支保留 |
| P2-16 | webui.html:345,400 | 死代码 var keyOk / var sessionPath；.cursor 样式未定义 | ✅ var keyOk / var sessionPath 已删；.cursor 为活代码（流式指示器），补闪烁动画样式而非删引用（webui-dom-sim 8/8 复验） |
| P2-17 | .npmignore | 已决策不发 npm，文件去留未决 | ✅ 用户决策执行（2026-10-03）：已删除。文件仅一行 .env、只在 npm 发布时生效，B5 已决策不发布；.env 已由 .gitignore 覆盖，无损失 |

### 方向性优化建议（OPT）

| # | 方向 | 内容 | 状态 |
|---|------|------|------|
| OPT-1 | 安全 | 审计日志参数脱敏（=P2-5） | ✅ sanitizeAuditArgs：敏感键名→***，其余值清洗 Bearer/sk- 令牌；audit-log 场景断言明文不落盘 |
| OPT-2 | 安全 | 未设 HTTP_API_KEY 时对写操作类 /api/* 默认拒绝或一次性确认 | ⛔ 用户决策（2026-10-01）：维持现状不修——本机个人工具，loopback 默认 + 文档已有 LAN 警告；如未来需 LAN 长期暴露再重开（含 .env 重写劫持上游的升级说明，见 DS 系列核对表）。2026-10-02 补充证据（gpt-astra 探针）：无 key 时任意 Origin/Host 的 POST /api/mode 可切 bypass——重开时按 Origin/Host 校验 + CSRF token + 非 loopback 启动强制确认的低摩擦清单执行 |
| OPT-3 | 结构 | index.js 按职责拆分模块（发现时约 3420 行，2026-10-11 约 5030 行）；DS-13（audit 加 runId）随此一并 | ⬜ 用户决策暂缓（2026-10-02）：等功能需求触发或专项多轮安排；10-01 两起拼接事故说明迁移本身即高风险 |
| OPT-4 | 测试 | 12 个 runner 公共件抽 test/_shared.js | ✅ 2026-10-02 用户批准实施：主会话设计 _shared.js 并试点迁移 A/B（11e9a29），GLM-5.3-Flash 照配方迁移 C–J（8 文件 -892 行/+55 行，场景代码零改动）；rmrf/record/freshCwd/runCli/httpReq/汇总块收敛为单份实现；A–J 409 项全绿与迁移前一致。k/r 为真实端点套件结构不同，按设计不迁移。静态断言计数刷新为 382（每套件 -1，崩溃场景记录移入 _shared） |
| OPT-5 | 测试 | test/ 残渣清理 | ✅ 2026-10-02 存量清零（102 cur-script + 100 mock-log + 170 w-* + 4 杂项，14MB→~0）；增量由 OPT-11 自清理兜底 |
| OPT-6 | 并发 | 多客户端会话保存语义（审批隔离 P0-3 已就绪） | ⬜ 用户决策挂起（2026-10-02）：常用多标签时再做，需先定分桶语义 |
| OPT-7 | 测试 | RUN_ONLY 空匹配时非零退出 | ✅ 随 DS-9 关闭（10 个 runner exit 1） |
| OPT-8 | 测试 | 四条补断言（cron 0h / run_tests 真换行 / .env 注释保留 / rmrf 真删） | ✅ 原四条已落地；2026-10-11 随 P1-1/OP2-3 修正 ts3 为实际输出分隔断言，覆盖真实换行与游离单引号，先红后绿（代码位置：index.js run_tests_tool；test/runner-b.js tests-runner） |
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
| P0-4 无 key 时管理接口裸奔 | 属实，=OPT-2；报告补充的".env 重写可劫持上游"升级说明已并入 OPT-2 描述。⛔ 用户已于 2026-10-01 决策不修，见 OPT-2，不再作为待决项 |
| P0-3 审批桥全局单例 | 当时核对属实；✅ 已由 3c30c7f 修复请求级审批桥，见 P0 主表。后续 13a4b70 为隔离其他全局状态引入 requestGate，当前 HTTP 聊天仍串行；完整并发另见 AST-15/OPT-6 |

### 与既有条目的状态联动

- 历史报告把退出码称作“旧 P1-5”，本统一表对应 P1-14/DS-1；DS-1 已完成，假关闭事故见执行记录。
- 旧 P2-11（git 口径）= DS-4，已完成。
- 旧 P1-2（version）= DS-3、旧 P2-8（README 语法描述）并入 DS-10、OPT-7 = DS-9：均已完成，见各主行。
- cron 0h、webui 持久化、writeWorkspaceEnv 注释、--prompt "" fail-fast 已完成；run_tests 换行的历史“确认已修”后来被推翻，已于 2026-10-11 按 P1-1/OP2-3 真正修复，假关闭历史见清账记录。
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
| GAP-1 | mcp_tool 走自定义协议 `POST {url}/invoke`；MCP 生态标准是 JSON-RPC 2.0 stdio | 生态服务器连不上，"支持 MCP"名不副实 | 【✅ 2026-10-03 已实施（8949096 + 测试文档轮）】真实 stdio transport：换行分隔 JSON-RPC（规范即 NDJSON，非 LSP 帧——原注有误）；mcp.json/.7coder/mcp.json 两层配置；惰性拉起/握手复用/崩溃重拉/关停 dispose；mcp_tool{server} + auto-safe 的 mcp_list_tools_tool 发现；MCP 错误并入 TOOL_FAIL_RE。离线验证：test/mcp-echo-server.js（真实协议）+ mcp-stdio 场景 8 断言红 8/8 绿 8/8（含握手顺序/clientInfo/tools-list 缓存/恰好 3 次 call）。HTTP+SSE transport 二期不做（legacy mcp_url 桥保留） | 中 |
| GAP-2 | 命令工具一次性执行（AST-09 后已异步但 cwd/env 不保持）；无交互进程 | cd/env 不跨命令；REPL 型程序无法运行 | 【✅ 2026-10-03 主会话实施（半范围）】bash_tool {persistent:true}：每个会话上下文一个常驻非交互 bash（管道 stdin 保持 cwd/env；注意非 TTY 下 -i 会挂死——实测定案去掉）；marker 回显退出码 + 300ms 静默窗截取输出；挂起命令超时（timeout_ms 1000-300000 默认 120s）杀整会话重启；会话键 = main/agent-N/wf-N（子代理与工作流天然隔离）；/bye 关停清理；[SHELL] timeout 入 TOOL_FAIL_RE。默认不传 persistent = 旧行为逐字不变（pshell 6 断言含一次性模式不回归）。**未做**：真正 REPL 型交互程序对话式驱动（需要 conPTY，Win7 无——原建议已注明不做）；输出静默判定改提示符嗅探（现 marker+静默窗已够用） | 中 |
| GAP-3 | read_file 全量读取**无行号**（仅 offset/limit 分支有 cat -n，index.js:1078-1090）；**无二进制检测**（=老 P1-6 未修，图片读成 U+FFFD 糊）；无 repo map，大仓库冷启动靠模型自己 ls/glob 摸索 | 编辑锚点不稳（无行号时 old_string 全靠记忆）；二进制白烧上下文；冷启动慢 | ① 全量读也带行号 ② 前 4KB 含 NUL 即拒绝并提示 ③ 任务启动时注入目录树摘要——三件都是小改动【✅ 2026-10-03 快赢批② 全部落地：统一 cat -n 格式化 / [BINARY]+(empty file)+越界提示 / buildRepoMap 2 层 150 行注入系统提示词；readfmt+repo-map 5 断言】 | 小 |
| GAP-4 | 聊天丢弃 image part；截屏只返回路径；仅 web_browser 有视觉 | 视觉闭环断裂 | 【✅ 2026-10-04 快赢批④（GLM+终检）】半1：screenshotToDataUrl（文件→data URL，失败 null 保旧行为）+ 截屏成功且 VISION_MODEL 配置时经 describeWithVision 回填 "Vision: <描述>"；单元断言 3 条（1x1 PNG 往返解码、不存在路径 null）。半2：conversationFromClient 保留多模态结构（image_url 透传上游，纯文本路径逐字不变）；httpx 契约断言按新行为更新（image_url 到达 mock 且文本保留）。**未覆盖**：真实 VISION_MODEL 端点与真实截屏（无头环境）——留真机验证 | 中 |

### B 级——agent 能力增强

| # | 现状 | 差距 | 建议 | 代价 |
|---|------|------|------|------|
| GAP-5 | 无 LSP；编辑后错误只能等跑测试 | 修错反馈环长 | 最小版 diagnostics_tool【✅ 2026-10-03 快赢批③】：只探测并运行项目本地 node_modules 的 tsc/eslint（零网络、异步；最初 auto-safe LOW，现已按 A2-03/1beb939 改为需审批的 MEDIUM），tsc 行解析 / eslint JSON 解析，[DIAG] 结构化输出；tsc 忽略 path 参数（单文件+项目混用会失真，schema 已注明）。shim 版 tsc 红绿验证解析（diag 2 断言）。完整 LSP 仍留 D3 | 小→大 |
| GAP-6 | todo 只是往 TODO.md 追加文本 | 无状态流转，UI 无从展示进度 | 【✅ 2026-10-04 快赢批④（GLM+终检）】`.7coder/todos.json` {items:[{id,title,status,updated}]}（500 条上限）；todo_write_tool 改 action 式 add/update/list（旧 content 参数向后兼容）；GET /api/todos；webui 侧栏任务面板三色徽标（autoSave 成功回调刷新）。todos-api 场景 3 断言先红后绿。GLM 纠正了规格错误：todo_write_tool 本就不在 AUTO_SAFE，权限路径零改动。**2026-10-23 T22-13更正**：历史“损坏自动重建”不再采用，改为可靠替换/上一版本、损坏证据保全；无有效恢复版时拒绝读写，GET明确500，不能当空后覆盖。 | 小 |
| GAP-7 | REPL 仅固定命令；无 hooks | 无法沉淀自定义工作流，无法注入 pre/post-tool 规则 | 🔶 7a ✅（快赢批④：.7coder/commands/<name>.md 展开，slashcmd 2 断言）。7b hooks **降级**（2026-10-04 用户决策）：原始动机（"禁止改 src/legacy/**"式规则拦截）已被 GAP-11 deny 规则完整覆盖且语义更强（全模式生效）；剩余增量仅自定义动作（如写后 format）。保留待真实需求出现再评估，不排期 | 中 |
| GAP-8 | usage 字段完全未用（发现时） | 无 token 可观测 | ✅ 2026-10-13：CLI /api/info 与 UI 显示本进程用量，回复结束或停止后刷新 UI；每次上游返回有效 usage 写 type:usage/model/prompt/completion/total 审计项；流式请求 include_usage。未提供用量的端点不估算；审计可按 AUDIT_LOG=false 关闭 | 小 |
| GAP-9 | 记忆=7CODER.md 单文件 + BTW.md，扁平无分层 | 项目事实/用户偏好/临时笔记混一处，长了靠压缩 | 【✅ 2026-10-04 主会话实施】`.7coder/memory/<topic>.md` 分层笔记：memory_tool {save/read/list/delete}（topic 白名单 [a-z0-9][a-z0-9_-]，auto-safe LOW——与 todo 同信任级，仅写 .7coder/memory/）；任务启动**确定性关键词召回**（无 LLM 调用，score=词重叠，命中注入 ≤5 条/3000 加权单位，附主题索引行）；write_file 对 .7coder/memory/*.md 同享 7CODER.md 自动豁免（dream 可重写）；dream 提示注入主题清单（可选整理，强制目标仍是 7CODER.md，契约不变）；MEMORY_RECALL_CHARS 可配。memory 场景 7 断言（召回命中/不串主题/索引行/CRUD×4） | 中 |
| GAP-10 | web_search 正则抓 DDG-lite HTML | 脆弱易限流无降级 | 【✅ 2026-10-03 快赢批③】SEARCH_PROVIDER/SEARCH_API_KEY/SEARCH_ENDPOINT 三键：searxng/brave/bing 分支 + ddg 原样兜底；显式未知值报错不回退网络；Search error 前缀入 TOOL_FAIL_RE。离线假 searxng 实例验证（search-api 2 断言先红后绿）；真实 brave/bing key 未测（付费） | 小 |

### C 级——打磨与可选

| # | 现状 | 差距 | 建议 | 代价 |
|---|------|------|------|------|
| GAP-11 | 保护清单硬编码；权限仅四模式 | 用户不可扩展 | 【✅ 2026-10-03 主会话实施】`.7coder/permissions.json`（+安装目录 permissions.json 双层合并）：protected_extra 纯路径模式（扩展受保护清单，正斜杠跨平台）/deny/allow 规则 `tool(pattern)`。安全序：deny 全模式生效（先于 auto-safe，bypass 也拦）；allow 仅跳过审批层（硬轨之后判定，永远压不过 protected/超级危险命令/denial/deny）。无效规则启动告警并忽略。perm-rules 场景 8 断言先红后绿 | 小 |
| GAP-12 | 缺任务级改动汇总（发现时） | 任务收尾无改动总览 | ✅ CLI/REPL 与 HTTP 流式/非流式均在任务执行前创建本地 stash refs（HTTP 在 requestGate 内）；真实 Git 反例验证快照保留任务前工作树和暂存内容、不修改 index，未跟踪文件留在原地且不在快照中。refs 不自动裁剪 | 小 |
| GAP-13 | 压缩按字符数近似（=C9） | 字符≠token，CJK 失真压缩偏晚 | 【✅ 2026-10-04 主会话实施（启发式半）】textUnits()：CJK/全角/韩文/假名码点 ×2 加权，messageSize 三处调用自动一致；中文密集会话压缩触发点与真实 token 预算对齐。cjk-ctx 场景 4 断言（提取 eval 单元级：汉字×2/混排/消息内容/tool_calls 同权重）。**剩余半**：⛔ 不做（2026-10-04 主会话决策）：零依赖纪律是项目硬约束（B 系列决策仅允许 axios+dotenv），×2 启发式已消除主要失真；若未来上下文预算成为瓶颈再评估 | 中 |
| GAP-14 | 会话线性：resume 载入最新一份，无分支 | 无法"回到三轮前试另一条路" | 【✅ 2026-10-04 尾巴批（GLM+终检）】REPL `/fork <N>`：按 1-based 用户轮截断内存会话（当前按 A2-05/8fb0a99 保留第 N 轮完整工具链与最终答复），之后对话从该点继续；超界安全拒绝；REPL 帮助行同步。fork 场景 5 断言（先红 3/5：阳性对照 FORK-B 确曾到达 + 分叉后末请求不含 FORK-B、FORK-A 历史保留） | 中 |

### 与既有条目的关系

- GAP-1/GAP-2于2026-10-23由T22-12补齐管道故障结算、缓存身份及采集限额。GAP-2上文“杀整会话重启”是历史描述：当前仅尽力kill直属child，失败返回结果未知，下次调用才创建新会话，cwd/env重置；未证明整个进程树停止（T22-07）。marker后的300ms是固定尾随窗口，不随输出续期。最终专项获准复跑30/30，范围见第七批记录。
- GAP-6/GAP-9及D4会话的写入保全于2026-10-23由T22-13统一补齐；含直接文件工具写入受管JSON/记忆/工作日志时的格式校验及替换。原CRUD/召回等历史通过记录保留，本批未复跑旧套件；多实例、会话保存调度和磁盘总预算分别仍属T22-14/19/26。
- GAP-3 的二进制半 = 老 P1-6，已完成；GAP-5 = D3 的务实降级版（diagnostics 已做，完整 LSP 未做）；GAP-13 = C9（加权已做，精确 tokenizer 不做）；GAP-1 已实现真实 MCP stdio，原“仅自定义协议”的描述是发现时快照。
- 原实施顺序为历史建议，当前按各行状态执行；未完成增量为 GAP-7b hooks；GAP-8 审计/UI 用量、GAP-12 检查点已于 10-13 补齐。真实视觉/搜索端点验证另见 GAP-4/10。

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
| AST-05 | index.js:1231-1262 | **下载失败删除既有文件**：dest 先建流（truncate 已有文件），catch 无条件 `unlinkSync(dest)`——503/断网即毁掉原文件，无需攻击者 | ✅ 历史修复覆盖下载阶段，同目录 .part- 暂存；原 ast-download 6 断言不覆盖最终替换。2026-10-23 T22-09 补齐提交阶段：删除 unlink(dest)，写入关闭/刷盘＋严格完整旧版备份后直接 rename 覆盖；新专项41/41，旧场景6/6。详见第四批记录。 |
| AST-06 | webui.html:342, 401-408 | **Web 新会话永不首次保存**：autoSaveSession 在 `!sessFile` 时早退，而 sessFile 只在加载旧会话时设置——首次保存鸡生蛋。既有测试只测服务端路由、未测前端触发（盲区实锤）；此前"会话自动保存"实际只覆盖"已加载会话"的增量 | ✅ autoSaveSession 允许首存（不带 file，响应回传后 rememberSessFile）；三重验证：服务端契约场景 webui-firstsave 5/5、GLM 自建 test/webui-dom-sim.js DOM 模拟 8/8、主会话浏览器实测（首条消息后 web-*.json 落盘两轮完整） |

### P2 — 可靠性 / 可观测性（核对属实）

| # | 位置 | 问题（核对结论） | 状态 |
|---|------|------|------|
| AST-07 | webui.html:538 | **SSE 业务错误被吞**：catch 仅当 message 含 `upstream` 才重抛；`API error 401`/`Max retries reached` 等被当普通内容忽略，用户看到空回复不知失败 | ✅ JSON.parse 独立 try/catch，j.error 脱离吞错 catch 原样上抛；非 upstream 文案不再被吞；webui-dom-sim 3 断言 + 浏览器实测（死端点 → 气泡显示 错误: Max retries reached.——正是旧过滤器吞掉的类型） |
| AST-08 | /api/settings + writeWorkspaceEnv | **设置值换行注入环境变量**：仅校验字符串类型，值含 `\nPERMISSION_MODE=bypass` 可落盘成独立配置行；且运行时全局先改后写盘，写失败出现"接口报错但已切换"的不一致 | ✅ /api/settings 拒绝含 CR/LF/NUL 的值（400），endpoint 强制 http(s) 前缀；落盘成功后才更新内存；settings-api 场景 5 条新断言（注入 400、.env 无污染、正常路径不回归） |
| AST-09 | 全部 exec 路径 | **同步子进程阻塞 HTTP 事件循环 + 取消不贯穿**：execSync 单次可跑数分钟，期间健康查询/审批/取消全部排队；cancel 只在工具循环边界生效，未传入 axios/子进程/子代理（与 GAP-2 部分重叠但角度不同：本条是阻塞与取消，GAP-2 是状态与交互） | ✅ 最小版（2d091fb，主会话实施）：run_command/bash/powershell/process_list/run_tests 五个模型可达命令面转异步（run_tests 最长 600s 是典型冻结源）；取消令牌五层穿线、取消即 kill OS 进程；流式 finally 统一清理 keep-alive/未决审批/请求门。先红后绿实证：HEAD 上长命令期间 /api/info 冻结 2289ms，新代码即时（loopfree 2 断言）。**有意保留 sync**（有界管理型调用）：git() 30s、taskkill、截屏、findBash、worktree、csc。完整 ExecutionContext 线程化未做（与 AST-15 同族，重开条件见 AST-15） |
| AST-10 | 各 POST 路由 | **请求体上限只设标志不停止累积**：聊天路由 oversized=true 后继续 `body += chunk` 到 end 才 413；其余 POST 路由（approve/save/settings/mode 等）完全没有上限 | ✅（2d091fb + GLM 边界补测轮）readJsonBody 共享有界读取器接入全部 9 个 POST 路由（聊天 10MB/其余 1MB）：字节即到即计、超限即时 413、后续分片只排空不累积、60s 安全销毁。bodycap 5 断言 + bodycap-edge 7 断言（多字节字符撕裂在 LIMIT+1 边界、无 Content-Length 分块、第二路由、900KB 低于上限正常处理）。GLM 红绿对照另发现：旧代码经 /api/sessions/save 会实际写入 2MB 会话文件——未设限写入洞随本项堵上 |
| AST-11 | index.js:1706-1709 vs 2057-2060 | **两张失败判定正则漂移**：workflow 步骤失败正则比审计正则少 `List error`/`Download error`/`Input error`/`Kill error` 等前缀——list_dir 失败后工作流继续执行后续写步骤并报 `[OK] Workflow complete`；`Auto-approval declined` 两边都不认；denial 拒绝在审计里记 `status:"ok"`。= deepseek 建议 5.2（结构化 ToolResult）的实证，二者合并处理 | ✅ 13a4b70（最小版）：TOOL_FAIL_RE 单一失败判定源统一喂 workflow 步停判定与审计状态映射；denial 记 blocked、List error 步骤停批（ast-security 2 断言）。完整结构化 ToolResult 仍留 OPT-13（建议 5.2） |

### 测试与打包配套问题（核对属实）

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| AST-12 | test/runner.js cli-exit 场景 | r3 直连 `https://api.openai.com`（空 key 的真实外网请求）；r1/r2/r3 均未设隔离 cwd → 每次跑套件 A 都在仓库根产生 7CODER.md/.7coder_last_interaction（此前误归因于主会话手动测试，实为套件自身污染仓库根） | ✅ cli-exit 三子进程全部隔离 cwd；r3 端点改 .example 保留域（仍触发远端告警、DNS 秒败无真实外网）；跑后仓库根零污染 |
| AST-13 | scripts/pack-offline.js:34-47 | COPY_FILES 仍引用已归档的 KNOWN-ISSUES.md（OPT-9 移动后未同步，缺失时静默跳过）；`e === 'w-'` 恒假的老 P1-9 半截仍在；依赖树直拷非干净构建（P1-9 升级合并至此） | ✅ COPY_FILES 移除已归档的 KNOWN-ISSUES.md；排除规则 w-/cur- 前缀修正（fail-first 实证 w-packprobe/cur-zzz.json 曾泄漏入 dist，修复后干净） |

### 真实模型补测的观察（R1/R2 已于 2026-10-03 正式立项，见下表；Origin/Host 探针并入 OPT-2 备注，⛔ 决策不变，重开时按低摩擦清单执行）

### 补充发现（修复过程中 + 真实模型补测）

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| AST-14 | test/mock-server.js + 各 runner | 裸字符串 mock 步骤（如 'WF-DONE'）没有 .content 属性 → mock 发空 delta → 客户端报 empty streamed response → 错误路径也写 [DONE]。多数场景恰好在工具结果上断言所以仍过，但意味着这些用例的最终回复从未真实到达、7CODER.md 摘要被跳过。approval-iso 已改对象步骤根治；其余场景的字符串尾步骤属已知无害怪癖 | ✅ 根治法：mock-server/chaos-mock 三处取步骤点统一字符串→对象归一化（一处改动消灭整类陷阱，优于改几十处场景）；strstep 场景 3 断言先红后绿（旧代码 stdout 现错误路径文案，新代码真实回复到达） |
| AST-15 | requestGate 语义 | HTTP 聊天请求端到端串行后，长审批等待会阻塞后续请求（单用户工具可接受；approval-iso 已锁定该语义）。根治=ExecutionContext 线程化（AST-09 同族） | 🔶 requestGate 串行门语义维持（AST-09 最小版未做 ExecutionContext 线程化）；多标签场景仍为排队。重开条件：常用多标签 或 OPT-6 重开 或 下次大结构改动时一并线程化 |
| AST-R1 | index.js summarizeAction | 真实模型补测实测：7 次任务摘要吃掉 71.1% 输出 tokens / 67.7% 上游耗时——summarizeAction 无独立 maxTokens、与主模型共用配置（同 4096 上限），非流式请求同步等待摘要 | ✅ 全部完成（27cb24c + 56cea98）：SUMMARY_MODEL/SUMMARY_MAX_TOKENS=512 独立配置 + 短回复(<200 字符)跳过摘要（空回复仍兜底）；非流式 HTTP 先返回响应，摘要经 summaryChain 串行链后台落地，CLI/REPL 保持等待。summary-budget/bg-summary/summary-race 已有断言；2026-10-11 清账补翻状态，bg-summary 本轮复测见文末 |
| AST-R2 | 审批链路 | 语义等价编辑因表述不同被先拒后批——YES/NO 单字判定承担硬边界过载 | ✅ 2026-10-03 与 GAP-11 合并实施（主会话）：isAutoApprovalSafe 改结构化 JSON 判定 {safe,reason}（兼容旧 YES/NO 文本）；拒绝时 reason 回传给模型（可针对性重试）并落审计 approval_decline 条目（type/tool/mode/reason/argsPreview）；确定性规则（GAP-11 deny/allow/protected_extra + DETERMINISTIC_RISK 表）为主、模型判断兜底的分层已成型 |


- 5.3 Node 13 EOL 双轨构建：离线包已捆绑运行时并明确面向 Win7，现状覆盖主要诉求；LTS 双轨是新工程，不并入待办，重开 OPT-3 时参考。
- 7.4 "机器可维护状态索引"：与 OPT-10 同方向，并入 OPT-10 备注（统一 ID/状态/提交/验收字段）。
- 第十一节 11.6/11.7/11.8（端点对账、qwen3.8-flash 单次验证）为环境验证记录，非项目问题，不入表。

---

## 2026-10-04（晚）—— 双审阅核对（claude-opus4.8 + gpt-astra 二轮）

> 输入：claude-opus4.8审阅.md（v2.18.0 基线，静态+定向动态验证，5 项新发现）+ gpt-astra审阅2.md（全项目复审，22 项：9 P1 + 13 P2，全部附复现证据与证据边界声明）。
> 核对方式：主会话逐条对当前代码验证后写入。**两份报告本轮核对为零不实条目**（对照：deepseek 报告曾 5 条不实）——opus 的 F1-F5 与 astra2 抽验的 8 条（A2-01/02/04/05/06/08/09/16）全部属实；其余条目证据充分且与代码结构一致，按报告证据登记。
> 重要：opus 发现两条**假 ✅**（P1-1、P2-10，已在上表纠正）——这是 DS-1 虚报事故后暴露的账实不符新形态，元教训见维护约定第 5 条。

### OP2 系列（opus 审阅，5 项全部属实）

| # | 位置 | 问题（核对结论） | 状态 |
|---|------|------|------|
| OP2-1 | index.js:2626-2628 | **parseTestOutput 指数级 ReDoS**：三处 `(d+)+` 经典 evil regex；实测 34 位连续数字 52.4 秒（每+4 位 ×16）。run_tests_tool 把原始输出直喂主线程同步正则——被测程序一行长数字即冻结 --server 整个服务。= P2-10 的真身 | ✅ 3926e3f：三处 (d+)+ → (d+) + 64KB 尾部限长；计时断言 32 位 2ms + 源码无嵌套量词（剥注释）+ 摘要形态回归（sec1 3 断言） |
| OP2-2 | index.js:3119 vs 2396/1270 | **cron 绕过超级危险命令硬防线**：isSuperDangerous 只接 run_command/bash/powershell/task_create 四工具，schedule_cron_tool/cron_create_tool 不在其列却用 exec 周期跑 shell——bypass 下 cron_create rm -rf / 每 30s 执行一次，README 的"even in bypass"承诺对 cron 不成立。= astra2 A2-17 同源（其另指出 run_tests/legacy npx 入口也不经该检查） | ✅ 3926e3f：cron/run_tests/npx-legacy 三入口接入硬防线 + cron 触发时复查（sec1 3 断言：bypass 下 BLOCK、非危险 npx 不误伤） |
| OP2-3 | index.js run_tests_tool | run_tests_tool 输出游离单引号 + ts3 断言对准错目标（false-green），=P1-1 | ✅ 2026-10-11 与 P1-1 同修（代码位置：index.js run_tests_tool；test/runner-b.js tests-runner）：四条输出路径改为真实换行，tests-runner 精确检查 Output tail/Failures/All green/Raw tail 分隔；旧代码四条反例均失败，新代码 tests-runner 6/6；Node 24/13 定向回归各 22/22 |
| OP2-4 | index.js:3927/3932/3940 | **设 HTTP_API_KEY 时三个读接口仍不鉴权**：/api/info（含 workspace 绝对路径+模型+用量）、/api/todos（任务清单）、/v1/models 无 401 门——用户专为 LAN 配了 key 却裸奔读接口。与 OPT-2 ⛔（未设 key 场景）是不同问题。= astra2 A2-10（todos 部分） | ✅ 机械轮：/api/info、/api/todos、/v1/models 三路由补 401 门（webui headers() 已带存储 key 兼容）；sec4 3 断言（无凭证 401/带 Bearer 200 ×3）；套件 A/D 两条钉死旧行为的断言更新为新契约（401+带 key 200，不是削弱） |
| OP2-5 | README.md:113/128 | 两处过实表述：超级危险拦截实为子串小黑名单（rm -fr /、:(){ :|:& };: 等不拦）；protected 读在 bypass 下只 warn 不审批 | ✅ 机械轮：README 两处措辞按实际收口（denylist not sandbox；bypass 只 warn 不审批） |

### A2 系列（astra2 审阅，22 项；与 OP2 重叠的已标注合并）

| # | 位置 | 问题（核对/登记结论） | 状态 |
|---|------|------|------|
| A2-01 | index.js:2239-2275, 734-749 | **memory_tool 无真实路径校验 + 不吃 protected_extra**：memoryFilePath 直接拼接（junction 即越界读写）；isProtectedTarget 不处理该工具；AUTO_SAFE 加持下免审批。动态复现：junction → 读到外部 OUTSIDE-ONLY-FAKE-DATA、save 改写外部文件 | ✅ 3926e3f：memoryPathGuard 双重真实路径校验（note-in-store + store-in-workspace——第一版守卫被自己的红测试抓出 junction 双外指漏洞后补全）+ protected_extra 拦截；junction 读/写断言外部文件逐字未动（sec1 3 断言） |
| A2-02 | index.js:788-816 | **安装级 allow 吞掉工作区同名 deny**：loadPermRules 的 seen 去重键只有规则字符串不含 bucket，安装文件先读 → 工作区 deny 同串被当重复丢弃 → 实测 Written: blocked.txt。**GAP-11 的真缺陷**（同文件内 deny 先读所以单层测试通过） | ✅ 3926e3f：去重键含 bucket 前缀；临时安装级 permissions.json 端到端验证工作区 deny 胜出（sec1 1 断言） |
| A2-03 | index.js:513-520, 2693-2722 | **diagnostics 免审批执行项目代码**：node_modules 里的 tsc/eslint 是项目自己的 JS，eslint 还加载项目配置/插件；动态复现伪 tsc 写标记文件零审批。GAP-5 的 auto-safe 决策过信 | ✅ 批次一机械轮（GLM+终检）：移出 AUTO_SAFE、LOW→MEDIUM、schema/提示语/注释三处 read-only 谎报一并纠正（default 拒绝 / bypass 照常，sec2 2 断言先红后绿） |
| A2-04 | webui.html:386-399, 543 | **错误消息 innerHTML 注入路径**：正常回复走 esc() 但 addMsg('err', '错误: '+e.message) 直进 innerHTML；DOM 模拟复现错误气泡原样含 <img onerror>。上游可控错误文案 = XSS 面 | ✅ 机械轮：addMsg err/sys 分支改 textContent（user/bot 保留 markdown 路径）；12 处 innerHTML sink 全审计无第二处漏点；dom-sim 新增 a204 两项（payload 转义 + onerror 未触发），10/10 |
| A2-05 | index.js:4677-4693 | **/fork 拆散工具配对**：保留 user+紧邻 assistant，若该 assistant 带 tool_calls 则孤儿化（配对非法+该轮最终答复丢失）；fork 测试只用纯文本回合故未覆盖。GAP-14 的真缺陷 | ✅ 8fb0a99：回合边界 = 第 N+1 个 user 消息起点，工具链整段保留；端到端证明含孤儿检测（sec3 4 断言：保 FINAL1 弃 FORK-B、零孤儿 tool、banner） |
| A2-06 | index.js:3139-3142 | **bypass 分支漏传 cancelled**（核 实：executeToolRaw(name,args,conversation,approvalBridge) 少第五参）+ 同族：子代理不继承取消、持久 shell 仅事后检查、axios 无活动取消、审批等待期断连不即时 dispose。AST-09 的取消缺口 | ✅ 8fb0a99最小接线保留；10-24 T22-06前四批已补模型/审批、下载/网络/视觉、MCP/shell、dream/BTW、debug观察/修复等待的取消与截止时间。完整副作用截止、同步IO及进程树停止仍未闭合，OPT-15/T22-06/07保持开放，不能以旧最小版✅代表全部完成。 |
| A2-07 | index.js:2666-2679, 3251 | **失败测试不停工作流**：run_tests_tool 非零退出仍返回 [TESTS] 前缀文本，TOOL_FAIL_RE 不识别 → 复现 [OK] Workflow complete 后接写入步骤。Fetch error/Tests error 等散落前缀也未纳入 | ✅ 批次二机械轮（start-plan GLM + 主会话）：exit≠0 两个返回点改 Tests error: 前缀，TOOL_FAIL_RE 增补该前缀（修复员 escalation 抓出规格假前提——正则里本没有 Tests error，主会话核实后亲自补上）；sec4 3 断言（STOPPED、后续写步不执行、前缀携带）；tests-runner ts1 契约同步钉新前缀 |
| A2-08 | index.js:1377-1395, 1426-1432 | **dream 失败覆盖 7CODER.md**（catch 直接写 DREAM FALLBACK 单行，原文无备份丢失）+ 新工作区 DREAM_ALLOW=true 无 .7coder 目录时写锁 ENOENT 崩 | ✅ 机械轮：catch 不再写 DREAM FALLBACK（原文逐字保留，console.error 报错）+ 写锁前 mkdir（sec2 4 断言先红：HEAD 实测覆盖与 ENOENT 均复现）；dream 场景 6/6 回归 |
| A2-09 | index.js:2999-3016 | **auto_debug spawn 无 error 监听**：不存在 exe → 未捕获 error 事件 → HTTP 服务 exit 1（实测复现）。两条 spawn 路径同病 | ✅ 机械轮：两条 spawn 挂 error 监听（spawnFailed 闭包 + 观察循环 break + 外层修复循环 break——防 3 轮空转）；sec2 3 断言先红（HEAD 实测 ECONNRESET 服务死）后绿（200 + spawn failed 文案 + 事后健康）；GLM 并纠规格两处旧参数名/默认值错误 |
| A2-10 | index.js:3932 | 设 key 后 /api/todos 匿名可读 | ✅ 并入 OP2-4（4cd0066）；当前 /api/todos 已有 HTTP_API_KEY/Bearer 401 门，sec4 覆盖无凭证 401、带凭证 200；2026-10-11 补翻旧行 |
| A2-11 | index.js:2708-2715 | tsc 全局错误（TS18003 无文件定位）被误报 [DIAG] clean | ✅ 机械轮：tsc 裸 error TS 行收集为诊断 + exit≠0 无解析时 Diagnostics error:（sec4 2 断言：TS18003 报告非 clean、真零问题仍 clean） |
| A2-12 | webui.html:409-422, 478-488 | **单标签会话切换/保存竞态**：A 回答中载 B → 回答串进 B；旧存档返回晚于新对话 → 旧文件名写回 → 新内容存进旧档（DOM 模拟双复现）。AST-06 首存修复未覆盖切换竞态 | ✅ 15c7e7d：sessGen generation 守卫（send/autoSave/load 三处捕获；迟到回复不进新档、旧文件名不回写、busy 拒载入）；dom-sim 10/10 |
| A2-13 | index.js:3505-3515 | 记忆召回首条可无限超额（picked.length 条件），实测预算 100 却召回 16075 字符；MAX_FILES=20 只是读取截断非保存上限 | ✅ 机械轮：首条也截断（textUnitsSlice 按加权单位截到剩余预算 + 标记行，磁盘原文不动）；sec6 2 断言先红（HEAD 注入 4103 字符）后绿 |
| A2-14 | index.js:964-969, 4605 | /clear 不清持久 shell（实测 export 状态跨"新会话"残留）；agent-1/wf-1 键跨实例复用 | ✅ 机械轮：/clear 调 disposePersistentShells + 提示文案；sec6 2 断言先红（export 跨清存活）后绿（空值） |
| A2-15 | index.js:1569-1576 | SSE 无 finish_reason 即 EOF → 默认 stop 当成功（残缺回答入库）；未覆盖首段后失败重试的前缀重复 | ✅ 8fb0a99：无 [DONE] 且无 finish_reason 的 EOF → upstream error（不重试上抛）；[DONE]+finish 与仅 finish 两方向兼容保留；parseSSEStream 假流单元 3 断言 |
| A2-16 | index.js writeWorkspaceEnv | writeWorkspaceEnv 重序列化全部键：带引号的多行 env 值保存后丢失引号语义。P1-4 注释保留修复的姊妹缺陷 | ✅ 15c7e7d：只重写本次更新的受管键，未知键/多行续行保留；真实 POST /api/settings 端到端覆盖多行 CUSTOM 值、受管 HEAVY_MODEL 更新和注释保留（实际场景 sec5，3 断言）。2026-10-11 修复错位状态列与断裂表格 |
| A2-17 | index.js:3119 | 超级危险拦截入口不全（cron/run_tests/npx legacy）| ✅ 并入 OP2-2（3926e3f） |
| A2-18 | index.js:381-387, 3054-3066 | 审计 result 首行不脱敏：紧凑 models.json 读取把 apiKey 原样落日志（实测假键复现）。AST-04 只修了名单，日志复制面仍在 | ✅ 机械轮：sanitizeAuditLine（Bearer/sk- 模式）盖 result 字段——先脱敏再 160 截断防边界前缀泄露；只动唯一产出 result 的 safeExecuteTool；sec6 断言先红后绿 |
| A2-19 | index.js:248-252 | Windows 下 spawn('npx') ENOENT（双运行时实测）——README 的 MCP 示例在 Windows 直接起不来 | ✅ 机械轮：resolveCommandOnWindows（PATH 找 .cmd/.bat/.exe → shell:true 启动，信任边界=mcp.json 是用户自写，注释声明）；**升级式改进**：规格的降级断言在修复侧不可通过，改为实现最小 JSON-RPC shim 达成强断言（tools/list 应答、无 ENOENT）——先红（HEAD 实测 spawn npx ENOENT）后绿 |
| A2-20 | index.js:1121-1152, 1178-1228 | P2-3 预算未覆盖：模型正则同步运算无预算（探针 29 字节 (a+)+$ 超时）、glob maxEntries 计结果非扫描量、无 visited 集合（环链）、perFileCap 不停计算 | ✅ 15c7e7d：grep 嵌套量词 lint（自测 9 用例）+ 双遍历器 visited 集 + 预算 glob 封顶访问量 + grep 超限即停止匹配；lint 诚实标注 best-effort 非沙箱；pruneBackups 零语义变化 |
| A2-21 | scripts/pack-offline.js:40, 74-84 | rmrf 失败后 300ms 定时器异步重试 → 可能删掉已重建的新目录（静态） | ✅ 机械轮：rmrf 改同步重试 3 次仍败则 throw（宁可不发布）；静态断言（无 setTimeout）+ 真实打包冒烟（staged 3.4MB + 包内跑 count-assertions 551）；故障注入不可行已注明 |
| A2-22 | INSTALL/README/pack | 6 处误导：env 行尾注释示例违反自家 dotenv 8 规则、scripts/ 不打包但 INSTALL 让跑、KNOWN-ISSUES.md 路径过时、dotenv 实为 8.6.0 非 8.2.0、README 仍标 v2.16.0、备份说明 100 vs 实际 5/200 | ✅ 机械轮：六处全清——env 示例行尾注释改独占行 ×2 块、count-assertions.js 入包并实跑验证、KNOWN-ISSUES 引用改 docs/history、dotenv 8.6.0（先验 lockfile）、README 横幅 2.18.0 + 空白占位句重建 + 备份策略 5/200 对齐实现；sec6 4 断言先红后绿 |

### astra2 报告的其余内容（采纳/记录）

- **测试洞因分析（8.1 节）采纳**：fork 只测纯文本、memory 只测普通目录、permissions 未测双层相反 bucket、diagnostics shim 不测副作用、DOM 把"丢弃保存"当通过条件、MCP echo 不覆盖 Windows npm shim、workflow 未接退出码契约——**新功能只测理想路径**是 B 215/215 仍漏掉这批问题的根因；修复时应随各项补反例（先红后绿）。
- **工程改造建议（8.2 节）登记为方向项**：①工具声明元数据表收口（执行性/读写资源/可取消性/可并行集中声明）②统一 ToolResult 结构化状态（先 run_tests/diagnostics/workflow 三工具）③统一文件访问门（内建状态路径也要真实路径校验——A2-01 的根治）④统一取消契约（上下文对象替代位置参数——A2-06 的根治）⑤会话 generation/id（A2-12 根治）⑥测试总入口（npm test 只跑 A）⑦少量真实浏览器测试。均为渐进式，不要求破依赖约束。→ 登记 OPT-12~17 见下。
- **受保护文件硬链接别名**（第六节）：动态复现但需预植链接，登记不修（文件名保护的固有局限，威胁模型内可接受）；`.env.` 尾点探针**未**绕过（阴性对照，记录防再查）。
- **/v1/models 与 /api/info 模型清单不一致**（profile 模型缺失）：原拟并入 OP2-4；2026-10-11 清账时仍未修，转 NEW-1 跟踪并于同日修复，OP2-4 的鉴权修复维持完成。
- **cron 重叠执行**（上次未结束又启动、child 句柄单值）：原拟并入 OP2-2 测试面；2026-10-11 清账时仍未修，转 NEW-2 跟踪并于同日修复，OP2-2 的危险命令拦截修复维持完成。
- **受限环境 5 个断言失败**（astra2 环境的进程枚举/采样权限问题）：历史 add7f51 已记录正常环境 A–J 579/579 全绿；缺少这 5 项逐条对应记录，不据此单独关闭该验证备注，仍待定向核验。

### OPT 新增（来自 astra2 8.2，渐进式登记）

| # | 方向 | 状态 |
|---|------|------|
| OPT-12 | 工具声明元数据表（执行性/资源/取消/并行集中声明，防四表漂移） | ✅ 本轮统一为 index.js TOOL_METADATA：53 个工具逐一声明风险/审批说明/自动放行/只读并行/改动跟踪、执行性/资源/现有取消支持。初始化校验与旧策略基线对照见文末 OPT-12 记录；取消语义本身仍由 OPT-15 跟踪 |
| OPT-13 | 统一 ToolResult 结构化状态（先三工具试点） | 🔶 第七批47/53为历史进度；10-24调试生命周期批新增auto_debug_tool，当前 **48/53工具名**。余下mcp_tool/mcp_list_tools_tool/web_browser_tool/plan_mode/bickering_tool，以及computer_use输入分支与MCP external完整状态归T22-20。子代理取消及命令exitCode收尾保留；debug现显式blocked/error/cancelled/ok，不再笼统成功。注册数不代表全部返回分支均已显式结构化。 |
| OPT-14 | 统一文件访问门（内建状态路径过真实路径校验） | ✅ internalStatePath/managedWorkspacePath 统一校验产品状态目录、会话、备份、MCP、skills、memory、todos、summaries、审计和工作区状态文件；junction/symlink 越界 fail-closed。普通用户文件仍走 sanitizePath，取消契约留 OPT-15 |
| OPT-15 | 统一取消契约（上下文对象） | 🔶 T22-06前四批已贯穿主/辅助模型、审批、下载/网络/MCP/shell、dream/BTW与debug观察/修复等待，/bye撤销活动控制；保留位置参数兼容。仍待同步IO及完整副作用/进程树闭环，不宣称完整ExecutionContext改造；详见本日实施记录。 |
| OPT-16 | 会话 generation/id（异步回调只改所属会话） | 🔶 A2-12 的 Web UI 局部 sessGen 守卫已做（15c7e7d）；统一的端到端会话身份/上下文仍未完成，勿将局部修复等同整项关闭 |
| OPT-17 | 测试总入口 + 少量真实浏览器测试 | ✅ 2026-10-13 补齐真实 headless Chrome 回归（test/webui-browser.js），消息编辑/停止/会话切换/用量刷新；`npm run test:browser` 独立运行，`BROWSER_TEST=1` 可追加到全量入口。Playwright 由开发环境提供，未增加生产依赖 |

### 原建议修复批次（历史排期，当前状态见各行）

1. **第一批（授权与数据止损）**：OP2-1 ReDoS + OP2-2/A2-17 cron 硬防线 + A2-01 memory 边界 + A2-02 deny 吞没 + A2-03 diagnostics 审批 + A2-04 错误 XSS + A2-08 dream 覆盖 + A2-09 spawn 崩溃
2. **第二批（任务执行闭环）**：A2-05 fork 配对 + A2-06 取消贯穿 + A2-07 失败测试停工作流 + A2-11 clean 误报 + A2-15 SSE 中断 + OP2-4 读接口鉴权
3. **第三批（会话/资源/分发）**：A2-12/13/14/16/18/19/20/21/22 + OP2-3/5

---

## 2026-10-11 —— 状态清账（代码与提交证据核对）

> 清账阶段核对基线：HEAD `b8c81ba`；工作树已有未提交的 UI/分发等改动。清账阶段只编辑本日志；随后用户授权修复三个缺陷，代码、测试与日志同批更新，验证见下方修复记录。已有工作树改动未视作已发布。
> 修正上次口头盘点：A2-16 已修，不能继续列为待办；P1-1/OP2-3 则相反，提交说明声称关闭但代码仍复现，因此按代码重开。清账时双审阅 OP2 5 项 + A2 22 项中，26 行已关闭（含合并行），OP2-3 未关闭，故撤回当时的“27 项全清”。后续本轮真正修复 OP2-3 后，该批 27 行方可全关；工程增量与验证盲区仍保留。

### 从原备注转入独立跟踪（保留原记录）

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| NEW-1 | index.js modelList / GET /v1/models | /api/info 含 profile 模型，/v1/models 只列 HEAVY_MODEL/LIGHT_MODEL，两接口模型清单不一致 | ✅ 2026-10-11 修复（index.js GET /v1/models；test/runner-b.js sec4）：/v1/models 统一调用 modelList()，包含 profile 模型并按大小写不敏感去重；sec4 增加真实 HTTP 模型清单一致性与 heavy/light/profile 同名去重 2 条反例，先红后绿，401/200 鉴权回归保留 |
| NEW-2 | index.js scheduleCronJob | cron 未等待上次结束即可再启动，重叠时覆盖 job.child，旧回调还会清空新句柄 | ✅ 2026-10-11 修复（index.js scheduleCronJob；test/runner-b.js cron-overlap）：每个 job 独立 running 守卫，运行中跳过触发，不积压补跑；完成/失败后释放执行位，同步 launch 异常记录后继续调度，stopped 拒绝迟到触发。cron-overlap 在真实调度函数上注入可控时钟/exec 回调，覆盖长任务、独立任务、完成恢复、失败恢复、launch 异常、停止 6 条断言，先红后绿；Node 24/13 均通过 |

### 当前剩余工作索引（不重复计数）

- **本轮三项缺陷均已修复**：P1-1/OP2-3（同一问题，连带 OPT-8 的 ts3 断言）；NEW-1 模型清单；NEW-2 cron 重叠执行。剩余工作仍按下列工程增量、暂缓项与验证盲区跟踪。
- **工程增量**：OPT-13、OPT-15；OPT-16 已有局部 sessGen，端到端统一未做；GAP-8/12、OPT-17 的本轮收尾已完成；其余按各主行跟踪。
- **暂缓/按需**：OPT-3/DS-13（模块拆分与审计 runId，同族）；OPT-6/AST-15（多客户端语义与上下文并发，同族）；D3 完整 LSP；GAP-7b hooks。沿用既有决策，不因清账自动重开排期。
- **验证盲区**：C1~C8；GAP-4 真实视觉端点/截图链路；GAP-10 真实 Brave/Bing；A2-06 行为级取消与残余活动中止；原受限环境 5 条断言的定向核验。C9 精确 tokenizer 属不做决策，已从未处理回翻。

### 清账阶段验证与范围（修复前）

- `RUN_ONLY=tests-runner,sec4,sec5,bg-summary node test/runner-b.js`：21/21 通过；A2-10 鉴权、A2-16 设置保存、AST-R1 后台摘要均有行为证据。tests-runner 的通过不证明单引号已修。
- 将修复前 run_tests_tool 函数段在隔离调用中注入假命令返回值（不执行 shell）：有摘要/无摘要两路径都实际输出单引号+真实换行+单引号，复现 OP2-3 的 false-green。
- `node scripts/count-assertions.js`：清账时静态断言为 551；本轮修复新增断言后另行刷新标记段。
- 历史发布包与后续修复分开标注；本轮没有构建或验证包含最新修复的新离线包。

### 随后执行的三项修复（2026-10-11）

- **NEW-2**：单个 cron 任务运行中跳过后续触发；完成或失败后在下一次到点运行，不积压补跑，其他任务可继续并行。同步 launch 异常记入 lastError 后继续调度，停止后的迟到触发不再启动命令。cron-overlap 用实际调度函数和可控时钟/exec 回调验证，6 条断言先红后绿。
- **P1-1/OP2-3 + OPT-8**：成功/失败 × 有摘要/无摘要四条路径移除包裹换行的字面单引号；保留 Tests error: 失败前缀。tests-runner 改为检查完整分隔文案，旧代码四条格式反例全部失败，修复后 6/6。
- **NEW-1**：/v1/models 使用与 /api/info 相同的 modelList()，包含 profile 模型且大小写不敏感去重。sec4 新增真实 HTTP 一致性与去重断言（旧代码 0/2，新代码 2/2），原鉴权断言仍通过。
- 定向回归：tests-runner/sec4/cron-overlap，Node 24.19.0 与内置 Node 13.14.0 各 22/22；后续强化 cron 停止断言（完成后再停止，避免 running 守卫掩盖停止判断）在 Node 13 复测 6/6。
- UI 验证：`npm run test:ui`，UI 模拟 42/42 + DOM 模拟 12/12；验证的是当前工作树 UI（含用户此前未提交的 UI 改动）。本批没有编辑这些 UI 文件。
- 全量回归先发现安装目录 .env 对默认模型、权限模式、auto-debug 等用例产生干扰；保留失败记录，随后在测试进程中按 .env.example 固定配置，ENABLE_AUTO_DEBUG=false，与既有测试默认契约一致。场景显式 env/工作区 .env 仍可覆盖该基线，用户 .env 未改。 B 的旧 config 场景需验证 MAX_ATTEMPT_RETRIES 别名，但未清空优先级更高的 MAX_RETRIES；补显式空值隔离，config 定向复测 2/2，未改产品重试语义。
- 最终全量回归：A85/B280/C35/D32/E22/F23/G29/H32/I34/J16，逐套均 exit 0，合计 **588/588**。B 基线首轮 279/280，修正 config 用例后完整重跑 280/280；未降低断言。日志保存于本机临时目录 7coder-baseline-regression-8cf4d40566a04db7beb9ad56b6fcbc8e（最终 B 为 runner-b-rerun.log）。

---

## 2026-10-12 —— 测试入口与跨平台工装

| # | 变更 | 状态 |
|---|------|------|
| OPT-17 | 测试总入口 + 少量真实浏览器测试 | ✅ 2026-10-13 补齐真实 headless Chrome 回归（test/webui-browser.js），消息编辑/停止/会话切换/用量刷新；`npm run test:browser` 独立运行，`BROWSER_TEST=1` 可追加到全量入口。Playwright 由开发环境提供，未增加生产依赖 |
| P2-7 | `test/_shared.js`、A/B/C runners | ✅ 10-12 已移除共享 ping 延时和 dir 枚举，但当时遗漏 A/B/C 三处 ping；2026-10-13 全部改为 Node 定时器命令，见当日验收 |

本轮验证：`npm run test:all` 12/12 targets passed；A–J 历史分项 A85/B280/C35/D32/E22/F23/G29/H32/I34/J16，UI 42/42 + DOM 12/12。

---

## 2026-10-12 —— 用量面板与任务检查点

| # | 变更 | 状态 |
|---|------|------|
| GAP-8 | 用量面板与审计 | ✅ 已于 2026-10-13 补齐审计入账与回复结束刷新，历史 10-12 阶段仅完成面板；见当日验证 |
| GAP-12 | 任务改动汇总与检查点 | ✅ CLI/REPL 与 HTTP 流式/非流式均在任务执行前创建本地 stash refs（HTTP 在 requestGate 内）；真实 Git 反例验证快照保留任务前工作树和暂存内容、不修改 index，未跟踪文件留在原地且不在快照中。refs 不自动裁剪 |

验证：UI mock/DOM 通过 43/43 + 12/12；`RUN_ONLY=task-changes` 通过 2/2；完整 `npm run test:all` 随后复跑。

---

## 2026-10-12 —— 第三批完整回归

- `npm run test:all`：12/12 targets passed。A–J 分项 A85/B281/C35/D32/E22/F23/G29/H32/I34/J16，合计 **589/589**；UI mock 43/43，DOM 12/12。
- 静态断言总数：**563**。
- 新增检查点只在 Git 工作区创建本地 refs，不改变工作树；非 Git 工作区和原有非 Git 场景均通过。

---

## 2026-10-13 —— 上轮收尾与真实浏览器回归

- **P2-7**：10-12 关闭时仍有 A/B/C 三处 Windows ping 等待，现统一使用 `_shared.delayCommand(ms)` 的 Node 定时器；移除重复工作区回退。仅验证这些已知命令的替换，C4 的完整 Linux/macOS 实测仍未做。
- **GAP-12**：CLI/REPL 与 HTTP 两种响应路径均覆盖检查点，HTTP 在请求门内创建。新增 CLI/HTTP/stream 各 4 条 Git 反例，实际读取 snapshot 工作树与 index 父提交、比较当前暂存 diff，证明检查点先于 AI 修改。未跟踪文件不入快照、原文保留；非 Git 工作区静默跳过。
- **GAP-8**：合法有限非负 usage 才累加，每次调用按模型写 audit 用量事件，不带消息内容/凭证；流式请求标准 include_usage。UI 在完成/停止后刷新用量，不要求刷新页面。缺少 usage 的端点无法统计，未做估算。
- **OPT-17**：真实 Chrome + Playwright（外部开发工具）验证编辑后重发只保留新用户轮、busy 会话切换按钮禁用且不发载入请求、停止取消 SSE、停止后切换会话、结束后刷新用量、无 pageerror。本地 HTTP fixture 驱动真实 HTML/浏览器，不消耗模型额度；浏览器依赖不进生产依赖。
- **测试基线**：离线 test-all 以 .env.example 覆盖继承的产品配置；REAL_TEST=1 仍保留显式真实端点配置。浏览器通过 BROWSER_TEST=1 显式追加，缺工具时明确失败，不宣称跳过为通过。
- 定向 Node 13.14.0：usage-track/task-checkpoint/loopfree **19/19**；真实 Chrome **8/8**，包括 busy switch 按钮点击/请求计数验证。
- 全量入口追加真实 Chrome：A85/C35/D32/E22/F23/G29/H32/I34/J16 均通过，UI mock 43/43、DOM 12/12、Chrome 8/8。B 首轮 294/296 的两条失败源于旧断言假定所有 audit 行都是 tool、以及审计首次创建时间改变；按 usage/tool 分别验证必需字段，Git 断言精确检查新目录计数（无削弱），完整 B 复跑 **296/296**。最终 A–J 合计 **604/604**，首轮入口 exit 1 如实保留，不声称整条命令单次全绿。
- 验证日志：系统临时目录 `7coder-20261013-all.log` 和 `7coder-20261013-b-final.log`；静态断言 570，生产依赖仍只有 axios/dotenv。没有跑付费/真实模型端点、完整 Linux/macOS 或完整 Node 13 UI 套件。

---

## 2026-10-13 —— OPT-12 工具元数据统一

- **单一声明**：53 个工具的固定风险、审批说明、自动放行、只读并行、改动跟踪统一到 `TOOL_METADATA`。旧 AUTO_SAFE/DETERMINISTIC_RISK/DETERMINISTIC_EXPLAIN/CHANGE_TOOLS 列表已移除，READ_ONLY_TOOLS 仅由 metadata 派生。schema 保留原样，启动时与元数据检查一一对应。
- **资源与取消**：每个工具注明执行类型、资源读写、当前取消能力；这些为描述字段，不参与放行推断，不宣称完成 OPT-15。memory 写入和 MCP discovery 的既有 auto-safe 例外、sleep_tool LOW 风险且说明走模型兜底均保留。
- **权限行为**：deny、protected path、超级危险命令、allow、bypass/auto/default/denial 的检查顺序与参数传递保持原样；CLI/HTTP/子代理共用既有执行管线。
- **初始化检查**：工具遗漏/多余/重复、非法风险或布尔策略、错误资源/执行/取消声明以及可并行写资源均拒绝启动。metadata 表、各行与资源描述冻结；未知工具与原型名字不获得自动或并行特权。
- **验收基线**：`test/fixtures/tool-policy-before-opt12.json` 从 `2e85755` 真实旧表生成；逐一对照全部 53 个工具及 25 个审批说明函数的 5 组参数输出。第一次迁移漏了审批说明时该测试明确失败，补齐后通过。旧 I7 只提取每行第一个风险工具，遗漏 sleep 的模型说明路径，现替换为完整数据对照，未擅自改变既有 fallback。
- **调度行为反例**：实际 processWithTools 函数注入可控工具回调，验证只读工具同时开始、逆序完成仍按调用顺序返回；混合 write/read 批次需等待前项完成。
- 定向 Node 13.14.0：A 的 perm/security **13/13**；I 的 metadata/scheduling **11/11**。
- 完整 `BROWSER_TEST=1 npm run test:all`：**13/13 targets passed**，A85/B296/C35/D32/E22/F23/G29/H32/I42/J16，合计 **612/612**；UI mock 43/43、DOM 12/12、真实 Chrome 8/8，单次入口 exit 0，无失败。日志：系统临时目录 `7coder-opt12-all.log`。
- 静态断言 **578**（新增 8 个静态断言点）；模型收到的 53 个 tool schemas/descriptions 另经对照 HEAD 验证一致。未执行真实付费端点、完整 Node 13 全套或 Linux/macOS 实机验证。

---

## 2026-10-13 —— OPT-13 结构化工具结果（三工具试点）

- **返回契约**：run_tests_tool、diagnostics_tool、workflow_tool 明确返回 `ToolResult {status,text,data?}`，内部 Symbol 标识防普通对象被误当结构化结果。合法状态 ok/error/blocked/declined/cancelled；结果对象冻结，malformed status/text 拒绝。失败判定优先使用显式状态；其他工具仍用历史文本前缀，未扩大其匹配规则。
- **权限与输出兼容**：试点工具的权限拒绝/参数解析等提前返回在 safe wrapper 归一化；权限顺序未改。模型的 tool.content 仍为文本，既有文本上限仍生效；SSE/audit 只传同一状态和已脱敏文本，不传结构化 data。SSE 的 ok 映射为既有 completed，取消显示 cancelled。
- **测试工具**：非零 exit、解析到失败计数/失败行均为 error（即使 exit=0）；无摘要且 exit=0、无失败行则 ok。文本前缀兼容，失败计数非零时不再说 All green，data 携带 exit/解析计数。
- **诊断工具**：tsc/eslint 问题或执行失败均可明确 error，eslint 空 JSON+非零退出不能误报 clean；警告单独为 ok，零问题+exit0 为 clean；无工具链/非法 JSON 为 error。模型仍能读取现有诊断文本。
- **工作流**：非可选失败按显式状态停止，optional error 可继续且完成状态为 ok；cancelled 无论 optional 均停止。data 记录步骤状态，最终 STOPPED 正确进入审计和 UI error/blocked/declined/cancelled。
- **反例验收**：真实 HTTP/SSE + 本地命令覆盖 exit0 测试失败、exit≠0 无摘要、成功文本含 declined、诊断空 JSON 失败/警告/错误/clean/坏 JSON、可选错误后写入、工作流停止后零写入、bad args/危险命令/denial 提前拒绝、SSE 与 audit 状态一致、模型无对象字面串。取消/内部 data/旧前缀规则通过受控工具回调验证；Chrome 加测卡片按 status 渲染而非文本推断。
- 定向 Node 13.14.0：tool-results **11/11**、最终 tool-result-contract **9/9**（合计 **20/20**）。旧 workflow/tests-runner/diag/sec4 定向 22/22；最终取消补丁后的 B 试点回归 **23/23**。
- 完整 `BROWSER_TEST=1 npm run test:all` 单次 **13/13 targets passed**，A85/B307/C35/D32/E22/F23/G29/H32/I50/J16，合计 **631/631**；UI 43/43 + DOM 12/12、真实 Chrome **9/9**。最后补上“末步执行期间取消”守卫及反例后，仅复跑受影响 I 整套 **51/51** 和 B 定向 23/23；最终 A–J 合并验收 **632/632**，不宣称 632 是同一次入口输出。
- 日志：系统临时目录 `7coder-opt13-all.log`、`7coder-opt13-i-final.log`；静态断言 **598**。schema/descriptions 对照 HEAD 未变化，生产依赖未增加。其余工具结构化迁移、完整取消上下文和真实付费端点不在本批范围。

---

## 2026-10-16 —— claude-opus5.5 审阅核对（OP5 系列）

> 输入：docs/history/claudeopus5.5审阅.md（基线 67f1ada，运行于内网；安全类按既有决策不在范围）。
> 核对方式：主会话逐条对当前代码验证。**六条全部属实，零不实**（连读三份审阅后首份一次通过的）。
> 其测试观察与本地一致：test-all 12 目标全绿；单独 runner 会吃本地 .env —— 正是其第 1 条的实证。

### 核对为真的问题

| # | 位置 | 问题（核对结论） | 状态 |
|---|------|------|------|
| OP5-1 | test/_shared.js vs scripts/test-all.js | **runner 不隔离本地 .env**：loadBaseline()（.env.example 覆盖 + 强制 ENABLE_AUTO_DEBUG=false）只存在于 test-all.js；单独跑 runner 时本地 .env 的 PERMISSION_MODE=auto / ENABLE_AUTO_DEBUG=true / HEAVY_MODEL=qwen3.7-plus 泄入 → npm test 4 项失败（adv auto_debug 文案、editnet 连锁崩溃、/v1/models 键控断言），恢复默认值后 85/85。**审阅者自己完成了因果证明** | ✅ OP5 快批（glm-5.3-flash 修复 + tierflow_pro 门禁 + 主会话终检）：applyBaselineEnv() 下沉 _shared.js create() 首行（与 test-all loadBaseline 同规则，幂等），58 处 process.env 泄入自动消失。主验收：npm test 红 78/82 → 绿 88/88（超 85 的差额自证：editnet 崩溃恢复 3 条 + 新增 3 条）；隔离探针注入四值后 create() 内全部归位 |
| OP5-2 | index.js（现 5391 行） | 单文件过大（=OPT-3 暂缓项的复述，附具体建议：优先拆 startHttpServer ~4475 与 executeToolRaw ~2178，边界最清楚） | ⬜ 并入 OPT-3（用户既有暂缓决策不变，此建议留作重开时的切入点） |
| OP5-3 | startHttpServer 路由链 | 连续 if(method&&url) 路由 + 鉴权行每路由复制一份（易漏，OP2-4 曾漏三个）；缩进层级不一致（/api/todos 前与 /v1/models 后不同）属实 | ✅ 主会话实施（2026-10-17）：ROUTES 表驱动 dispatch（17 路由：method+url+auth+handler），鉴权收敛为单一 hasAuth() 门——新路由声明 auth:true 即受保护，不可能再漏贴 401 块（OP2-4 曾漏三个）；handler 逐字搬运原 if 链分支（含 chat 流式/审批桥/请求门全部语义）；writeWorkspaceEnv 提升出回调；缩进层级统一；hOpen 的死变量 loopbackBind 顺带移除。回归：A 88/88 + B 314/314 + test-all 12 目标全绿 |
| OP5-4 | index.js:123 | LIGHT_MODEL 默认 'gpt-3.5-turbo' 过时（SUMMARY_MODEL 继承它）；建议未配置时回落 HEAVY_MODEL | ✅ 历史快批修启动回落；2026-10-23 T22-11 扩展为按本次执行模型继承并固定路由，保留显式辅助配置。旧 light-model-default 2断言仍是历史证据；本次双端点33/33，详见第六批。dist/.cache/历史文档按冻结件保留。 |
| OP5-5 | updateCompleteSummary | auto-log 只增不去重不限条数（机制核对属实——push 后原样重建）；本地根 7CODER.md 现仅 11 条 bullet 尚未膨胀，但"10 条近似条目"的场景在内网环境已出现 | ✅ 快批：严格相等去重（连续相同摘要 bullet 数恰 1 + stdout 含 dedup 消息）+ 60 条上限（slice(-60)，源码断言；61 条端到端未构造，如实标注）。连带修复：runner-f perf / runner-h rss-soak 的完成计数正则同步接受 dedup 行（去重后旧正则漏计，门禁实抓红后修） |
| OP5-6 | 仓库整洁 | 根目录空目录 '-p'（Windows 误用 mkdir -p 遗迹，核实存在）；.workbuddy/ 未跟踪也未 ignore（用户个人目录，此前刻意不动，ignore 是合理处置） | ✅ 快批：空目录 -p 已删（删前 ls -A 确认为空）；.gitignore 增 .workbuddy/（git check-ignore 验证）。repo-hygiene 场景 1 断言 |

### 与既有项的关系

- OP5-2 = OPT-3（暂缓决策不变）；OP5-3 与 OPT-17 后半（统一入口）同族；OP5-4 是 QUICK 新发现（此前无人提过 LIGHT_MODEL 默认值）；OP5-1 揭示的是**测试基础设施**缺陷——单独 runner 与 test-all 结果不一致直接侵蚀"npm test 可信度"，审阅者的修复方向（下沉到 _shared.js）正确。

### 建议批次

1. **小批**（OP5-1 + OP5-4 + OP5-6：半小时级，恢复 npm test 可信度）
2. OP5-5（去重+上限，半天级）
3. OP5-3（路由表，一天级）；OP5-2 维持暂缓

---

## 2026-10-22 —— 双阶段审阅合并待办

### 使用范围与合并规则

来源：[第一轮完整审阅](docs/PROJECT-REVIEW-2026-10-22.md)（下称 R1）、[第二阶段增量复核](docs/PROJECT-REVIEW-STAGE2-2026-10-22.md)（下称 R2），以及本文既有问题状态与用户决策。基线为 `6a1e325`／2.19.0；此清单是三份文档的合并排期，**不是第三轮代码复核，也不是修复完成声明**。

- T22 为修复/工程任务，V22 为专项验证；同一问题跨文档出现只登记一次，验证项不重复计作 Bug。
- **P0**：相关能力发布前必须解决，或明确禁用该能力并说明限制；**P1**：长期运行稳定性版本应完成；**P2**：近期补齐的可靠性与诊断工作；**P3/暂缓**：按既有决策，不自动重开。
- 优先级不等于严重程度。表中「确认」沿用报告证据；「风险」未声称已复现，「混合」包含明确错误路径和待实测部分。全部 T22 初始为 ⬜，不因历史相似项为 ✅ 而自动关闭。
- 每项关闭需具备对应代码改动、完成条件和必要验证记录；不能只凭文案、断言数量或某套全绿。历史已修部分保留，新范围在本节跟踪。
- 按当前用户规则，后续实施默认只做最小必要验证，优先阅读/静态/类型检查；同一测试最多运行一次，失败先分析，不循环重跑。确需多轮先说明原因并征得同意。下表是建议验收条件，**本次均未执行**。

### P0：发布前的修复与交付条件

| 状态 | ID | 严重程度／证据 | 待办与完成条件 | 来源／既有项 |
|---|---|---|---|---|
| 🔶 | T22-01 | Medium／确认 | **先隔离测试工装**：所有子进程显式独立 cwd/配置和超时；真实桌面/真实模型单独 opt-in；不临时改安装根权限；清理只针对本次 PID/身份。验收时真实 `.env`、仓库元数据和正在运行的 Agent 不受影响。后续行为测试依赖此项。 | R1 M16；OP5-1 已做基线下沉，但没有覆盖这些例外路径 |
| 🔶 | T22-02 | High／确认兼容错误路径 | **修 Win7 网页启动器**：替换 PS2/CLR2 不存在的 IsNullOrWhiteSpace；缺运行时/入口/工作区时明确报错并返回非零。默认 Win7 PS2 下通过双击和命令行、中文/空格工作区验收。 | R1 H01；C5 |
| ⬜ | T22-03 | High／部署风险 | **固定离线浏览器与依赖基线**：明确 Win7 x64、固定 Node13、可写工作区、浏览器版本、本地/内网模型条件；离线准备浏览器，页面检测关键 API 并显示不支持原因。目标机无系统 Node/npm 也能完成基本聊天。 | R1 H02、Win7/离线章节；C5 |
| ✅ | T22-04 | High／确认 | **隔离 SSE 解析异常**：10-23完成结构校验、事件回调捕获、统一单次结算、提前close/aborted处理及失败销毁；原解析函数故障矩阵与实际HTTP null帧后下一请求恢复通过。 | R2 N02；index.js parseSSEStream；test/stream-context.js；本批31/31，详见10-23第二批记录；未宣称全部网络异常组合或Win7已验收 |
| ✅ | T22-05 | High／确认 | **保护压缩前原始上下文**：10-23完成失败/空摘要明确报错且不改原数组；按20K分段全部输入成功后才提交；当前用户要求原文保留，工具参数/已完成副作用进入摘要输入；后续段失败零提交。 | R2 N03；index.js summarizeConversation/compressConversationIfNeeded；test/stream-context.js；31/31＋旧边界2/2；真实模型摘要质量仍有单独限制 |
| 🔶 | T22-06 | High／确认 | **贯穿取消与截止时间**：68fa239、50e0d47、64daf8c已补模型/审批、网络/下载/MCP/shell、dream/BTW；第四批补debug观察、异步编译、fixer与重启前检查，取消后不再启动下一轮。debug21/21＋A定向20/20＋B sec2 9/9，均Node13单次。**未完成**：同步IO、全部副作用截止及进程树停止；远端/后代结果仍可能未知，继续与T22-07联动，不关闭整项。 | R1 H03；R2 C02；OPT-15、A5、A2-06；本日第四批记录 |
| 🔶 | T22-07 | High／确认＋风险 | **统一进程树所有权与退出清理**：10-24首批补task/cron直属close观察与5秒停止期限；cron删除失败禁用但保留句柄，task超时为stop-unknown、迟到close纠正，/bye并行等待并诊断；保留异步有界taskkill树停尝试和cron防重叠；c033208再修Git持久Bash启动器残留，直接持有实际解释器并验证close。专项19/19＋Windows树夹具6/6＋B定向13/13。**未完成**：原生进程树所有权、taskkill PID复用竞态、所有命令/MCP/shell/debug统一回收、强杀/注销及one-shot语义；直属close不证明任意后代已停。 | R1 H04、M08；A10、NEW-2；与 T22-06 联动；本日进程生命周期首批记录 |
| ✅ | T22-08 | High／确认＋风险 | **串行化交互审批并修 REPL 等待**：2026-10-23 第三批落地单一 CLI 问题队列，EOF/close 结算全部问题、取消结算对应问题；审批和询问用户共用输入分派。任务在首个 await 前占位并取走草稿，BTW 按草稿排队，后续输入进入下一草稿，clear 后旧回调不污染新草稿。Node13 新回归20/20＋既有btw-eof 1/1，均单次；真实Win7终端待验收，HTTP活动取消仍属T22-06。 | R2 N01；R1 M10；D6；提交5149903 |
| ✅ | T22-09 | High／确认 | **下载替换不先删原文件**：2026-10-23 第四批移除目标 unlink；独占打开唯一临时文件，等 close＋fsync，严格完整旧版备份发布后单次 rename 覆盖，失败不删目标；复用有保留上限的 /undo 恢复。Node13故障专项获准复跑41/41，既有下载6/6；提交边界骤停及新进程恢复通过，实Win7/占用/断电仍待验收。 | R1 H07；AST-05；提交7ce82f9 |
| ✅ | T22-10 | High／确认错误路径 | **文件编辑编码止损**：2026-10-23 第五批对读/提示词文件/写/追加/编辑/notebook实施UTF-8可逆检查，拒绝不支持的字节与NUL，不猜测GBK；保留BOM及单一换行风格。现存文件写入统一完整严格备份，失败阻断；恢复时间戳顺序保护。Node13专项46/46、既有读取/保留6/6，均单次。普通文本写入仍可能部分失败，需undo恢复；实Win7/字节编码歧义见第五批边界。 | R1 H08；A2 的 chcp 修复不覆盖文件编码；提交f2e9409 |
| ✅ | T22-11 | High＋Medium／确认 | **统一模型继承与请求路由**：2026-10-23 第六批区分显式/默认辅助模型，以不可变上下文固定选定主/轻/摘要及端点/密钥，贯穿子代理、workflow、审批、压缩、摘要等；设置热切换作用于新执行，在途及其摘要保留原路由。严格双端点专项获准复跑33/33，流/压缩31/31；实Win7与真实模型待验收。 | R1 H09；R2 N06；OP5-4、DS-2、多模型路由；提交c86614b |
| ✅ | T22-12 | High／高可信风险 | **处理 MCP/持久 shell 管道故障**：2026-10-23 第七批补stdin/stdout/stderr错误、EOF/close结算、幂等退役及缓存身份校验；覆盖Node13缺stdio的异步spawn失败，不缓存失败会话；MCP双向4MB帧、shell采集8MB/单活动命令；超时/失败明确结果未知，不重放。专项首跑28/28，补边界后经用户允许仅复跑一次30/30（均无跳过）；既有MCP8/8仅首跑。Win7原生EPIPE及进程树停止仍待实机/T22-07。 | R1 M07／R2 C03；GAP-1/GAP-2；不含已撤回的 .cmd 断言；提交95aed08 |
| ✅ | T22-13 | High／数据风险 | **关键状态可靠落盘与损坏恢复**：2026-10-23 第八批统一todos、CLI/Web session、models、`.env`、记忆/工作日志等独占临时文件＋flush/close＋rename，保留上一完整版本；JSON/编码失败保全原字节、恢复有效旧版，无有效版拒绝且告警。设置先落盘后更新运行态；凭据副本保护、内置Git排除同步补齐。Node13专项首跑59/59、无跳过；实Win7/真实磁盘满与占用/断电未验收。T22-14已补同机工作区独占；共享安装配置回退改只读。 | R1 H10落盘部分；GAP-6/GAP-9、D4；格式可解析但语义缺失的损坏不保证识别；详见第八/九批；提交e862a03已推送 |

P0 中 T22-03 属交付条件，T22-01 属验证前置；没有把二者伪装为新增代码崩溃。若某能力明确禁用，只能关闭对应受限发布门槛，原问题仍保留待修。

### P1：长期运行稳定性与状态一致性

| 状态 | ID | 严重程度／证据 | 待办与完成条件 | 来源／既有项 |
|---|---|---|---|---|
| ✅ | T22-14 | High／数据风险 | **建立工作区多实例协调**：2026-10-23 第九批采用同机真实工作区单Agent，Windows命名管道独占在配置读取/恢复前获取，大小写/junction同身份；OS随进程释放，无持久锁/PID删除。冲突/冻结/未知身份拒绝启动，不误杀；后台父子显式交接并确认子进程持锁。共享安装配置只读回退。专项首跑19项后夹具关闭超时，修夹具后获准仅复跑一次25/25，无跳过。实Win7/跨账户及会话/复杂进程树待验收。 | R1 H10多实例部分；T22-13；不含旧版Agent/外部写入、跨主机共享或重叠工作区；详见第九批；提交5fb6d38 |
| 🔶 | T22-15 | High／高可信风险 | **在采集处限制内存**：shell每次8MB/单活动、MCP每帧4MB、debug每周期合计8MB已做；10-24再补后台task合计8MiB触发停止、128KiB UTF8尾部、4活动/50历史，未知停止继续占名额；exec兜底8MiB/stream、错误文本限长；cron32项且ID不覆盖。task-budget18/18、B内容透传6/6、C带后台任务/bye1/1通过。仍待全Agent总字节预算、MCP待发积压/并发、摘要/HTTP准入、大文件窗口；局部限制不等于全进程有界。 | R1 H06；C8；T22-12及本日debug/后台预算批局部证据 |
| ✅ | T22-16 | High风险＋Medium确认 | **有界摘要队列与聊天准入**：10-24流/非流共用独立串行摘要队列，8项/2MiB（含活动与路由）、60秒排队/120秒或原截止时间，超载/排队过期写有界简短记录、原请求过期及shutdown不fallback；<200字符继续跳过。聊天读正文前最多8项、正文共享16MiB/每项10MiB/读取30秒，核心排队60秒，取消立即移除，仍串行权限状态。/api/info提供负载。新专项25/25、B正文/摘要15/15、C混合6并发1/1、E日志竞争1/1均Node13单次；24/72h/Win7仍由V22-08/01验收，不等于全Agent内存有界。 | R1 M01；R2 N04；AST-R1/AST-15；本日队列批记录 |
| 🔶 | T22-17 | High／确认＋风险 | **隔离 HTTP 持久 shell 状态**：10-24落实受限方案，HTTP模式（含danger、子代理、workflow及启动维护）拒绝persistent=true，单次命令保留，schema/诊断明确提示；CLI主会话保留，子代理/根workflow结束finally退役自身shell、agent内workflow留到agent结束，不再让后续同深度scope继承cwd/env。新shell-scope17/17、B定向27/27、I定向24/24单次；超时oracle另经c033208修正、新真实Bash专项8/8；不等于树回收完成。**未完成**：HTTP跨请求持久会话身份/恢复/关闭协议，完整后代回收仍属T22-07；只能按persistent禁用的受限版本部署。 | R1 H05；OPT-16、GAP-2、A2-14；本日shell作用域记录 |
| 🔶 | T22-18 | High／确认＋风险 | **修 auto_debug 生命周期与终态**：10-24已补pid/error/exit/close及退出码、仅操作未退出直属ChildProcess句柄、5秒close确认/未知结果、取消贯穿编译/观察/fixer/重启边界、3轮修复上限与递归拒绝、stdout+stderr合计8MB；失败明确error。JS用随包Node；C#每轮重编译（INC-24-02）。模板默认禁用，GUI仅被动观察，停用无目标确认的随机输入且不宣称验证UI。专项21/21、A定向20/20、B sec2 9/9。仍待进程树确认和真实Win7/GUI/C#环境验收，保持部分完成。 | R1 H11；R2疑点4；A2-09、C1/C3；本日第四批记录 |
| ✅ | T22-19 | Medium／确认 | **网页会话保存与失败历史**：10-24单在途＋一个最新不可变快照、首存确认后复用file，dirty/可见失败/手动重试/15s超时及未保存离开提示；同会话发送不变身份。保留running/failed/cancelled/ok、partial正文和带turnId跨轮活动，手动/自动恢复相同；无DONE的EOF为失败，下一模型看到partial提醒。UI/Web/CLI统一2MiB UTF8字节；活动超2000拒绝而非丢前轮。新专项修共享UTF8工装后20/20，UI43＋DOM15、B边界7单次；实浏览器刷新/Win7仍待V22-02。 | R1 M03/M04；OPT-16/A2-12保护保留；本日会话批；OPT-6多客户端策略不重开 |
| 🔶 | T22-20 | Medium／确认 | **继续收口权威工具状态**：当前 **48/53工具名**，包含本日auto_debug全部终态显式迁移。子代理取消/异常、命令stderr/exitCode收尾保留。余下mcp_tool/mcp_list_tools_tool/web_browser_tool/plan_mode/bickering_tool，以及computer_use输入分支显式状态、MCP external完整结果核对仍待实施；不以注册数代替分支正确性。 | R1 M05；A2-07；INC-24-01；本日第四批记录 |
| ⬜ | T22-21 | Medium／确认 | **统一有效权限、审批展示与生命周期**：执行前复核 mode/cancel；界面反映 --danger 强制项；收到成功审批响应才显示批准；工作流展示真实嵌套 steps/参数再继承批准；停止/切会话 dispose 审批倒计时。denial切换、迟到审批、400/401、具体命令预览均有验收。 | R1 M09/L05；R2 N05；P0-3/P2-12；取消实现复用 T22-06 |
| 🔶 | T22-22 | Medium／确认＋风险 | **启动失败与 dream 恢复闭环**：T22-14启动门及dream owner/finally/deadline已做；10-24再补HTTP先bind再启动维护/显式任务、页面/诊断就绪；可选dream最多120秒且前台请求可取消，等待settle后交门；显式startup-task优先但状态可见，失败标failed且允许恢复。新startup-readiness13/13含真实端口失败零模型调用、dream挂起/抢占/超时、显式任务和直属Agent强杀重启锁恢复。仍待真实ACL/目录不可写、关机注销/进程树退出全链路及Win7；旧格式新锁保留4小时宽限。 | R1 M12；A2-08、A10；本日辅助/启动批记录，保持部分完成 |

### P2：近期补齐

| 状态 | ID | 严重程度／证据 | 待办与完成条件 | 来源／既有项 |
|---|---|---|---|---|
| 🔶 | T22-23 | Medium／确认 | **内部工具复用随包运行时**：JS调试已用process.execPath；10-24测试自动识别补Node13明确错误零启动，支持--test的16.17/18.1+分支用execFile(process.execPath,argv)不依赖PATH；保留npm脚本优先及显式命令，损坏package配置不再吞错。新test-runtime11/11（含PATH为空中文/空格脚本）、旧测试解析6/6。现代版本分支为原函数选择/argv测试，非实际Node18运行。仍待npm/Git/Bash/Python/csc/tsc/eslint按功能预检与Win7依赖验收。 | R1 M02；本日debug/测试运行时批局部证据 |
| 🔶 | T22-24 | Medium／确认编码路径 | **PowerShell编码闭环**：10-24统一UTF16LE Base64/固定ASCII入口，解析用户脚本前设置UTF8 output；避开实测EncodedCommand的ANSI CLIXML stderr，保留最终Write-Error/throw/显式exit；input.ps1补UTF8 BOM，桌面/截图改execFile argv。新专项根因修复后14/14、旧命令契约21/21；现代宿主实测非真实Win7/PS2/CP936，目标机和自定义编码native工具仍待验收，保持部分完成。 | R1 M06；A2/chcp保护保留；本日PowerShell批 |
| ✅ | T22-25 | Medium／确认 | **修盘符/共享根目录包含判断**：10-24用relative边界判断，排除父级/绝对结果，消除drive/UNC根末尾双分隔符误拒；保留Win大小写、不同卷/共享及realpath/junction门。新专项修夹具后25/25：纯路径边界＋映射到私有目录的drive/UNC根真实state/文件/备份IO及实际外指junction拒绝；无真实根/网络共享写入。Win7真实根/远程文件系统语义仍由V22-01/05实机验收。 | R1 M11；OPT-14原安全门保留；本日路径批记录 |
| ⬜ | T22-26 | Medium／确认＋风险 | **磁盘保留与会话历史策略**：为 snapshot refs、Web会话、截图、background/BTW/TODO日志设时间/总字节策略；T22-13新增的不同损坏证据/骤停临时文件亦需保留策略，不能删活动实例文件；CLI/Web 不按文件名前缀误删对方历史；会话列表可分页/索引。保留现有审计轮转、每源5/全局200备份，不重复实现。 | R1 M14；GAP-12、OP5-5、C8；10-23第八批补充保留范围 |
| ✅ | T22-27 | Medium／确认 | **修 Markdown语言属性转义**：10-24新增属性上下文escAttr，在原HTML转义后补单双引号实体，仅data-language使用；文本/code渲染保持。DOM专项15项单次通过，含相邻属性注入形状、引号/&/尖括号、空language、c++/c#与未闭合围栏。实际目标浏览器仍属V22-02；不把桩DOM宣称为真实脚本执行验证。 | R1 M15；A2-04保护保留；本日Markdown属性批 |
| ✅ | T22-28 | Low／确认 | **修 git status 首行 trim**：10-24只去末尾CR/LF，保留首项XY的index空格；CRLF按行计数。旧Git集成断言由错误staged:1/modified:0改为staged:0/modified:1并检查实际前导空格。新真实隔离Git专项9/9（未暂存/已暂存/MM/未跟踪/clean/CRLF/故障）、旧Git集成4/4，Node13均单次。 | R1 L01；DS-4/P2-11原分列保留；本日Git首列记录 |
| ✅ | T22-29 | Low／确认 | **统一 memory 自动写路径分隔符**：10-24先将relative路径分隔符归一为/再匹配例外；原函数＋实际私有磁盘写入证实反斜杠memory在default模式可自动写，普通source仍需审批，deny/denial/protected-extra不被绕过，外指junction仍拒绝；新路径25/25、旧权限8/8。 | R1 L02；GAP-9；本日路径批记录 |
| ✅ | T22-30 | Low／确认 | **修搜索输入与扫描预算**：10-24 grep支持单文件，缺失/越界不伪装无匹配；glob按每个目录条目计4×匹配预算，grep同样计跳过/不匹配条目并限深12；深度/访问/读取失败显式incomplete，原匹配截断marker保留。新scan-budget修夹具后21/21、旧B扫描/结果契约13/13；无opts备份遍历保持原语义。同步readdir分配和正则CPU预算未解决，详见疑点。 | R1 L03；P2-3、A2-20保护保留；本日扫描批记录 |
| ✅ | T22-31 | Low／潜在风险 | **cron ID 唯一**：T22-15已用timestamp+cronSeq并拒绝显式重复ID；10-24新增固定时钟原函数专项9/9，两创建别名同毫秒独立Map/timer、各自执行/跳过重叠、独立删除/close/清timer，迟到回调不复活。此项不代替真实进程树/Win7长期验收。 | R1 L04；NEW-2不重开；本日cron身份批记录 |
| ✅ | T22-32 | Improvement | **补最低运行诊断**：10-24 /api/info复用队列负载并补活动任务/工具、最后成功/错误和日志故障；CLI/HTTP终态、工具失败、background/cron真实close写UTF8 runtime.jsonl＋一个old，各1MiB，轮转失败不继续append；字段有界/常见token脱敏，errno/path/PID/exit可用时保留。新专项21/21、旧工具取消20/20、cron重叠6/6；进程内状态重启清零，早期配置失败仍stderr，非全链路runId/树退出证明。 | R1日志/长期运行；R2 N04；本日诊断批；DS-13/OPT-3仍暂缓 |
| 🔶 | T22-33 | 工程验证缺口 | **修测试假阳性与证据口径**：10-24修pshell先决条件为6秒内建watchdog/1秒工具期限；新独立真实Bash专项首跑暴露bin/bash启动器残留，修产品后获现有自动复测授权复跑8/8，必须观察close、下一环境与命令可用性，SKIP单列。旧pshell修后未重复跑。其余仍待：信息/skip不记PASS、D按调用ID、stderr预览假命中、MAX_TOOL_STEPS=0、K/R真实workflow/第二模型、严格tool配对、mock错序。 | R1 §10.3；R2 N01/N02/N03；本日INC-24-03及超时oracle记录 |

### V22：验证与发布门槛（均未执行）

以下是有限、分阶段的验收任务；代码修复所需局部反例优先并入对应 T22，不再另立重复 Bug。V22-01/02/03/05/06/07/08 是相关 Win7 长期运行版本的交付门槛；V22-04 按启用能力验收。

| 状态 | ID／优先级 | 验证范围与通过条件 | 依赖／对应来源 |
|---|---|---|---|
| ⬜ | V22-01／P0 | **干净 Win7 SP1 x64**：PS2/CLR2、无系统Node/npm、普通用户与管理员、双击/CLI、中文/空格/盘符根工作区；确认真正 ready、失败退出码、DLL/补丁与浏览器前提。Node13在现代Windows运行不能代替此项。 | T22-02/03/23/24/25；C5；R1 Win7专项、R2重大疑点1 |
| ⬜ | V22-02／P0 | **真实目标浏览器＋实际后端＋物理断外网**：本地模型聊天/工具/审批/停止/重发/保存/恢复、无隐式在线资源；关键API缺失显示明确原因。不能仅用UI fixture替代后端。 | T22-03/06/19/21；OPT-17已有浏览器测试仍有价值 |
| 🔶 | V22-03／P0 | **核心负向时序**：已有T22-04/05/08/12及T22-06首批的流/压缩/审批/超时恢复证据；10-24第二批另证实下载等头/半流/close/备份后取消保全、备份耗时越过截止时间不提交、8类网络分支部分JSON正文取消及审计、MCP半初始化/活动RPC取消/旧退出身份隔离、真实直属MCP退出及shell取消结算。dream/BTW/调试内部、完整零迟到副作用、进程树及Win7仍未验收。 | T22-04/05/06/08/12；R2新增High；第二批工具20/20、管道37/37 |
| 🔶 | V22-04／P1 | **启用能力专项**：已有双端点路由33/33、管道37/37、本日debug21/21局部证据。仍待持久shell跨真实HTTP会话、cron全生命周期、真实GUI/目标焦点与Win7/C#环境；当前debug主动桌面输入已停用，不能把被动观察当UI验收。 | T22-07/11/12/17/18/31；C1/C3/C6、GAP-4；本日局部进展 |
| 🔶 | V22-05／P0 | **进程树与第二次启动**：T22-14已有真实直属Agent强终止、/bye、冻结owner、one-shot后台交接及再启动的OS独占证据；三层心跳/文件锁/端口、活动取消、真实Ctrl+C/关窗口/注销/关机与Win7仍待验收。独占释放不能证明后代停止。 | T22-06/07/14/22；R1 H04/M08；10-23第九批仅直属进程与所有权 |
| 🔶 | V22-06／P0 | **数据完整性故障注入**：T22-09/10/13/14已完成本地下载、编码/快照、关键状态IO故障/损坏恢复/提交边界骤停、新进程恢复及双实例拒绝/先后写入不丢todo证据；尚须真实磁盘满/只读/占用、Win7双实例/不同账户与断电验收。不能以本地注入或process.exit边界替代真实断电与整项发布验收。 | T22-09/10/13/14/19/24；R1 H07/H08/H10；10-23第四/五/八/九批记录 |
| ⬜ | V22-07／P0（最后执行） | **从最终固定源码重建实际ZIP并验收**：更新build identity，清单/哈希与源码对应；包含所需修复，零真实.env/测试残渣、运行时/依赖齐全；在解压包上完成冒烟及关键验收。现有同版本ZIP不能当当前源码证据。 | R1 M13；10-17 ZIP早于10-20迁移；依赖拟发布范围内的T22完成 |
| ⬜ | V22-08／P1（长期版发布门槛） | **24h→72h真实工作量**：限制队列/输出预算后，记录RSS、句柄、子进程、磁盘、排队年龄与最后成功；含慢摘要、模型断连恢复、连续会话/大输出。确认增长有界且不假活；更高并发限流按实际负载验证。 | T22-15/16/26/32；C7/C8；短24任务RSS不能关闭此项 |

### 待验证风险：先确认，不作为已复现 Bug

| 状态 | 疑点与处理方式 | 归属，避免重复计数 |
|---|---|---|
| ⬜ | grep 歧义分支如 `(a\|aa)+$` 是否仍阻塞事件循环；只在隔离进程＋严格时限中验证，确认后补修复项。 | R1疑似1；T22-30的扫描计数修复不等于regex预算已完成 |
| ⬜ | 截图/open/MCP批处理的特殊字符路径与参数；分别检查Node13与现代Node fallback。不得恢复「绝对路径.cmd必然启动失败」断言。 | R1疑似2、R2 C01；V22-01/04 |
| ⬜ | UNC/网络盘断连、cmd cwd、提权后映射盘可见性；若不支持，应明确部署限制。 | R1疑似3；V22-01/06 |
| ⬜ | audit轮转目标占用、download writer错误/关闭与HTTP body销毁组合，观察真实句柄而非只看catch。 | R1疑似5；T22-09/26、V22-06 |
| 🔶 | SSE/MCP/shell旧对象问题已有T22-04/12证据；auto_debug修复上下文可调用同一工具的路径现以受控fixer实际驱动并拒绝递归。真实GUI、复杂进程树及Win7仍需验证。 | R1疑似6、R2疑点2/3/4；T22-04/12/18、V22-03/04 |
| ⬜ | 历史受限环境5条断言逐项对账；无法对应时保持未验证，不能用另一环境全绿替代。 | ISSUES-LOG 10-04/10-11验证备注；按实际部署相关性定向核验 |

### 历史状态与报告修正：本次已做的文档归并

| 对象 | 当前采用的口径 |
|---|---|
| R1 M07 的绝对路径 .cmd 判断 | 按 R2 C01 撤回泛化断言，不列修复待办；管道异常与缓存竞争已由T22-12修复，进程树停止仍属T22-07。历史报告保留原文以便追溯。 |
| R1 Critical 与 --help 证据 | 按 R2 C04/C05：Critical 不要求所有部署触发；--help不证明dotenv初始化。本清单没有新增Critical或扩大既有验证结论。 |
| A5/A2-06/OPT-15 | 既有接线与T22-06首批模型/重试/审批修复保留；第二批已补下载/网络/视觉、MCP和持久shell活动等待及下载提交边界。dream/BTW/调试内部、同步IO、全部副作用/进程树截止仍开放；不能把A5旧✅或专项通过数理解为完整取消已验收。 |
| OPT-13／10-20第四批 | 24/53与第七批47/53均为历史进度；截至本日debug批当前48/53，仍部分完成。子代理/命令/debug终态收尾保留；剩余5工具与computer_use遗留分支归T22-20，注册计数不代表所有返回分支均已显式结构化。 |
| OP5-4／多模型路由 | 启动回落保留；2026-10-23 T22-11已补热切换继承、执行路由快照与子代理模型传递，原缺口由第六批证据关闭；并非重新宣称旧启动测试覆盖全部路由。 |
| GAP-2/A2-14、A2-12/OPT-16 | /clear清shell与页面sessGen已做；10-24 HTTP persistent先禁用，CLI子代理/workflow补scope退出清理；跨请求持久shell身份协议与保存最新快照仍归T22-17/19。 |
| AST-R1/AST-15/NEW-2 | 非流式摘要后台化、主任务串行、cron防重叠均保留；补队列边界及进程归属，不能因此重开全并行架构。 |
| C5/C8及历史全绿 | C5不接受“现代宿主Node13等价Win7实机”的关闭口径；C8短会话验证仍只算部分覆盖。历史通过记录保留，不作为新增问题已修证据。 |
| P2-11/DS-4、A2-04、OP5-1 | 原分列、错误气泡转义、基线下沉修复保留；各自新增边界归T22-28/27/01，不把历史有效修复抹掉。 |
| R1 M13与10-17发布记录 | ZIP在当时完成过发布验证，但早于后续源码变更；统一归V22-07最终重建，不把旧产物当新修复包。 |

### 保留暂缓／不做／非Win7交付必需项

- **P3暂缓**：OPT-3/OP5-2大规模模块拆分、DS-13完整runId及自动提交统计；OPT-6/AST-15多客户端分桶与ExecutionContext并行架构；D3完整LSP；GAP-7b hooks。具体正确性修复不必等待这些大工程，也不代表自动获得重构授权。
- **⛔沿用不做**：A12严格参数解析、C9/GAP-13精确tokenizer、P0-4设置接口明文密钥、OPT-2公网/跨站管理面加固、预植硬链接别名防护；GAP-1新MCP HTTP/SSE transport、GAP-2真正交互终端、Node LTS双轨构建不因本次合并重开。
- **非本次发布门槛**：C2真实外网搜索、GAP-10真实Brave/Bing、C4完整macOS/Linux实测；按将来功能/平台范围决定。C3/GAP-4真实桌面与视觉若启用则进入V22-04，不能一律当可忽略。
- 维持锁定依赖、权限/路径硬检查、Git argv、cron防重叠、备份保留与页面离线主体；不为现代化换框架、语言或操作系统。

### 可执行批次顺序

1. **工装前置**：T22-01，修复污染真实环境的测试路径后再执行行为验证。
2. **小范围阻断修复**：T22-02/04/05/08/09/10/11/12；交付基线T22-03同步落实。每项随最小反例验收，不按历史全量门禁重复跑多轮。
3. **跨模块生命周期**：T22-06/07/13/14/22，再补T22-16/17/21；取消、审批、进程和持久化需联合核对，不能只靠局部绿测。
4. **资源与功能闭环**：T22-15/18/19/20，以及与目标项目直接相关的P2编码/路径/保留/诊断项；修对应测试oracle T22-33。
5. **发布验收**：按启用能力执行V22专项；固定最终源码重建ZIP，在实际包上完成V22-07；长期版完成V22-08。未通过的门槛必须明确标出或禁用相关能力，不能宣布“待办清零”。

本次仅新增合并清单与当前索引；没有修改产品源码、重建包或运行任何测试。待办优先级为建议排期，不表示已授权所有暂缓项，也不表示任务已经修复。

---

## 2026-10-23 —— T22-01/T22-02 第一批实施

### 已落地的改动

- `test/_shared.js`：每个A–J runner创建独立系统临时安装副本（index/package/webui/env模板），不复制真实.env/models/permissions；通过NODE_PATH只读加载现有依赖，无npm安装或管理员junction依赖。工作区移出源码仓库，避免继承真实.git。离线基线移除继承的代理设置。
- A–J的spawn/spawnSync经共享工装，提供默认独立cwd/环境与时限；登记本次异步child及带运行身份的manifest；CLI超时和收尾只处理所属child。原有按场景指定的环境和超时仍保留。
- `runner-i cli-strict`：独立cwd、10秒上限、明确本地配置；未知参数断言用--help验证解析，不再为检查警告发真实任务。真实键鼠场景要求`DESKTOP_TEST=1`，默认SKIP且不计PASS。
- `runner-b sec1`的安装级permissions只写临时安装；legacy npx改为本地shim，避免下载真实npm包。B/C/D/H的工作区外探针目录改在本次临时运行目录中。
- `test/kill-orphans.ps1`：删除按名称宽泛匹配，改为显式`-Manifest`、每个PID核对独有命令行身份；默认dry-run，`-Apply`才执行树杀；使用Win7可用的Get-WmiObject。未运行实际清理操作。
- 增加`test/harness-isolation.js`及`npm run test:harness`，README说明临时目录、桌面opt-in、独立skip口径和显式清理方式。临时安装与manifest保留诊断；工作区/原有mock产物仍由工装收尾清理。
- `scripts/start-web.ps1`：用空值/Trim判断替代CLR2没有的IsNullOrWhiteSpace，并增加入口文件存在性检查。未启动真实项目服务。

### 本轮验证（不是全量验收）

| 检查 | 实际结果与边界 |
|---|---|
| Node13 --check | 修改时的共享工装、新隔离回归及A–J，共12/12；只执行一次。随后仅修改fixture返回格式、本地npx shim和外部测试路径，未重复语法命令。 |
| PowerShell宿主解析 | 启动器与清理脚本2/2；现代宿主解析，不代表真实PS2/Win7已经验收。 |
| runner-i定向 | `RUN_ONLY=cli-strict,input-escape`：3/3 PASS、1个桌面场景SKIP；单次执行。 |
| runner-b定向 | `RUN_ONLY=sec1`：10/10；单次执行。之后补本地npx shim和外部路径隔离，未重跑该场景；此结果不能作为最终shim已动态验收的证据。 |
| 隔离专项首跑 | 前5项通过，第6项失败；我方fixture只回普通JSON，而实际CLI请求SSE，属于测试fixture错误，非产品隔离失败。后续断言当次未执行。 |
| 隔离专项获准复跑 | 用户明确允许只复跑此命令一次；补SSE fixture后Node13结果10/10，含真实CLI本地调用、所属child清理、无关child存活、真实.env/permissions/index/7CODER.md指纹不变。没有进一步复跑。 |

未执行：完整A–J、K/R、真实桌面、真实浏览器、Win7实机、清理脚本实际杀进程、发布包、长期压测。未提交或打包。原两份审阅报告及先前待办编辑继续保留。

### 剩余工作与关闭条件

- **T22-01 🔶**：隔离实现与关键负向回归已落地；最终本地shim/路径变更需随后续获准的定向验证验收，清理脚本dry-run/身份拒绝/显式Apply需受控验证。A–J切换到新工装后的兼容性尚未全量确认；K/R仍为REAL_TEST显式真实环境套件。
- **T22-02 🔶**：代码修复与宿主解析完成；仍须V22-01的真实PS2/CLR2、双击/命令行、普通用户、中文/空格工作区及启动失败退出验收。
- OP5-1的历史基线修复保留，本次补临时安装与副作用隔离，不改写其历史通过记录。V22-01/05/07/08等仍未完成；其它T22条目未实施。

---

## 2026-10-23 —— T22-04/T22-05 第二批实施

### 修复范围

- **T22-04 / R2 N02**：parseSSEStream校验JSON对象、choices/delta、内容/推理文本、tool_calls及其id/index/function参数。索引限定0–1023，避免异常索引创建失控稀疏数组；正常缺省index=0仍兼容。data/end回调内异常进入统一settle，只结算一次；错误销毁上游并清理监听，close/aborted不会永久等待。destroy期间的异步error有短期保护，close时移除。
- 保留已有噪声行、非错误坏JSON行跳过策略，保留usage-only、工具调用分片、正常DONE与仅finish_reason的兼容逻辑，以及无完成信号EOF报错。正常空流的既有空响应处理未改。未将本批当作T22-06取消/重试的完整实现。
- **T22-05 / R2 N03**：删除只取前20K的隐式截断，分段完整提交，避免切断UTF-16代理对；每段摘要非空才接受，全部完成后才替换历史。失败/空摘要抛出明确的“original history preserved”错误，主模型/工具不再沿错误占位摘要继续执行。
- 当前用户要求在被压缩前缀中时作为原消息保留；老摘要的零进展保护仍存在。工具调用以完整参数JSON加入摘要输入，而非只有函数名；提示要求保留硬约束、已完成副作用和待办。没有引入新依赖或大规模模块拆分。
- 新增`test/stream-context.js`及`npm run test:stream-context`，并接入test-all；后续默认入口比原来多一个目标，历史通过数/快照不回写为本次结果。README说明失败时暂停的行为。

### 一轮最小验证

| 命令/检查 | 结果 | 实际覆盖 |
|---|---|---|
| Node13 --check index.js、test/stream-context.js、scripts/test-all.js | 3/3 | 每文件一次；无语法错误。 |
| runtime/node.exe test/stream-context.js | 31/31，exit0 | 12种异常结构的拒绝/销毁/监听清理；正常中文/工具分片/usage/噪声兼容；close/aborted/error/consumer异常、残缺EOF；失败/空摘要阻断后续调用且原数组不变；>20K全量分段、代理对边界、第二段失败零提交；当前用户原文、工具参数和已完成操作进入摘要；工具配对边界；实际Node13 HTTP坏帧→错误→健康200→下一聊天成功。 |
| Node13 runner-i.js，RUN_ONLY=compress-edges | 2/2，exit0 | 既有压缩dead-zone与首次巨大任务保护；单次执行。 |

所有测试只运行一次，没有失败重跑。实际HTTP使用临时安装、临时工作区和本地假模型；服务由所属进程清单收尾，未调用真实付费模型或操作桌面。主入口变更后仅运行这组与本批相关的检查，未反复跑全套。

### 限制与剩余风险

- **未运行**：完整A–J/UI、真实Win7/浏览器、真实模型、断电恢复、24/72h soak、打包。T22-01/02仍部分完成，其余条目状态按表保留；V22-03仅坏SSE/压缩子范围有本批证据，审批和取消路径尚未验收，不能整项关闭。
- 分段输入现在无主动丢尾，但模型摘要本身仍是有损推理，真实端点可能遗漏较旧事实；当前最新用户消息保证原文保留，不能据此承诺所有历史约束永久逐字保存。已完成副作用的真实模型不重复执行仍需真实模型场景验收。
- 保留当前任务原文和多个分段摘要可能使上下文仍超预算；原零进展守卫会提示，不能承诺任意巨大任务都能自动缩至预算。摘要失败现在明确暂停任务，属于有意的可靠性取舍。
- 模型活动取消、全局门释放与子进程回收仍由T22-06/07处理；旧CLI/页面失败历史恢复仍由T22-19处理；本批没有扩大这些完成声明。未提交、未发布，旧ZIP仍不包含本批改动。

---

## 2026-10-23 —— T22-08 第三批实施

### 修复范围

- `createCliQuestionQueue` 统一持有 CLI 问题与答案；固定的 readline 输入分派替代重叠的 `rl.question`。并行保护文件读取仍保持读并行能力，但问题逐个显示、逐个结算，不再覆盖回调。审批和 `ask_user_question_tool` 共用队列，非交互询问返回 unreachable。
- readline close/EOF 结算活动及排队问题；关闭后不接新问题；有取消回调时只在队列非空期间轮询，取消对应问题并推进，清空或 close 时释放 timer。取消不当作用户答案。`/bye` 在等待问题时仍可进入既有退出流程，先关闭问题队列。本项未改 HTTP approvalBridge 或上游 axios 的活动取消。
- REPL 以草稿对象保存文本和 BTW Promise 链。`/execute-task-now` 在任何 await 前占用执行位、移交当前草稿并建立下一草稿；等待此前全部 BTW 后执行。等待期重复 execute 拒绝；期间普通文本与 BTW 属于下一草稿。BTW 在同一草稿内按输入顺序执行，`/clear` 后旧回调只持有已丢弃草稿。
- BTW 空白摘要回退原文；持久化失败保留内存笔记并输出文件路径及错误，避免一条日志写失败阻断后续笔记链。REPL 异步处理器错误显式输出。没有引入新依赖或重构其它生命周期。
- 新增 `test/repl-approval.js`、`npm run test:repl-approval`，接入 test-all 并在 README 说明草稿、重复执行和 EOF 语义。旧审阅报告与历史通过计数保持原样。

### 一轮最小验证

| 检查 | 结果 | 覆盖与边界 |
|---|---|---|
| Node13 --check | index.js、test/repl-approval.js、scripts/test-all.js 3/3；package.json 解析成功 | 每文件一次。 |
| runtime/node.exe test/repl-approval.js | 20/20，exit0，单次 | 源码原函数＋真实 readline 的串行答案、EOF、关闭后提问、活动/排队取消；临时安装中真实 REPL＋本地 SSE fixture 的双保护读取一批一拒、EOF 后两工具配对完成、多 BTW 顺序/完整等待、重复 execute 不重入、下一草稿保留、BTW日志顺序、clear 后旧回调隔离。 |
| Node13 runner-j.js，RUN_ONLY=btw-eof | 1/1，exit0，单次 | 既有 BTW 后 stdin EOF，笔记持久化且正常退出。 |

所有测试均只运行一次，没有失败重跑。专项使用所属进程工装、临时安装/工作区及本地假模型，未触及真实配置、付费模型或桌面。测试有总时限，防止仅有未决 Promise 时 Node 自动 exit0 造成假阳性。验证后仅将问题显示适配器由 stdout.write 调整为 readline.setPrompt/prompt，并在返回草稿时恢复 You 提示，以维护真实终端光标/编辑提示；队列与任务逻辑未再改，按单轮约定未重跑。这项最终显示接线只有静态检查，不能把前述通过记录当作真实 TTY 已验收。

### 剩余边界

- 未运行：全套 A–J/UI、真实 Win7/TTY、真实模型、24/72h soak、发布包。`/bye` 等待审批分支、提问工具的端到端交互、日志写权限错误和空白摘要回退经代码检查，未单独动态验收；已有源码队列测试不能替代这些现场场景。
- CLI 队列取消验证是原函数层面的时序测试；实际 REPL 没有新增取消命令。HTTP 断连/活动模型取消及全局门释放仍由 T22-06 处理；子进程树退出仍由 T22-07 处理；不会据本批关闭 V22-03 的全部故障场景。
- BTW 摘要若上游请求永不返回，所属草稿仍受上游超时/重试策略约束；本批仅保证等待期间不重入。日志增长、旧会话失败恢复等其它条目未实施。没有修改旧 ZIP，尚未提交或发布。

---

## 2026-10-23 —— T22-09 第四批实施

### 前批提交与本批范围

- 按用户要求，先提交第三批 T22-08：`5149903 fix(T22-08): serialize CLI questions and isolate REPL drafts`；提交后工作区干净，未推送。本批下载改动随后开始，尚未提交。
- `download_tool` 不再 unlink 既有目标。随机唯一同目录临时文件以 `wx` 独占打开，由流负责关闭 fd；流水线传播源/限额/写入错误，明确 `emitClose:true`，等待 close 且无关闭错误后才重新打开临时文件 fsync/close。没有替换失败后先删目标的降级分支。
- `backupDownloadTarget` 严格保留已存在的普通文件。先写 `.bak.tmp`，完整复制、fsync/close 后发布为 `.bak`；任何前置失败均阻断提交。完成备份兼容既有 `/undo`，部分副本不能被选中。只有下载使用这条严格路径，未把普通编辑的旧备份行为一并标为已修；T22-10/13 仍待实施。
- 仍采用每源5/全局200备份保留策略，当前事务备份在该次裁剪中视为最新，避免时钟回拨或其它未来 mtime 导致刚创建的回滚副本被删；下载失败后的已完成备份也参与限量，不另建无界下载日志。临时文件只在确认本次独占创建后清理；清理失败报告完整剩余路径。
- 启动恢复协议：本方案没有先移走/删除旧目标的阶段，重新启动使用目标现存的完整旧版或新版；`.part-*`、`.bak.tmp` 不自动提升，也不被 `/undo` 选中；需要回到下载前版本时，使用完整备份路径或重启 REPL 后 `/undo <path>`。不按名称全局清理可能属于其它实例的临时文件，没有新增恢复锁或不可靠 PID 判断。
- 新增 `test/download-commit.js`、`npm run test:download-commit`，接入 test-all；README 说明空间要求、恢复步骤和实际边界。AST-05 同源行补记历史只覆盖下载阶段，原审阅报告作为历史保留。

### 验证与故障修正记录

| 检查 | 结果 | 范围与说明 |
|---|---|---|
| Node13 --check | index.js、test/download-commit.js、scripts/test-all.js 3/3；package.json 解析成功 | 一次。其后修正临时文件 open 归属；未单独重复语法命令，最终实际运行已加载修正后的源码。 |
| 下载专项首跑 | 前30项通过，临时文件重名场景未完成，60秒总时限 exit1 | 发现本轮关闭等待在 Node13 的真实缺口：异步 open 失败后 `_destroy` 仍等待 open，永不 close；不是把超时算成功。后续断言当次未执行。 |
| 根因检查与集中修复 | 静态读取内置 WriteStream._destroy，确认等待 open 分支；改为 fs.openSync(wx) 后将真实 fd 移交 writer | open 失败时根本不创建 writer；构造失败由当前作用域关闭 fd。避免靠短超时掩盖句柄未关闭。 |
| 用户获准专项复跑 | `runtime/node.exe test/download-commit.js`：41/41，exit0 | 仅复跑这条一次，最终源码。原函数＋真实文件/流/本地HTTP；已有目标覆盖、字节保真、writer close先于commit、新路径、rename EPERM、部分备份ENOSPC、临时/备份fsync失败、同步/流close错误、源提前close、临时重名不碰无关文件、清理失败诊断、时钟回拨下备份保留；提交前/后进程骤停及新Node进程恢复；真实CLI中文/空格路径替换与重新启动REPL /undo恢复。 |
| 既有下载场景 | Node13 runner-b.js，RUN_ONLY=ast-download：6/6，exit0 | 本批一次：连接拒绝保留旧目标、新路径逐字下载、无临时文件残留；没有追加全套循环验证。 |

专项用总时限防止 pending Promise 假阳性；独立临时安装/工作区和所属子进程，无真实模型、桌面或用户配置改写。故障发生后先查根因、修复并征得用户同意，才进行一次专项复跑；没有继续第三轮。

### 未验收与剩余风险

- 未执行全套A–J/UI、Win7实机、真实杀毒软件/文件共享占用、真实磁盘写满/只读卷、500MB上限压力、硬件断电、24/72h、发布包。EPERM/ENOSPC/close/fsync以真实文件上的受控故障注入验证，不冒称目标机实测。边界骤停使用独立Node进程在真实 rename 前/后直接 exit，不等同于断电或证明设备缓存持久性。
- 采用同目录 fs.renameSync 覆盖；若目标文件系统/占用状态不允许，明确失败并保留旧目标，不强行删除重试。文件内容 fsync 不等于 Windows 目录元数据/硬盘缓存的绝对断电保证；备份落盘也仍受文件系统和硬件可靠性影响，V22 实机恢复门槛未关闭。
- 备份完整旧文件需要额外磁盘空间和同步 IO，空间不足会拒绝覆盖；尚无统一总字节预算，沿用既有计数保留。强制退出可能留下 `.part-*`/`.bak.tmp`，它们不参与恢复；人工确认无活动实例后再处理。T22-14 多实例协调、T22-26 总量保留仍待修；不承诺跨实例并发覆盖不丢更新。
- 只有下载提交的数据保全在本批完成。下载的活动取消仍依赖 T22-06，普通编辑的编码/备份失败止损属于 T22-10，关键状态写入和损坏恢复属于 T22-13；没有将这些残留一起关闭。本批未提交、未打包、未推送。

---

## 2026-10-23 —— T22-10 第五批实施

### 前批提交与本批范围

- 按用户要求先提交第四批：`7ce82f9 fix(T22-09): preserve prior files through download commits`，提交后工作区干净，未推送。本批编码改动随后开始，尚未提交。
- 新增 `decodeUtf8Text`/`readUtf8ForWrite`：原始 Buffer 解码后重新编码必须逐字节相同，并拒绝 NUL。`read_file`/`prompt_from_file` 不再向模型提供不可逆乱码；原有前4KB NUL 的 `[BINARY]` 提示、空文件/行号/窗口契约保留。合法 UTF-8 的 U+FFFD 字符和 emoji 正常接受，不能靠“出现替换字符”误判。
- `write_file`、`append_file`、`edit_file`、`notebook_edit_tool` 对既有文件先检查编码；非法输入中的 NUL/未配对代理项拒绝。UTF-8 BOM 保留，单一 CRLF/LF/CR 风格用于输入正文及 edit 匹配；混合/无换行时保留调用方原文，未编辑部分保持原字节。notebook 显式去开头BOM再JSON解析，输出恢复BOM/换行风格。权限预览使用相同解码/换行规则。
- 将下载的严格快照函数推广并更名为 `backupExistingFile`，四个文本写入口和下载共用：完整 `.bak.tmp` 复制/fsync/close后发布 `.bak`，失败明确阻断写入；追加也加入备份。移除已无调用且吞备份错误返回 null 的旧 `backupFile`，保留现有5/200策略、路径边界和恢复格式。新建文件无旧版时正常创建。
- 补充恢复顺序：同一来源的备份 mtime 必须超过现存完整备份；时钟回拨/同毫秒写入仍可选中正确旧版，粗粒度时间戳有一次2秒步进兼容处理，仍无法排序或更新时间失败则阻断写入。不是以“备份文件存在”冒充其可用于最新回合恢复。
- 新增 `test/text-encoding.js`、`npm run test:text-encoding` 并接入test-all；下载专项仅同步共享函数名，旧保留场景修正注释，未修改既有断言。README补UTF-8契约、追加备份、恢复与限制；V22-06仅更新为部分完成，不关闭全项验收。

### 一轮最小验证

| 检查 | 结果 | 覆盖与边界 |
|---|---|---|
| Node13 --check | index.js、test/text-encoding.js、test/download-commit.js、test/runner.js、scripts/test-all.js 5/5；package.json解析成功 | 每文件一次。 |
| runtime/node.exe test/text-encoding.js | 46/46，exit0，单次 | 原函数＋真实文件：GBK/CP936、UTF16LE/BE BOM、残缺UTF8、4KB后NUL的写/追加/编辑拒绝且零修改/零备份；读/提示文件结构化错误；合法UFFFD/emoji；BOM与CRLF/LF/CR、混合换行、唯一匹配/replace_all及美元模式字面量；输入代理项/NUL；新文件、路径越界；部分备份ENOSPC、fsync/发布/恢复时间戳失败阻断；时间回拨最新版本恢复；notebook；部分写失败后完整备份恢复。真实CLI中文/空格路径中旧编码不损坏、UTF8写入保真、下载共享严格快照、重启REPL两种文件undo。 |
| Node13 runner.js，RUN_ONLY=readfmt,backup-cap | 6/6，exit0，单次 | 既有行号/二进制/空文件/EOF窗口，以及重复写每源5份且不挤掉另一文件备份。 |

所有测试只运行一次，无失败和重跑。私有安装/临时工作区、本地假模型和所属子进程；没有真实凭据、付费模型、桌面或开发仓库文件写入。未重跑下载41项全矩阵；共享函数的新调用与备份顺序在本轮原函数故障注入和真实CLI文本＋下载场景中验证，历史41/41不回写为本轮结果。

### 剩余边界

- 这是UTF-8止损方案，未引入GBK/CP936解码库或自动转换。只有字节无法作为无损UTF-8往返时才可确定拒绝；某些旧编码字节与UTF-8恰好重合、纯ASCII、无BOM且字节碰巧合法的UTF16不能仅凭字节证明其编码。声明为旧编码的工程应先显式转换副本；不承诺识别所有GBK文件。
- 普通写/追加/编辑/notebook仍用原有同步目标写入，写中断可能留下部分内容；当前保证存在完整严格备份且报错，可用 `/undo` 恢复，**未实现这些普通文本写入的原子提交或自动回滚**。专项注入部分写验证了这条剩余故障路径及手动恢复；不能把T22-10完成理解为所有文件写入已事务化。
- 未运行全套A–J/UI、Win7实机、真实CP936编辑器互操作、FAT/网络盘粗时间戳实机、杀毒/共享占用、真实磁盘写满、硬件断电或24/72h。粗时间戳兼容分支代码已检查，未单独动态模拟。一般读写仍整文件同步IO，UTF8往返及追加前完整备份增加内存/IO成本；大文件窗口与总字节预算仍属T22-15/26。
- `.env`/models/session/todos/记忆及工作日志的独立内部落盘路径没有因此整体修复，仍属T22-13等；多实例并发修改在快照/写入间仍存在竞态，T22-14未完成。编码检测、快照或恢复元数据失败时宁可明确拒写，需要现场磁盘/权限问题排查。本批未提交、未发布，旧ZIP不含本批。

---

## 2026-10-23 —— T22-11 第六批实施

### 前批提交与本批范围

- 按用户要求先提交第五批：`f2e9409 fix(T22-10): reject lossy text edits and require complete backups`；提交后工作区干净，未推送。本批模型改动随后开始，尚未提交。
- `LIGHT_MODEL`/`SUMMARY_MODEL` 仅保存显式非空设置；默认继承不再在启动时凝固。`createModelContext` 解析选定 main、默认/显式 light、默认/显式 summary，并复制/冻结对应模型（含显式 vision）的 endpoint/apiKey。默认摘要继承已解析的 light；显式辅助名称按 profile 或全局路由，不能擅自替用户更名。
- HTTP 请求读入即捕获上下文，队列等待、主模型重试、子代理及 workflow 内层、风险/审批/解释、压缩、规划/辩论、结构化输出、摘要使用同一对象。API设置/profile更新不再把在途执行拆到不同服务；后续新请求使用新配置。流式摘要和非流式后台 summaryChain 都显式捕获原上下文；响应仍回显 reqModel。
- CLI任务/Ralph、启动dream、REPL草稿及BTW/fixer/vision接线同步传递上下文；原auto_debug默认禁用保持。`/api/info` 显示动态默认 light 和 summary，模型列表纳入显式摘要。没有新增 AsyncLocalStorage 或运行时依赖，保持Node13语法。
- 新增 `test/model-routing.js` 和 npm入口，接入test-all；README/配置模板解释继承、显式配置、快照时点及热更新边界。旧VM测试补必要的上下文依赖/参数，取消源码断言扩展到含context的原有参数位置，未放宽取消检查。OP5-4同源行回记新证据，历史报告不回写。

### 验证与首跑修正

| 检查 | 结果 | 范围与边界 |
|---|---|---|
| Node13 --check | index.js、test/model-routing.js、test/stream-context.js、test/runner-b.js、test/runner-i.js、scripts/test-all.js 6/6；package.json解析成功 | 每文件一次。其后仅修专项HTTP调用/启动诊断；专项获准复跑已解析最终专项源码。最后给未运行的runner-i scheduling VM补上下文stub，仅静态检查，未另跑该场景。 |
| 路由专项首跑 | 前4项通过；健康探针8秒超时 exit1 | 测试漏向 `_shared.httpReq` 显式传 null，Buffer.byteLength(undefined) 被探针 catch 当成未就绪；当次没有实际聊天验收，不算产品失败或端到端成功。 |
| 集中修正 | GET空正文传null、API包装默认null；探针仅吞预期连接错误，采集子进程输出并检查退出 | 未重启服务“试试看”；先读helper确认参数协议并修复，再向用户申请一次专项复跑。 |
| 获准专项复跑 | `runtime/node.exe test/model-routing.js` 33/33，exit0 | 严格A/B端点各拒绝外来模型名与密钥；真实后端请求选B不改默认A、全局切B后默认轻/摘要随动、压缩/审批/计划/结构化输出、直接及workflow子代理、流式/非流式行动摘要。挂起主调用后替换设置和B的profile，原执行及摘要仍走B，下一请求默认A。显式light=A/summary=B保持独立。角色必须实际出现，不能用空every判定冒充覆盖。风险/解释/审批同一context另有源码原函数检查。 |
| 流/上下文回归 | Node13 test/stream-context.js 31/31，exit0，单次 | 受影响的压缩/主循环：坏SSE结构和提前关闭清理、失败/空摘要不覆盖原历史、全量分段、原始要求/工具配对、真实HTTP坏帧后下一请求恢复。 |

只有模型路由专项在用户明确同意后复跑一次；未进行第三轮或全套循环。fixture/安装/工作区/进程由隔离工装管理，只有本机假模型端点和假密钥；没有真实模型、凭据、桌面或开发仓库写入。之后产品代码仅注释修改，未再变更已验收的执行逻辑。

### 未验收与剩余风险

- 未运行全套A–J/UI、修改的runner-b sec3和runner-i专属场景、真实Win7/浏览器、真实模型、24/72h或发布包。CLI/Ralph/dream/BTW/辩论/fixer/vision路由接线静态复核，未逐项动态启动；双端点证据主要覆盖HTTP核心与其辅助链。不会把Node13现代宿主结果当Win7实机结论。
- LIGHT/SUMMARY显式配置仍由启动环境决定，改.env需重启；未扩展设置API去热改这两个字段。显式模型没有profile时仍使用全局endpoint/key；需要旧服务就必须配对应profile，不能从模型名推测服务。未知/停用模型正常报错，不自动偷偷切回其它模型。
- 在途任务和收到但排队的HTTP请求使用接收时路由/密钥，REPL按草稿捕获；密钥立即撤销可能令旧执行失败。快照不承诺旧服务永久可用，也不自动重试新服务。内部快照不进入HTTP payload、UI或审计。
- 活动取消/截止时间、summaryChain积压、全局权限/depth状态、子代理失败的结构化状态等仍归T22-06/16/20；本批传递模型上下文不等于完整ExecutionContext或全局并行隔离。设置/.env/models可靠落盘仍属T22-13。未推送、未打包；本批未提交。

---

## 2026-10-23 —— T22-12 第七批实施

### 前批提交与本批范围

- 按用户要求先提交第六批：`c86614b fix(T22-11): inherit selected models and freeze execution routes`；提交后工作区干净，未推送。本批随后开始，尚未提交。
- MCP为stdin异步error/写回调、stdout/stderr错误、stdout end/close及child error/exit/close安装统一处理。`die`幂等：拒绝并清空全部pending/timer、清初始化/工具缓存、只删除仍指向本对象的缓存项、关闭本端stdin并尝试kill直属child。dispose直接退役并结算，不再仅删缓存等长超时；旧child迟到事件不影响新对象。
- 收尾阅读实际Node13内置`internal/child_process`源码发现，EMFILE/ENFILE会在创建stdio前返回并在nextTick发error。MCP/shell现先绑定child错误和退出监听，再读取管道；缺stdio时返回已失败对象、不进入缓存，保留监听接住迟到错误。新增两条对应回归；尚未通过耗尽真实OS句柄复现。
- MCP发送JSON前限制4MB UTF-8帧，超大请求标记not sent；接收端限制完整行及未换行残留，避免一直等换行积累内存。非对象/null/数组帧忽略，保留噪声行兼容；server request要求字符串method，error.message非字符串安全序列化，避免JSON有效但对象形状异常逃出data回调。保留握手/缓存/工具isError契约。
- MCP超时退役整条会话并结算其它在途请求，后续调用可惰性创建新client；已发送操作明确 `result unknown` 并要求检查副作用，不自动重放失败调用。直属child kill不是远端事务撤销或进程树停止的证明。
- 持久shell改为单活动命令，忙时明确not sent；stdout/stderr在采集处合计8MB，空闲输出不保留。固定事件监听，数据驱动识别跨chunk marker，保留300ms尾随输出窗口；结束即清timeout/尾随timer，不再轮询全量字符串。提前退出/EOF/管道错/dispose立即结算，超时code124，超限退役；都明确未知结果和下次新会话，不能宣称已经“重启完成”。无末尾换行输出通过printf前置换行分隔，返回值移除marker。
- 新增 `test/pipe-lifecycle.js` 和npm入口，接入test-all。既有pshell超时断言从“已restarted”改为未知结果/下次启动的真实契约，未改其它断言。README补限额、结算及停止边界。T22-15/V22-03仅标局部进展，不关闭整个资源/取消验收。

### 最小验证及获准追加复跑

| 检查 | 结果 | 范围与边界 |
|---|---|---|
| Node13 --check | index.js、test/pipe-lifecycle.js、test/runner-b.js、scripts/test-all.js 4/4；package.json解析成功 | 每文件一次，在追加缺stdio防护前；最终源码由获准复跑实际加载解析，未重复语法检查。 |
| runtime/node.exe test/pipe-lifecycle.js | 首跑28/28；追加边界后获准仅复跑一次30/30；两次均exit0、SKIP0 | 原函数＋真实Writable/PassThrough异步EPIPE注入：MCP全部pending结算/清空、stdout/stderr故障、幂等dispose、超时与迟到响应、新旧缓存身份；噪声/null/异常method/error对象、UTF8分帧/字节限额、超大出站不发；shell忙拒绝/marker分片/非零码/监听不增长、提前退出/EOF/EPIPE/超限/超时/dispose及新会话恢复。所属真实Node MCP握手/UTF8工具调用/重连；真实Git Bash cwd/env、无换行、非零码、exit后立即结算及新会话重置。最终增加MCP/shell缺stdio＋nextTick EMFILE注入两项，验证无未处理错误、不缓存失败对象。 |
| Node13 runner-b.js，RUN_ONLY=mcp-stdio | 8/8，exit0，单次，未复跑 | 在追加缺stdio防护前通过：真实CLI本地模型＋MCP发现、echo/add/isError、未知server、握手顺序、list缓存及准确call计数。最终防护后的正常握手/重连由新专项覆盖，不能将旧8项计为最终版本重新验收。 |

没有测试失败。首跑后静态检查发现上述Node13边界，用户明确允许“仅重跑这条专项一次”，据此完成30/30复跑；既有MCP8项未重跑。专项全部子进程有明确本次归属：MCP经工装启动，真实bash仅执行内建命令并带唯一rcfile参数登记PID/身份，finally收尾；原生bash清除测试继承的BASH_ENV/ENV/CDPATH、导入函数/选项，避免加载开发机脚本。MCP fixture日志显式指向临时工作区。无真实模型、桌面或用户配置写入。

### 剩余边界

- EPIPE是原函数绑定到真实Node Writable后的异步注入，不冒称真实Win7 OS管道已复现；真实子进程部分验证正常协议/重连和bash退出。未运行Win7实机、原生EPIPE/句柄故障、全套A–J/UI、既有完整pshell场景、24/72h、打包。pshell变更断言经静态复核，新专项提供实际bash恢复证据，旧pshell整组不能计本轮通过。
- 本批仅尽力停止直属child，不保证cmd/MCP server/bash的后代、远端服务或已完成副作用被撤销；后代持有读管道、直属child未确认close、孤儿及强杀后重启仍由T22-07处理。失败后模型若决定重试，需依据工具返回的未知结果检查实际状态，transport本身不重放。
- 4MB帧和8MB单命令限额是有意的可靠性约束，正常大响应也会拒绝，需要工具端分块/更小查询。MCP多pending总量、stdin待发积压、stderr日志、后台/调试采集及大文件读取仍未整体有界，T22-15/26保留；不能把这次改动当全进程内存上限。
- shell仍非TTY，交互程序/并发后台输出与主命令的归属无法严格分开；完成marker后300ms窗口保留原宽限语义，不提供后台流式终端。HTTP会话shell身份隔离仍属T22-17，活动模型/工具取消属T22-06，未在本批关闭。MCP启动解析/.cmd历史撤回结论不重开。本批未提交、未发布、未推送。

---

## 2026-10-23 —— T22-13 第八批实施

### 前批提交与本批范围

- 按用户要求先提交第七批：`95aed08 fix(T22-12): settle failed MCP and persistent shell sessions`；提交后工作区干净，未推送。本批随后实施T22-13，当前尚未提交。
- 统一状态提交函数：独占同目录临时文件（随机后缀、创建权限0600），完整写入、fsync、close后rename；保留`<file>.7coder-prev`完整旧版。旧版提交失败阻断新版本，目标不先unlink；相同内容不轮换上一不同版本。恢复也走同一替换协议，不把损坏主文件覆盖到有效旧版。
- 覆盖todos、CLI当前/历史session、Web session、工作区models/`.env`、memory、7CODER.md/TODO.md/BTW.md及若干账目/摘要写入；受管JSON/记忆/工作日志经普通write/append/edit工具修改时亦走格式检查及替换，保留原权限/路径/严格用户文件快照。其它源码/用户文本文件仍保留第五批的严格备份＋普通写入，不把它们宣称为原子提交。
- 读取JSON时支持UTF-8 BOM，校验todos条目、session消息与model profile的基本结构；文本要求无损UTF-8。无法解码/解析/结构无效时先按内容哈希保全原始字节并告警；同一损坏字节不重复生成副本。有有效previous则恢复，否则明确失败。两个版本都坏、证据保全失败、权限错误均不能静默初始化为空后覆盖。
- GET todos在不可恢复时返回500，避免同步异常逃出路由；会话保存/历史副本和TODO镜像失败均可见。`.env`编码或model profiles不可恢复时启动非零失败、不报告ready；模型配置全层加载成功才换内存映射；设置保留先成功落盘再更新全局的顺序。dotenv8写入做值往返核对，支持带空白/字面引号的设置值，未知内容/注释保留。
- session/memory显式删除及CLI历史裁剪同步删除previous，防止下次读取自动复活；损坏证据保留。凭据及用户protected_extra的伴随文件继承原路径保护；内置Git stage_all排除`.7coder`及所有`*.7coder-*`，仓库忽略规则同步增加。任意外部Git命令不受内置工具约束，其工作区需自行配置忽略。
- 新增`test/state-store.js`、npm入口并接入test-all；README说明恢复规则、人工清理与实际边界。GAP-6历史“损坏自动重建”口径已在原表更正，GAP-9/D4同源关系已补记；T22-14/19/26及Win7发布验收未关闭。

### 一轮最小验证

| 检查 | 结果 | 范围与边界 |
|---|---|---|
| Node13 --check | index.js、test/state-store.js、scripts/test-all.js 3/3；package.json解析成功 | 各一次；未反复检查。 |
| runtime/node.exe test/state-store.js | 59/59，exit0，单次，SKIP0 | 原函数＋真实临时文件：BOM/中文/空格/emoji、上一版本/相同内容、首次写、非法新JSON阻断；primary/previous的打开/部分写/flush/close/rename故障注入，保留原件、无目标unlink、无不完整提交。JSON/schema/两份损坏/证据保存失败/权限失败/缺主文件恢复、显式删除、真实外指junction拒绝。记忆旧编码恢复、工作日志读失败止损、原CLI save/load、凭据伴随文件保护、dotenv8值往返、通用文件工具受管JSON写入、真实Git排除。 |
| 同一专项中的进程边界与后端验收 | 包含在上述59项内，不重复计数 | 三个所属Node子进程分别在previous提交后、primary提交前/后直接process.exit(73)，新上下文读取完整已提交版本；实际HTTP验证todos500后服务仍活、恢复、设置失败不更新磁盘/内存、模型配置失败不换映射、Web session覆盖/恢复/删除；新后端启动前恢复models及非UTF8 `.env`；无恢复版的models非零退出且不泄露JSON密钥片段；实际`--resume`恢复后`/bye`退出。 |

没有测试失败或复跑。所有工作区/配置/模型密钥均为隔离临时fixture，使用本地HTTP后端、未调用真实模型；子进程经现有工装登记或同步有界执行并收尾。最后仅静态检查差异和记录，不再跑其它专项。

### 剩余边界与发布口径

- 本批在现代Windows宿主上的随包Node13验证，**未运行Win7实机**、真实磁盘耗尽/只读/共享占用/杀毒阻塞、物理或虚拟机断电、网络盘断连、双实例竞争、24/72h、打包或全套A–J/UI；旧todos/session/memory/settings等专项未复跑。受控errno注入不等同OS实况，process.exit提交边界也不等同taskkill/断电。
- 同卷rename＋文件fsync不保证目录项/硬件掉电的持久性，Windows拒绝替换时明确报错并保留现有文件，不降级为先删目标。跨实例读改写仍可丢更新（T22-14）；多个文件之间不构成一个事务，例如结构化todos已保存而TODO镜像失败会告警，账本以todos为准。
- JSON只校验约定结构，无法识别“可解析且结构合法、但字段/内容已被外部截掉”的所有情况；Markdown/`.env`保留既有文本/dotenv8语义，不能通过UTF-8有效性判定其全部业务含义或任意文本损坏。有效旧版也可能不含最近一次任务，这就是回退语义。初次创建前没有历史可凭空恢复。
- 每个主文件仅保留一个previous，正常同内容保存不淘汰上一不同版本。不同损坏证据、骤停临时文件保留供排查，未自动裁剪；不能直接扫目录删除，需排除活动实例。此前原件单独手动删除会触发恢复，应使用产品删除动作或在停机后处理主/previous两份。磁盘预算和保留仍属T22-26。
- 状态写入及日志追加变为全文件替换，存在按文件大小增长的同步IO成本；日志长大后的限额、调度和会话保存最新快照仍属T22-15/19/26。审计JSONL追加/轮转、进程锁原子获取/所有权、普通用户文件事务及任意外部命令的写入不在本批统一协议保证内。本批未提交、未发布、未推送。

---

## 2026-10-23 —— T22-14 第九批实施

### 前批提交推送与本批范围

- 按用户要求提交第八批：`e862a03 fix(T22-13): preserve and recover durable agent state`；随后`git push origin main`成功，远端由`6a1e325`推进至`e862a03`，此前数批提交也已一并推送。本批随后开始，当前尚未提交或推送。
- 策略为同机同一真实工作区只允许一个Agent进程。Windows使用工作区realpath归一化/小写后的SHA256命名管道；随包Node13.14/libuv1.37的`uv_pipe_bind`以FIRST_PIPE_INSTANCE创建首实例，第二个bind由OS拒绝，依据[对应运行时源码](https://raw.githubusercontent.com/libuv/libuv/v1.37.0/src/win/pipe.c)。不使用持久锁/PID文件、时间过期抢锁或按PID杀进程；进程结束后OS释放句柄，因此不存在本协议遗留的磁盘锁。非Windows使用确定性loopback TCP独占，端口碰撞拒绝启动，不冒充完整跨平台实测。
- 配置读取本身可能恢复写盘，所以将原初始化放入`initializeAgent`，先await取得OS独占，再执行`.env`/models读取恢复、模块级状态初始化、迁移及main。保留`--help`提前退出。顶层异常非零退出，等待输出时仍持锁至进程结束，不能在旧异步任务仍可能写盘时先释放给新进程。
- 冲突通过带challenge的本地探针核对工作区key、PID、随机48位hex运行身份、起始时间，仅提供诊断；未知/无响应/权限拒绝一律失败，不把服务没响应等同进程已死。监听最多8连接、每连接4096字节帧及1秒空闲超时；监听及连接unref，不阻止CLI自然退出。持锁后的意外error请求非零终止，不能静默继续工作。正常并发浏览器仍通过同一HTTP进程服务，第二个CLI或不同端口Agent不再共享写入同一工作区。
- 后台启动父进程持锁创建日志/拉起子进程，显式关闭本端lease后不再操作工作区；子进程凭内部IPC/父运行身份可有限等待交接，但仍须成功bind取得新独占。父进程在15秒内确认子进程PID/key/新运行身份及同步配置初始化成功后才报告accepted，输出日志位置；这不代表模型任务成功。父日志fd在spawn后关闭、spawn/error/早退有明确失败，后台分支显式return，避免flushExit等待期间父进程继续执行同一任务。进程树清理仍属T22-07。
- 不同工作区共享安装目录时，安装级`.env`/models损坏回退改为只读使用有效previous并告警，原损坏字节留在原处，不互相覆盖安装文件或创建恢复副本；无有效previous仍失败。工作区自己的状态仍用第八批恢复/保全协议。
- 新增`test/workspace-lease.js`、npm入口并接入test-all。既有B27 todos-api从同时开CLI＋HTTP改为由持锁HTTP进程执行原工具序列，原3条断言保留且首条要求聊天请求成功；未删弱化工具结果/状态断言。README说明行为变化、后台acceptance、共享配置及部署边界。

### 最小验证及获准复跑

| 检查 | 结果 | 范围与边界 |
|---|---|---|
| Node13 --check | index.js、test/workspace-lease.js、test/runner-b.js、scripts/test-all.js 4/4；package.json解析成功 | 各一次，在夹具关闭修正前；最终夹具由获准复跑加载解析，未重复语法检查。 |
| 专项首跑 | 前19项通过后60秒deadline exit1；后续项未执行 | 未知服务夹具只end输出、不消费输入/关闭全部接收连接，Node13管道server.close等待未释放连接；本次进程清单中未进入冻结实例夹具。只记录已通过19项，不能算专项通过。修夹具为消费输入并在finally销毁所属连接/有界关闭，补deadline诊断；冻结夹具改在IPC通知写完成后才阻塞事件循环，避免通知本身被堵。 |
| 用户明确允许仅复跑一次：runtime/node.exe test/workspace-lease.js | 25/25，exit0，SKIP0；其余专项未复跑 | 原互斥函数＋真实OS监听：challenge/运行身份、大小写/点路径/真实junction同key、非法/超大/空闲探针后仍可诊断、显式释放及新token、持锁error处理和EMFILE注入。真实双CLI拒绝与下一次写入保留两条todo/独立ID；不同HTTP端口/路径别名拒绝，且拒绝发生在损坏配置恢复前；独立工作区并行，持锁HTTP仍能执行todo。真实直属Agent强终止/重启、/bye/重启、未知owner不抢占、冻结owner不误判陈旧、实际后台父子交接/运行/结束后重启，以及两个工作区共享安装配置只读回退。 |

所有Agent/模型/配置/工作区均为本次私有临时fixture，仅访问本地模型夹具；真实冻结进程只执行有界忙循环并由其所属child句柄终止。后台仅运行无工具的一次性假模型任务，完成后确认其OS独占释放并实际重新启动；记录PID＋私有入口身份供中断诊断。首跑退出后只读核对未见本次残留Node进程。没有运行真实模型或改动真实安装配置。

### 剩余边界与发布口径

- **未运行**：Win7实机、不同Windows账户/提权/终端会话、真实Ctrl+C/关窗口/注销/关机/断电、三层进程树/旧子进程持有文件/端口、多周运行、最终ZIP或全套A–J/UI。旧B27原场景仅改代码并做语法/静态复核，其行为由新专项的持锁HTTP todo路径提供局部证据，不能计旧场景本轮通过；第八批59项亦未重复执行。
- 这是同机、合作进程、相同真实根目录的准入机制，不是跨主机网络盘锁，也不阻止旧版Agent、任意外部程序、cron/命令后代继续写文件；父进程已死不代表后代都死。重叠父子工作区、网络/DFS别名与同一共享目录跨机器访问不在保证内，应避免并发操作其重叠数据。T22-06/07/25仍未关闭。
- 遇到无响应owner或权限/命名端点冲突，程序拒绝启动而不是自动抢占；可恢复性以真正结束旧实例后重新启动为准。正常冲突也不自动排队重试；请用现有HTTP进程，或结束它后再启动CLI。运行身份用于核对诊断/交接，不是公网认证协议，不传输模型密钥。
- 后台父释放到子取得独占之间允许其它启动者先取得；子/父将明确报告交接失败，不强抢其它实例。这保证互斥，不能保证交接一定胜出。accepted只代表持锁＋同步初始化，dream就绪阻塞、模型可用性及后代停止仍按T22-22/07处理。安装级损坏原件/旧版保持不动，需在确认无使用者后人工修复。
- 本批未改变工具取消、HTTP对话shell身份、保存队列/字节预算和日志保留策略；非Windows loopback端口碰撞/运行分支尚未实测。V22-05/06仅补本地所有权与先后写入证据，仍为部分完成。本批源码已实施，未提交、未推送、未发布。

---

## 2026-10-24 —— T22-20 清扫批 / OPT-13 第七批（主会话自做：14 工具一次过）

- **范围**：write_file/append_file/edit_file/notebook_edit_tool/download_tool/brief_tool/sleep_tool/snip_tool/tool_search_tool/cron_list_tool/git_commit_tool/auto_approval_return/ask_user_question_tool/web_search_tool，共 14 个。两个红点：①`auto_approval_return` 把模型描述**原样透传**——描述以 `[ERROR]` 开头时成功的交接被推断为失败；②`git_commit_tool` 的 `Not a git repository.`（**写意图失败**）不在 RE、被推断 ok。其余为兼容锁（含 append 到错误样文件名的绿锁、7CODER.md 专文、download 本地假 HTTP 成功路径、brief 缺失目录=0 文件摘要照样写的真实行为、web_search 坏 provider）。语义决定：git_commit 的 `nothing to commit` 保持 ok（幂等 no-op）；ask_user 的跳过/不可达全 ok（有意行为）。OPT-13 累计 **47/53**。
- **测试基建适配**：download-commit/state-store 两个 T22 专项用 vm 抽取 download/写入分支——沙箱缺 `makeToolResult` 报 ReferenceError、断言在裸字符串上。修法：loadContext 补 `{status,text}` 桩（state-store 原有）、6+1 处断言改 `.text`（先定向跑两专项 41/41、59/59 确认再全量）。b7 场景 statusOf 用 b3 的前缀键匹配（snip 输出整段系统提示 JSON 超 SSE 12000 截断）。
- **门禁**：红恰 2+1；绿：node --check、runner-b **354/354**、runner-i 51/50+1 跳过、runner(A) 88/88、**test-all 20 目标全绿**（含适配后的两个专项）、**Node 13 复验 B 354/354、I 51/51、A 88/88**。web_search 成功路径需外网，离线不可测（代码审查）；notebook/brief 的 catch 活体已覆盖（ENOENT 路径）。
- **剩余 6 工具**（末批）：mcp_tool/mcp_list_tools_tool（含 external 路径缺口待查证）、web_browser_tool、plan_mode、auto_debug_tool、bickering_tool。

---

## 2026-10-24 —— T22-20 命令族 / OPT-13 第六批（主会话自做：aborted→cancelled + stderr 保留）

- **范围**：run_command/bash_tool/powershell_tool 三工具。①`[aborted: client disconnected]`（四处，含 bash persistent）此前不在 TO_FAIL_RE——**被取消的命令被推断为 ok**，现显式 cancelled（workflow 对 cancelled 本就按失败停止，语义接通）；②**成功命令保留 stderr**（T22-20 条目）：`Command OK:\n${stdout}` 此前完全丢弃 stderr（编译警告/弃用提示消失），现非空时追加 `\n[STDERR]\n${stderr}`（唯一的有意文本变更，既有断言均为 includes 不受影响）；③`bash not found…`（两处）与非 Windows 的 `powershell_tool is Windows-only…` 前缀缺口补 error。OPT-13 累计 **33/53**。
- **红测试**：aborted 路径无法经活体断连确定性驱动——命令分支 vm 源码抽取 + 桩 runner（同 b5 runSubAgent 模式）覆盖 cancelled×4、bash 缺失×2、非 Windows powershell、stderr 尾巴、干净成功无尾巴、失败/常驻 shell 兼容；活体半场经真实 server 管线验证 stderr 双流保留（`console.log`+`console.error` 同命令）与失败/常驻/PowerShell 兼容。
- **门禁**：红恰 5+1（runner-b 5 条指定标签 + runner-i 1 条注册断言；2 条兼容记录本就绿）；绿：node --check、runner-b **348/348**、runner-i 50/50（input-escape 既有门槛跳过）、runner(A) 88/88、**test-all 20 目标全绿**；**Node 13.14.0 复验 B 348/348、I 50/50、A 88/88**。
- bash-missing/非 Windows powershell 的活体红不可构造（本机有 bash 且为 Windows），由 vm 单元锁定（桩 findBash→null / platform→linux，比代码审查更强）。

---

## 2026-10-24 —— T22-20 首片 / OPT-13 第五批（主会话自做：agent 返工 + web/gap 工具）

- **范围**：agent_tool 返工（第四批把 runSubAgent 整体包成 ok 是错误终态——子代理失败被显式标成 ok；改为 runSubAgent 自身返回结构化：`Sub-agent "x" failed:` 与嵌套拒绝 → error、成功 → ok，agent_tool 直接透传）＋ web_fetch_tool（`Fetch error:` 缺口修复；抓取页面内容透传显式 ok，正文以 `[ERROR]` 开头不再误判）＋ synthetic_output_tool（`Synthetic output error:` 两处缺口）＋ enter_worktree_tool（`Worktree error:` 缺口，10-20 主动留下的）＋ computer_use 截图路径（`Screenshot failed` 两处）＋ schedule_cron_tool/cron_create_tool（`[ERROR] Unsupported schedule` 前缀映射）。OPT-13 累计 **30/53**。
- **红测试设计**：runSubAgent 失败无法经 mock 活体构造（脚本耗尽后重复末条，子代理永远拿到合法回复）——用源码抽取 + 桩 processWithTools 做 vm 单元（fail/nested/ok 三态）；活体半场经真实 server 管线覆盖 fetch 死链/活体（本地假 HTTP 服务器返回 `[ERROR]` 开头正文）、synthetic 坏 schema、agent 成功往返与空 task 校验。
- **门禁**：红恰 4+1（runner-b 4 条指定标签 + runner-i 1 条注册断言）；绿：node --check、runner-b **341/341**、runner-i 49/49（input-escape 为既有 DESKTOP_TEST=1 门槛跳过）、runner(A) 88/88、**test-all 20 目标全绿**（含 d/e/h 适配后）；**Node 13.14.0 复验 B 341/341、I 49/49、A 88/88**。
- computer_use 输入路径（`[WARN]`/`[OK]`/`Input error:`）经推断分类全部正确（Input error 在 RE 内），未额外包装；Worktree 活体红测试仍不安全（git 对怪名照建 worktree），由代码审查确认。
- T22-20 剩余：MCP external 前缀缺口、成功命令保留 stderr/exitCode、余下工具迁移（写入/命令族含 `[aborted:]`→cancelled 语义设计）。

---

## 2026-10-24 —— 全套回归发现的第九批尾巴（dream 产品 bug + 五处测试适配）

第九批记录已如实注明"全套 A–J/UI 未运行"。本轮（2026-10-24，主会话自跑 OPT-13/T22-20 首片的红门禁）全套 runner-b 首跑暴露 4 条与其无关的失败；`git stash` 后在干净 HEAD（5fb6d38）上定向复跑归因确认均为既有问题。探针（.cache/probe-b9regress.js，复用 _shared 隔离安装）实证三条根因：

- **dream 产品 bug（T22-11 回归，已修）**：`triggerDreamIfNeeded(modelContext)` 调 `runDreamSession()` 未传参，而后者体内 `processWithTools(dreamMessages, { modelContext })` 引用了不存在的标识符 → ReferenceError，**每次 6 小时空闲触发的 dream 整合都静默失败**（A2-08 兜底保全了 7CODER.md 原文，故未丢数据）。探针实证 `[DREAM] consolidation failed - original 7CODER.md preserved: modelContext is not defined`，且 dream 未发出任何模型请求。修复：参数穿透 `runDreamSession(modelContext)`。dream 场景 5 记录修复前红（本节与定向运行日志为证）、修复后绿。
- **ast04 测试适配（T22-13 语义，非产品缺陷）**：手写种子 `'{"keep":true}'` 被 T22-13 严格状态校验判为语义无效（parseModelState 要求 profile 值为对象）→ CLI 拒绝启动（原字节保全为 `.7coder-corrupt-*` 副本）。种子改 `'{"keep":{}}'`，断言保持"bypass 写 models.json 被 BLOCKED 且原文件不动"。
- **state guard backups 测试适配（T22-10/13 有意语义，非产品缺陷）**：junction 备份根指向工作区外时，旧行为=写入成功、备份跳过；T22-10/13 改为"既有文件写入必须完整备份、备份失败即阻断"——探针实证返回 `Write error: Security: internal state root resolves outside workspace`、app.txt 原文不动、外部不泄漏。断言改为 fail-closed 语义（写入被拒 + 无泄漏）。
- 勘误：T22-14 行提交号 b63bbdc → 5fb6d38（amend 改变哈希所致）。

定向复跑 dream/ast04/state-path-guards：**11/11 通过**。

后续完整 test-all 又暴露 d/e/h 三套件 5 条失败，同样 stash 归因为既有问题（探针 probe-fuzz.js / probe-mdcorrupt.js）：

- **fuzz 测试适配（T22-01 语义，非产品缺陷）**：fuzz 转录在第 45 个调用左右越过 120k 压缩阈值，摘要请求打到 mock 拿到脚本中的 tool_call 条目（content null）→ T22-01 的 fail-closed 守卫（`empty context summary`→任务中止，历史保全）正确触发。fuzz 意图是测 60 个畸形工具调用存活，与压缩阈值解耦：场景内 `CONTEXT_CHARS: '5000000'`。压缩对 mock 的行为由其它场景覆盖。
- **md-corrupt 测试适配（T22-13 有意语义，非产品缺陷）**：含 NUL 的 7CODER.md 且无有效旧版，新契约为任务正常完成、摘要拒绝追加并显式告警（`summary not written: Invalid state has no valid previous version`）、损坏字节原样保全待人工修复；旧断言（损坏文旁照样追加 auto-log）改为断言新契约（字节不变 + code 0 + 告警出现 + .env.local 保护不变）。
- **runner-h 静态两项（第九/八批尾巴，小修）**：`_7CODER_LEASE_HANDOFF` 为父→子内部交接变量（spawn 时注入、启动即消费并删除），不应进 .env.example——runner-h 检查加 `internalIpcAllow` 豁免表；index.js 日志文案 "[WARN] TODO log save failed" 的 `TODO` 撞标记检查（e862a03 引入），改小写 "todo log"。
- 检查确认 computer_use 输入类路径（`[WARN]`/`[OK]`/`Input error:`）推断分类全部正确，无新误判面。

---

## 2026-10-24 —— GLM改动独立复核与进度修正

本节复核范围为`5fb6d38..b7f16e2`的4个提交、9个文件，以及相关调用链；不以Git作者字段判断模型归属。T22-14主体是此前实施的工作，本轮不将其算作GLM新增实现。产品源码未改，本次仅修正文档。未发现本范围内新增、已确认的Critical/High问题；这不关闭既有发布门槛。

### 独立复核时的进度与口径（后续关闭情况见本日收尾记录）

- **OPT-13/T22-20仍为🔶**：已登记47/53工具名，未登记6个为`mcp_tool`、`mcp_list_tools_tool`、`web_browser_tool`、`plan_mode`、`auto_debug_tool`、`bickering_tool`。T22-20原33/53、剩20及归并表24/53已更新；各历史批次的当时计数保留。
- **计数边界**：47/53是`STRUCTURED_RESULT_TOOLS`登记数，不是所有返回分支的完成率。`computer_use`截图分支已显式结构化，输入及未知action仍返回字符串（`index.js:3429`及相邻分支），经`normalizeToolResult`按文本推断（`index.js:4235`）。这是迁移残留，不能仅凭登记或注册断言关闭。
- **命令结果尚未包含结构化exitCode**：`run_command`、`bash_tool`、`powershell_tool`成功分支分别在`index.js:2675/2706/2722`调用`makeToolResult('ok', okText)`，没有传第三参data。stderr保留已完成，不能据此认为原stderr/exitCode要求全部满足；exitCode继续列入T22-20。属原需求未完成，不认定为本轮新增回归。
- **历史门禁计数待核对**：第七批原记录`runner-i 51/50+1跳过`口径有歧义，后文另记Node13复验`I 51/51`。保留原始记录，不推算替换为新的通过数；需原运行日志区分通过断言数与跳过场景数，`input-escape`仍要求`DESKTOP_TEST=1`。这些历史结果本次未独立重跑，不作为桌面输入已验收的证据。
- **dream勘误**：`169c0b3`补传`modelContext`的修复有效；旧文“6小时空闲触发”应按`index.js:2130`的`hoursSince < 5`更正为5小时门槛。锁、ready阻塞等其它生命周期缺口仍属T22-22。

### 待修：子代理取消仍被记录为成功

| 状态 | ID／归属 | 严重程度／证据 | 触发、后果与完成条件 |
|---|---|---|---|
| ✅ | INC-24-01／T22-20，联动T22-06 | Medium／已确认；既有缺口，非GLM新增回归 | 复核基线`runSubAgent`（`index.js:663`）等待`processWithTools`后无条件返回ok（`:683–685`）；后者取消时返回普通字符串，不抛异常，探针确认status为ok。本日收尾已在启动前、返回后及catch中检查取消令牌并传递cancelled，finally恢复状态；不匹配模型正文猜取消。新增回归使用真实processWithTools边界验证取消、迟到成功/异常、状态恢复和错误样正文透传，14/14；连同既有首片/命令族共27/27、单次。尚未提交。未据此宣称活动上游中止或零迟到副作用已完成，仍归T22-06。 |

第五批“agent失败不再被包成ok”仅对抛异常与嵌套拒绝成立，不覆盖取消。`test/runner-b.js:3130–3135`现有VM测试覆盖异常/嵌套/成功，未覆盖上述取消返回路径。

### 测试证据与发布判断

- **测试证据缺口归T22-33**：第七批`statusOf`按结果前缀关联SSE、audit用工具名/状态存在性匹配；当前夹具未证实误匹配，但不能替代按调用ID逐次核验。`runner-i`注册断言也不能证明工具全部分支都返回权威状态；本次不把这两点列为新增已确认Bug。
- **本轮实际验证**：上一轮独立复核已单次完成`git diff 5fb6d38..HEAD --check`及Node13纯内存源码探针，得到登记47/53、剩余6个工具名和子代理取消仍ok；探针未启动Agent、未调用模型或命令工具、未写工作区。本次文档修正仅核对源码/引用及文档差异，不重复运行探针或业务测试。
- **未独立运行**：GLM记录的A/B/I及test-all、真实模型、桌面输入、Win7实机、24/72小时长期运行与打包验收。历史绿测保留为原实施记录，不升级为本轮复现证据。
- **发布风险不变**：T22-06贯穿取消、T22-07进程树及T22-03离线运行基线等仍开放，Win7及长期运行尚未验收，不能据47/53或本轮未发现新增High判断可直接发布。

---

## 2026-10-24 —— T22-20 状态收尾：子代理取消与命令退出码

### 实施范围

- `runSubAgent`在启动前、`processWithTools`返回后及异常结算时检查取消令牌，取消统一返回`cancelled`；保留嵌套拒绝/普通异常为`error`，正常完成为`ok`。已经取消时不启动子代理；进入执行后仍用finally恢复depth和权限覆盖。模型正文即使恰为`[aborted: client disconnected]`，未取消时仍是正常成功内容。
- `runCommandAsync`在回调中记录退出码；`run_command`、`bash_tool`、`powershell_tool`通过`ToolResult.data.exitCode`传递：确认的正常退出为0，确认的非零退出为整数；取消、spawn失败、同步启动异常、buffer错误、超时/信号终止均为null。持久shell仅采信命令完成marker的非负整数；退役/超时合成124与内部-1为null，正常marker返回的124仍保留124。文本输出及stderr保留规则未变，data沿既有契约仅供内部消费。
- 复用B套件新增`tool-results-followup`，原命令族VM夹具补齐runner新字段，未删减原断言；不增加生产依赖或新运行时要求。OPT-13仍是47/53工具名、T22-20仍为部分完成，INC-24-01关闭。

### 本批验证（均单次）

| 检查 | 结果 | 证据范围 |
|---|---|---|
| Node13语法检查index.js、test/runner-b.js | 2/2，exit0 | 使用随包runtime/node.exe，不代表Win7系统能力验收。 |
| Node13 B定向：tool-results-followup、tool-results-b5、tool-results-b6 | **27/27，0场景跳过，exit0** | 新增14项：真实processWithTools取消边界、启动前取消、迟到成功/异常、状态恢复、取消样正文透传；runner故障回调与三命令族状态/exitCode；持久shell真实marker/合成码区分；真实短命Node子进程退出0/7、缺失可执行文件。既有首片6项＋命令族7项含隔离HTTP/SSE/audit与活体命令兼容。 |
| 差异检查与静态复核 | 通过 | 核对共同runner其它调用方仍按原error/stdout/stderr消费，新exitCode为新增字段；未运行第二轮行为测试。 |

### 边界与剩余风险

- 新增故障时序主要采用源码原函数＋受控模型/进程回调；真实子进程只覆盖退出0/7及缺失文件，不把它们等同于Win7原生超时、管道错误或强杀验收。既有SSE/audit测试保留原关联方式，按调用ID严格逐次核验仍属T22-33。
- 未运行完整A–J/UI/test-all、真实模型、Win7实机、24/72小时长期运行、打包验收。本批没有主动中断所有上游/审批/工具，也没有实现进程树停止；T22-06/07及其它发布门槛继续开放。
- 本批尚未提交、未推送、未打包。后续优先T22-06贯穿取消与截止时间，再处理T22-07进程树所有权；不因本次终态修复关闭完整取消链路。

---

## 2026-10-24 —— T22-06 首批：模型、审批与执行前取消

### 已实施范围

- HTTP聊天（流/非流）与CLI任务创建独立执行控制，主/轻/摘要/子代理及工具模型面复用同一取消令牌和截止时间；主循环在压缩后、模型返回后、强制最终回答前后检查取消。`EXECUTION_TIMEOUT_MS`默认1800000毫秒，限制1000–86400000毫秒；HTTP从完整请求体进入处理时计时，CLI从executeTask开始计时，含排队/重试/审批/摘要，不是每次模型调用重置。
- `callOpenAI`通过`executionHttp`使用当前Axios的CancelToken，覆盖等待响应头、JSON正文和SSE解析全程；取消后不进入重试，退避等待可中断。通过该入口的风险分类、说明、自动审批、压缩、synthetic/plan/bickering模型调用均传递令牌；压缩和任务摘要不将取消吞为成功或fallback，不提交取消后的摘要。
- HTTP正常结束与异常断开区分；断连/写失败取消当前执行，流/非流路径均适用。待审批由独立bridge管理，审批回复/超时/取消统一一次结算并移除登记及timer，迟到审批无有效ID；工具入口及人工/自动批准返回后检查取消。保留执行门，等待实际调用结算后才释放，不用只让外层Promise提前结束的方式放行下一任务。
- 正常流式响应结束仍允许摘要使用剩余时限；非流式后台摘要保留原请求的绝对截止时间，排队过期时不再调用模型或写日志。现有summaryChain的无界排队与流式摘要占门仍属T22-16，未把增加截止时间视为有界队列完成。
- 控制器、观察订阅、退避timer、审批timer在结算或finally释放；兼容旧函数式令牌时仅在活动等待中轮询100ms，不依赖Node13不存在的AbortController。未新增生产依赖。

### 本批验证（均单次）

| 检查 | 结果 | 实际证据 |
|---|---|---|
| Node13语法：index.js、test/execution-cancel.js、scripts/test-all.js | 3/3，exit0 | 随包runtime/node.exe。 |
| 新增test/execution-cancel.js | **20/20，exit0，无跳过** | 原控制/请求/审批/权限/压缩函数＋真实Axios连接本地HTTP夹具；流/非流请求等头、SSE正文等待时主动关闭且不重试、退避中断、时限、4类辅助调用取消不fallback、压缩原数组保全、审批登记即时清理/迟到回复、执行前零启动、timer释放；真实隔离Agent断连后下一请求恢复、旧审批400/零文件写入、超时恢复、正常DONE后摘要超时不落盘。非流式响应已发头但JSON正文停顿未单独驱动。 |
| 既有test/stream-context.js | **31/31，exit0** | SSE异常与恢复、压缩输入/事务边界；保留原有行为。 |
| 既有test/model-routing.js | **33/33，exit0** | 两个严格本地模型端点，含流/非流摘要、主/子/辅助路由、审批、workflow、设置热切换。 |

新增npm入口`test:execution-cancel`并接入test-all（本批未运行完整入口）。三套行为检查合计84项，分别单次执行；不宣称完整项目84项全部覆盖。保留上一批T22-20的27/27为上一批证据，本批未重跑该组。

### 未完成范围与发布限制

- T22-06/OPT-15保持🔶。直接视觉axios请求、启动dream与BTW尚未接入此执行控制；下载/其它网络/MCP的活动等待、持久shell及auto_debug内部等待与副作用尚未贯穿。已进入这些工具的操作仍可能在取消/过期后提交；后续需逐个在异步恢复后的写入/启动前拦截并验收，不能只靠executeToolRaw入口检查。直属命令kill的既有轮询保留，进程树结果仍归T22-07。
- 同步IO/execSync不能被JS timer中断；取消不是回滚已经完成的副作用。排队请求仍要等待前任结算才释放自己的队列位置，数量/字节/队龄准入仍由T22-16处理。Ctrl+C/注销/关机及异常终止未在本批闭环。
- 未运行完整A–J/UI/test-all、真实模型、真实桌面、Win7实机、长期运行和打包；本机Node13实证不替代Win7。未改用户真实配置，未提交、未推送、未重新打包。

---

## 2026-10-24 —— Git提交登记

本次提交合并独立复核后的清单修正、T22-20状态收尾及T22-06取消首批（提交标题：`fix(T22-06,T22-20): cancel model requests and preserve tool outcomes`）。上文各实施阶段“尚未提交”描述为当时状态，以本节提交登记为准；未推送、未打包。沿用此前单次验证：T22-20定向27/27，T22-06取消20/20、流/压缩31/31、模型路由33/33；提交阶段只检查差异和暂存范围，不重跑测试。T22-06/20剩余范围与Win7发布限制不变。

---

## 2026-10-24 —— T22-06 第二批：下载、网络与MCP/shell取消

### 已实施范围

- 下载在同一个`executionHttp`订阅内完成等头、流传输和writer close，取消即主动关上游并等待pipeline/文件清理；已有目标不删除。关闭后、flush/完整备份后再检查令牌及绝对截止时间，防止同步备份耗时过长后继续rename；失败/取消仅清理本次拥有的临时文件，已发布的完整旧版备份保留。
- web_fetch、四种搜索provider、网页读取、视觉请求、external MCP HTTP改用共享取消请求；取消不被各分支catch吞为普通成功。新增统一终态兜底：工具在返回时已经取消，即使旧分支返回成功文本，审计/SSE也采用cancelled并提醒核对已完成的副作用。未将其它正常字符串结果批量迁移，不改变OPT-13的47/53注册计数。
- MCP stdio的initialize/tools/list/tools/call接收同一令牌，pending项在正常回复/失败/取消中释放timer和订阅；取消等待时退役并尽力kill直属child，已发送结果明确未知、不重放。initialize回复后取消也退役半初始化对象，不发送initialized或tools/call；发现循环取消后不启动下一server，迟到旧exit不影响替代对象。
- 持久shell在执行前和写入前检查取消，活动等待订阅取消后结算、退役、释放timer及缓存；不复用旧会话，不重放命令。普通命令的既有kill轮询改为订阅式触发，仍await真实runner回调结算；旧函数令牌由统一观察器在活动等待中轮询兼容。sleep等待同样可取消。
- 复用下载VM加载器注入真实取消辅助函数，适配管道VM；新增`test/tool-cancellation.js`、npm入口并接入完整test-all，未引入生产依赖。保留原审批/并行策略和工具声明。

### 本批验证（均单次，无跳过）

| 检查 | 结果 | 实际证据 |
|---|---|---|
| Node13语法：index.js、tool-cancellation、pipe-lifecycle、download-commit、test-all | 5/5，exit0 | 随包runtime/node.exe；未据此宣称Win7系统能力已验收。 |
| 新增tool-cancellation | **20/20，exit0** | 真实临时文件/HTTP/stream＋原函数：下载预取消不请求、等头/半流取消后close及原文件可复用、writer close/备份后取消不替换、模拟同步备份时钟越过截止时间不提交；fetch/四搜索/browser/vision/MCP HTTP的部分JSON正文停顿取消及审计状态；预取消零HTTP、sleep截止、MCP发现不启动下一server、旧成功不覆盖取消。全部HTTP被限制到本地夹具，未调用外网或真实视觉模型。 |
| pipe-lifecycle | **37/37，exit0** | 原30项保留，新增7项：预取消不spawn、初始化回复后取消、活动RPC未知结果、旧exit不删替代、shell活动取消/预取消不写，以及真实停滞MCP直属子进程关闭。原有真实MCP重连、Git Bash cwd/env与exit恢复亦通过。活动shell取消用受控真实Stream/假child；未据此宣称真实进程树停止。 |
| download-commit | **41/41，exit0** | 原下载故障保全、原子提交/备份/恢复、骤停、新进程与中文空格路径回归。 |
| state-store | **59/59，exit0** | 因共享下载加载器变更，确认原状态写入/恢复/配置/HTTP/重启专项未受影响。 |

行为检查分别单次，合计157项；完整test-all未运行，未重复首批20/31/33及上一批B27。普通命令订阅式kill保留await语义已静态核对，未在本批单独驱动真实命令取消；其后代停止仍待T22-07。新增测试不计入旧runner静态record计数表。

### 剩余范围

- T22-06/OPT-15继续🔶：dream/BTW与auto_debug内部尚未贯穿；同步IO/execSync不能由JS timer中断，已经开始或完成的副作用不能回滚。MCP/shell取消采用退役和未知结果语义，关闭本地连接不证明远端操作或后代进程停止，仍需T22-07。
- 未验证真实Win7、真实网络provider/视觉端点、关机注销、Ctrl+C、多层进程树和24/72小时长期运行；未运行全套A–J/UI/test-all、未打包。本批未提交、未推送；上一批提交68fa239保持独立。

---

## 2026-10-24 —— 自动推进与第二批提交登记

用户授权后续每批完成验证即提交并自动继续下一项；测试失败先分析并集中修复，再自动定向复测，无需逐次确认，仍避免无意义全套循环。本次将T22-06第二批归入提交`fix(T22-06): cancel tool transports and fence download commits`；上文第二批“尚未提交”为实施阶段状态，以本节登记为准。工具20/20、管道37/37、下载41/41、状态59/59沿用本批单次结果，提交阶段不重跑；未推送、未打包。

---

## 2026-10-24 —— T22-06 第三批／T22-22 局部：辅助任务取消与dream所有权

- 按自动推进授权，先提交第二批为`50e0d47`，随后实施本批。dream使用独立执行控制，锁以wx创建并写入owner标识；同进程防重入，finally只删内容仍属于自己的锁。工作区独占前提下，识别到上次运行的新版锁即可恢复；旧格式锁保留4小时宽限。失败/取消不再记录成功interaction，HTTP主任务成功也更新interaction。
- BTW每个笔记从入队开始计时，/clear标记草稿作废并取消其活动/排队控制；取消和超时不以原文fallback继续注入或落盘，普通模型故障仍保留原有fallback。控制器登记活动集合、finally移除，/bye撤销集合中的执行，阻止关闭后新笔记、主任务或dream之后的任务再开始；EOF仍允许既有任务正常结算。
- 测试夹具同步有意语义：旧REPL测试不再等已取消的旧回复被打印，改查上游已关闭、草稿及BTW日志均不污染；旧sec2不再把失败后存在last_interaction当成功，改查目录存在/锁释放/无成功marker。
- **验证均Node13单次、无跳过**：语法index/REPL/新增辅助专项3/3；新增auxiliary-lifecycle **10/10**（真实文件与原函数、受控模型：成功/失败/前置异常/超时、锁防重入、替代锁保留、旧owner恢复/legacy宽限）；repl-approval **26/26**（原20项保留并加强clear，新增BTW超时、/bye活动模型、/bye活动dream及不再启动后续任务）；旧B定向dream/sec2 **15/15**。合计51项行为证据。HTTP成功交互标记为简单接线静态复核，未单独声称行为验收。
- 新npm入口`test:auxiliary-lifecycle`和完整入口登记；未运行全套A–J/UI/test-all、Win7实机、真实模型/桌面、24/72小时及打包。T22-06仍剩auto_debug内部/同步IO/全部副作用/进程树，T22-22仍剩启动ready解耦与环境/退出全链路，不关闭这些整项。
- 本批按授权随提交`fix(T22-06,T22-22): cancel auxiliary work and own dream locks`归档，不推送、不打包；完成后自动继续auto_debug生命周期。

---

## 2026-10-24 —— T22-18／T22-06第四批：自动调试生命周期

- 第三批已自动提交为`64daf8c`。本批改为记录直属进程的error/exit/close和实际退出码；不再在已退出后按旧PID taskkill。取消或观察期限后只通过仍未退出的ChildProcess句柄停止，最多等5秒close；未确认清理时明确未知并停止修复/重启，进程树停止仍属T22-07。
- 编译改为异步可取消，每次修改C#后重新编译再执行；JS使用process.execPath，CMD以显式参数/引号处理中文空格路径，对可能被CMD展开的特殊路径拒绝。debug观察/编译/fixer/下轮启动共享令牌；最多3次修复，递归debug明确拒绝，finally恢复再入标志。
- 调试采集stdout+stderr合计8MB、内部log 4K、结果文本16K；输出超限/管道错误/spawn失败/清理不明不再自动重启。静默非零退出或修复耗尽明确error，不再声明“只剩warnings”。文本诊断仍属启发式，可能误报，未宣称通用语言错误解析器。
- GUI改为被动观察，停用未确认目标窗口的随机鼠标/键盘输入，文本明确未验证UI；模板ENABLE_AUTO_DEBUG改false（此前模板实际为true，与旧文“默认禁用”口径不一致，本批修正），不改用户真实配置。全部debug提前/正常/失败/取消分支结构化，OPT-13注册从47增至48/53，剩余5工具，未关闭T22-20整项。

| 状态 | ID／归属 | 严重程度／证据 | 问题与修复 |
|---|---|---|---|
| ✅ | INC-24-02／T22-18 | Medium／已确认 | 基线64daf8c的index.js:4010在循环外只编译一次，:4025每轮重跑同一exe，:4039修复源文件后不重新编译；修改.cs后会测试旧产物，导致修复无效/误判耗尽。本批将编译移入每轮，专项用受控编译/观察验证一次修复对应两次编译；未冒充真实csc/.NET实机验收。 |

- **验证**：Node13语法index/debug专项2/2；新增debug-lifecycle **21/21**（真实stream/受控child/受控fixer＋真实随包Node、CMD：退出7、PID不误杀、取消/close、EMFILE无stdio、5秒close未知以受控timer驱动、合计8MB、递归拒绝/guard恢复、C#重编译、PATH为空、中文空格路径）；A定向adv-tools **20/20**；B定向sec2 **9/9**，均本批单次、无跳过。B sec2上批也运行过，但本批产品已改变，旧结果不能覆盖本次修改。未发生测试失败，无需复测。
- 未运行完整A–J/UI/test-all、真实模型/GUI/.NET、Win7、长时间运行或打包。T22-18保持🔶直到进程树/目标环境验收，T22-06仍有同步IO/全副作用闭环，T22-15与T22-23仅更新已做子范围。
- 本批按授权随提交`fix(T22-18): observe debug exits and bound repair lifecycle`归档；未推送，下一项自动推进T22-07进程所有权。

---

## 维护约定

1. **唯一事实来源**：本文件。修复某条后：改状态列 + 附提交号；新问题追加到当日期小节；跨日期的大问题可新建日期小节用 INC-/NEW- 编号。
2. **提交纪律**：状态变更与对应代码修复同一提交；提交信息引用条目号（如 `fix(P1-1): ...`）。**跨号联动（2026-10-03 增补）**：当以新编号（DS-/AST-/OPT- 等）修复的问题在旧表有同源行时，必须在同一提交内回翻旧行状态——2026-10-03 盘点发现 11 行"账实不符"正是只记新区块、漏翻旧行所致。
3. **归档（OPT-9 已执行 2026-10-02）**：KNOWN-ISSUES.md、REVIEW-CHECKLIST-2026-09-30.md、deepseek4.1flash审阅.md 已移入 `docs/history/`，只读历史快照，不再更新。
4. **套件计数防漂移（OPT-10 已执行 2026-10-02）**：`scripts/count-assertions.js --write` 回填头部标记段；实测通过数在规模快照行手写，两口径并列标注。

### 2026-10-24 —— T22-07首批：停止结果与cron句柄保全

- 修复删除运行中cron只停timer却遗失child的确认缺口：立即禁用后续调度，等待直属child的close；5秒内未确认则error并保留registry/句柄，cron_list显示disabled/running/错误，后续删除可重试。
- task_stop不再无条件伪报stopped：stopping→stopped或stop-unknown；未知时无结束时间且保留child，迟到close纠正状态。pruneTasks只裁剪已结束且没有活动child的条目；命令回调不再直接释放cron运行位，必须观察close，避免继承管道未关时下一轮重叠。
- /bye将task/cron停止并行等待，最多各5秒，输出未确认数量；Windows保留树停尝试但改为异步execFile参数数组、隐藏窗口、有限timeout/maxBuffer。已观察exit/close时不再按旧PID停止。taskkill启动与目标退出间仍有PID复用竞态，未宣称解决；完整Job Object所有权需兼顾Win7不支持嵌套job及离线分发，本批未新增.NET/二进制依赖。
- Node13最小验证：新task-lifecycle **19/19**（直属handle、重复停止、exit但pipe未close、kill拒绝/异常、EMFILE缺stdio、未知/迟到状态、cron注册表、prune与真实Node直属关闭）；随后保留Windows树停分支，单元fixture明确走直属分支，新增task-windows **6/6**验证实际异步taskkill、失败未知、已知exit不重杀以及真实两层Node子树释放端口。B的cron-overlap/tool-results-b4 **13/13**，旧cron假child补EventEmitter/close事件。auxiliary-lifecycle **10/10**作为dream锁局部检查，不能计作/bye进程树验收。以上专项各单次，无失败复跑；Node13语法及diff静态检查通过。
- 新npm/test-all登记两个专项（Windows树专项只在Windows完整入口加入）。未运行全套A–J/UI/test-all、真实REPL带后台进程的/bye、Win7/关窗口/注销/强杀后的多层树、one-shot收尾或长时间运行。T22-07保持部分完成；不把两层夹具通过当成内核所有权证明，不推送/打包。
- 本批按授权提交为 `fix(T22-07): retain task ownership until observed close`，接着推进T22-15后台任务输出预算。

### 2026-10-24 —— T22-15后台采集预算与任务准入

- T22-07首批已提交`c7840e1`。本批不重复已通过的生命周期19/Windows6/B13，而以新增预算故障路径和未跑的旧定向场景验证。
- 后台task最多4个活动直属child，stop-unknown不释放名额，真正close后可继续创建。保留50条已结束历史，创建时即裁剪；每条最多128KiB完整UTF8尾部，原先展示截断却持续保存全文的路径已消除。超过stdout+stderr累计8MiB仅触发一次停止，后续data继续排空但不再累积，close后状态failed；不能确认停止则保留unknown。task_get提供字节数/丢弃标志，task_output始终显示预算失败提示。
- exec内部maxBuffer从20MiB改为8MiB/stream兜底；它仍会额外保留有界stdout/stderr，不据此宣称消除全部内存副本。exec错误消息限定2000字符并走相同尾部预算，防止错误携带整段输出绕过上限；命令限制32768字符、描述2000字符。
- cron最多32项、重复id拒绝；模型工具ID加入单调序号，防止同毫秒创建覆盖旧timer/child。校验空命令/过长命令；running防重叠及停止未知时保留注册表继续有效。
- Node13单次验证：新`test/task-budget.js` **18/18**（含真实连续输出Node producer、合计stdout/stderr超限、UTF8边界、错误体、未知名额、释放名额、60任务历史、cron数量/重复id）；B `tool-results-b3` **6/6**（错误样任务正文仍ok、workflow继续）；C `bye-hang` **1/1**（真实REPL携带30秒后台命令/bye及时exit0）。Node13五个相关JS语法及diff静态检查通过。旧task-lifecycle/cron-overlap夹具补新常量与编号上下文，仅静态检查，不计本批重跑通过。
- 新npm/test-all入口登记预算专项。T22-15保持部分完成：未验证所有MCP pending/待发总量、摘要/聊天排队、大文件读取、全部常驻数据与日志；没有统一RSS硬上限。taskkill仍存在PID竞态/无法内核绑定后代，T22-07不关闭；C的及时退出只证明该场景不挂住，不证明强杀后的所有进程树清理。
- 未运行完整A–J/UI/test-all、Win7/关机注销/断电、24/72小时或打包；未推送。本批按授权提交`fix(T22-15): bound task output and background admission`，下一项推进T22-16摘要队列与HTTP准入。

### 2026-10-24 —— T22-16摘要队列与HTTP准入

- T22-15后台预算已提交`b190d26`。本批移除无界summaryChain：流式DONE和非流JSON回复都在返回后交给同一个后台摘要队列，摘要模型等待不再占核心权限门；CLI/REPL仍await摘要，避免one-shot提前退出。
- 摘要队列含活动项最多8条/2MiB输入（文本+路由元数据），仅一条活动；排队60秒、总生命周期120秒且不超过原请求绝对截止。超载/排队过龄转有界简短task/response记录并带原因，无须保留原长输入；原请求已过期或Agent退出不写fallback，活动模型截止会取消并记录原因。短正文保留<200字符跳过摘要的旧契约，避免慢摘要前堆积无意义短任务。独立modelContext随项保留；实际写日志时重读现有文件，保留其它内容。
- 聊天读正文前占用8项名额，逐chunk计数共享16MiB正文预算/每项10MiB；超量429、单项过大413、读取30秒/排队60秒超时408（已开始SSE则发送错误事件）。已取消的排队请求移除并释放其闭包/名额/字节，不等待前一项结束。保留活动执行门直到实际settle，不让权限全局并发。正文计数改为增量，避免每chunk重新扫描累计字符串；读取失败/异常断开清空正文并幂等释放。/api/info新增不含内容的load指标。
- 顺带修正图片消息摘要输入：从多模态数组提取text，不把数组传入Buffer.byteLength，不将图片data URL复制进摘要队列。不是把图片本身交给文本摘要模型。
- Node13单次验证：新queue-admission **25/25**：准入count/bytes/幂等释放、FIFO/取消/排队超时、正文限额/超时/abort+error、摘要数量/字节/路由/控制清理/过龄降级/短回复/原截止与活动取消；真实隔离Agent的流式DONE后摘要挂起而下一任务成功、8项满后429且健康可读、排队断连从未进入模型、实际16MiB共享预算/部分正文abort释放、多模态摘要。B bodycap/bodycap-edge/bg-summary **15/15**（含UTF8末字符跨chunk、chunked及多个POST路由）；C stress **1/1**（6个流/非流请求无串线）；E summary-race **1/1**（日志结构及两条摘要）。均首跑通过，无失败复跑。Node13三份相关JS语法与diff静态检查通过。
- T22-16实现与所列定向故障路径关闭。不是完整发布验收：未跑全套A–J/UI/test-all、真实模型质量、Win7/24/72h、配置极限大小或打包；完整Agent输入/输出/日志/文件的总内存和磁盘预算仍归T22-15/26，进程树仍归T22-07。简短降级会丢失正文细节并有显式标记，现场需要结合原会话/审计排查。
- 本批按授权提交`fix(T22-16): bound summary queues and admit cancellable chats`；未推送，继续下一项启动ready与dream解耦。

### 2026-10-24 —— T22-22启动ready与可选维护解耦

- T22-16队列批已提交`dc60339`。HTTP现在await实际listen成功，再开始可选dream或显式startup prompt；端口失败先报明确诊断并非零退出，不会先调用模型/执行启动任务。页面/GET诊断在初始化任务执行期间可用。
- 可选启动dream在后台运行，复用核心执行门，最多120秒且不超过全局EXECUTION_TIMEOUT_MS。有效聊天到来会取消queued-dream/dream，等待其模型/工具返回及owner锁清理后交门，避免仅把await移除而导致权限状态/文件并发。triggerDreamIfNeeded可使用外部控制而不自行dispose它，独立CLI/REPL仍保留自有控制；成功交互标记前再检查取消。删除无运行保证的“2.5小时”展示与提示。
- 显式--server --prompt在监听后优先占门执行，前台聊天排队；该启动不再先运行可选dream。executeTask返回成功/失败供startup状态使用，保留原输出/退出码。显式任务失败不是HTTP初始化失败：/api/info明确failed并给诊断提示，核心门释放后可通过正常聊天恢复。startup.phase/error不含控制对象或密钥。
- 新startup-readiness专项Node13 **13/13**、单次首跑：原调度/门/控制函数的EROFS故障注入释放与抢占；真实隔离Agent在dream上游挂起时UI/info可读、前台抢占关闭上游并删锁；1秒截止无成功标记且下次聊天恢复；端口占用时零模型调用；显式任务优先且诊断可读、完成/失败后下一聊天；真实直属Agent强终止留下owner锁、同工作区/端口立即重启恢复并再次让出前台。Node13相关三份JS语法与diff静态检查通过。
- 未重复已通过的辅助/REPL/dream、queue-admission或旧eaddr测试，未跑完整A–J/UI/test-all。EROFS为原调度函数注入，不等于Windows ACL实测；强终止对象只有Agent直属进程，不证明任意工具后代清理。Win7、注销关机/硬件断电、目录真实权限、24/72h及打包仍未验收，T22-22保持部分完成。未推送。
- 本批按授权提交`fix(T22-22): expose HTTP readiness before optional dream`，继续T22-17 HTTP持久shell状态隔离。

### 2026-10-24 —— T22-17受限发布与CLI shell作用域

- T22-22启动批已提交`1fa868e`。没有把请求门串行误当会话隔离：HTTP缺少后端会话身份，按原清单允许的过渡方案在raw工具处明确blocked persistent=true，danger/bypass和嵌套agent/workflow也无法绕过；不静默改成单次shell。schema给出限制，/api/info能力false。HTTP单次命令、CLI/REPL持久模式保留。
- 确认并修正CLI跨scope组合缺口：原agent-1/wf-1仅按深度复用，多个独立子代理或workflow可继承前者cwd/env。现在子代理finally退役agent-depth，根workflow finally退役wf-depth；agent内workflow不提前退役仍在使用的agent shell，最终由agent清理。main CLI shell只随clear/退出等原生命周期清理。dispose采用身份校验，失败诊断后不再复用缓存；未证明后代/句柄已全部退出。
- 新shell-scope专项Node13 **17/17**，单次：HTTP guard先于bash发现/创建、CLI原成功契约；两个agent无前scope、失败/取消回滚、workflow成功/异常与agent内workflow归属；真实danger HTTP两次独立对话、子代理/workflow均返回blocked且未创建文件，能力可读。B pshell/tool-results-followup/tool-results-b6 **27/27**，I table-consistency/tool-result-contract **24/24**，均单次无失败复跑；真实Git Bash主会话cwd/env/单次模式路径通过。五份JS Node13语法及diff检查通过。
- 同步修测试提取漂移：B followup原函数尾标记仍指已移除的注释，改按awaitCommandCancellable函数边界；命令分支夹具加载源码原checkExecution、明确HTTP=false；subagent/workflow夹具明确清理依赖。没有让断言跳过新分支。pshell的旧read10s/timeout15s不满足注释宣称的超时先决条件，27/27不能据此关闭该oracle缺口，紧接着单独修T22-33。
- T22-17保持部分完成：当前只允许以HTTP persistent禁用的能力范围发布；完整后端会话协议/恢复/关闭未实现。未跑全套A–J/UI/test-all、Win7、真实多agent Bash长时间/树回收、24/72h或打包；未推送。
- 本批按授权提交`fix(T22-17): restrict HTTP shells and retire scoped sessions`，继续T22-33超时测试oracle。

### 2026-10-24 —— T22-33超时oracle与INC-24-03持久Bash启动器残留

| 编号 | 严重程度／依据 | 状态 |
|---|---|---|
| INC-24-03 | **High／已确认**：Windows Git布局的bin/bash.exe是兼容启动器；createPersistentShell原先直接持有它，die只kill启动器，实际usr/bin/bash.exe仍执行并占用管道。下一会话可新建而旧shell仍活，超时/取消重复发生时累积残留。独立专项首跑在“已timeout/退役”后未见真实close，WMI核对同一专属owner标记发现实际子Bash（原wrapper PID28584，内部PID3272）；不是凭超时文本推测。 | ✅ 当前Git布局的持久shell路径已修：解析相邻usr/bin/bash.exe并直接spawn，补子进程PATH/MSYSTEM；新专项修后8/8（0skip）。只关闭这个可重现启动器路径，不关闭T22-07任意树回收。 |

- T22-17受限发布批已提交`4f11a06`。旧pshell的read10s/timeout15s先决条件不支持原注释：read还可能消费后附marker，超时文本不能说明真实命令/进程已经停止。旧fixture改为6秒Bash内建watchdog循环、1秒工具期限；不创建外部sleep后代，并在清理回归时有限自行结束。原27/27属于修正前fixture，未重跑，不将其倒填为新oracle验收。
- 新独立test/shell-deadline使用源码原findBash/采集/取消函数和真实Git Bash，首跑在2项通过后失败：真实close超时，测试进程因被内部Bash持有管道不能退出。已核对该次专属临时目录/owner标记、进程创建时间及命令行，仅清理匹配的内部测试Bash，首跑最终exit1。没有停止普通Agent或其它工作进程。后将测试循环加6秒内建watchdog，使同类回归不会无限残留。
- 根因修复只涉及持久shell创建：若发现bin/bash.exe旁存在usr/bin/bash.exe则直接启动后者；已是usr路径或其它布局保持原路径。直接解释器不会自动继承launcher提供的Unix工具路径，原生小探针确认直接调用时git可见而ls不可见，因此只在该child env补usr/bin、Git cmd和存在的mingw/ucrt工具目录，保留继承PATH并消除Windows Path/PATH重复键，存在安装前缀时设置未显式指定的MSYSTEM。不改全局环境、不新增目标机开发依赖。分发结构另参README链接的Git官方portable/post-install脚本；该结论主要依据本机真实进程证据。
- 按用户当前“失败自动再测”授权，根因集中修复后**仅复跑新shell-deadline一次：8/8，exit0，0SKIP**。验证1秒工具期限早于6秒命令结束、未知结果/缓存退役、实际直属解释器close且仅kill一次、新环境无旧变量且ls/git可用、并发run零额外stdin、原命令输出独立、活动取消后close及控制清理。若找不到Bash，专项明确单列SKIP而不记通过。Node13相关四份JS语法检查通过。
- 新npm/test-all登记；旧pipe-lifecycle夹具加载新增原路径/env函数，仅静态检查，未重复37项专项或完整A–J/UI。非持久bash/debug .sh、MCP包装器、任意命令后代、Win7 Git版本/布局、注销强杀与24/72小时仍待T22-07/03/验证门槛；本次真实close只针对未产生外部子进程的Bash内建循环。T22-33其余oracle问题保持开放。
- 本批按授权提交`fix(T22-07,T22-33): own the persistent Bash interpreter`，未推送/打包。

### 2026-10-24 —— T22-23测试自动识别复用当前运行时

- 持久Bash真实超时批已提交`c033208`。本批修复Node13遇到根目录*.test.js就自动执行PATH上的node --test的确认缺陷：按Node官方文档的16.17/18.1引入边界选择；Node13（及不支持的17/18.0等）给出明确framework/显式命令说明且零启动。支持版本使用execFile当前process.execPath与argv，显示字符串不交给shell执行。
- package scripts.test优先级保留（仍需可用npm，未改npm lifecycle）；支持UTF8 BOM，错误类型/损坏/不可读package.json明确error而不偷偷落入其它自动路径；同名目录不当作测试文件。显式command保持原样且可覆盖损坏的自动配置；执行前复核取消。
- Node13单次：新test-runtime **11/11**，包括版本边界选择/不可用零进程、带空格/中文/%/!虚拟可执行路径仍走argv、BOM/脚本优先/无效类型/损坏配置/目录、真实Node13在PATH完全清空时执行中文空格路径脚本并解析1 passing、取消前零新增子进程；B tests-runner **6/6**，原npm脚本及四类输出契约保留。三份相关JS语法与diff检查通过。现代Node分支只验证原函数选项与argv，没有谎称实际运行Node18/16；没有重复以前的debug及B/其它专项。
- T22-23继续部分完成：可选npm（含自身Node版本需求）/Git/Python/csc及项目tsc/eslint仍需功能预检；随包Node13不包含这些开发工具。未跑全套A–J/UI/test-all、Win7、24/72h或打包，未推送。
- 同步T22-07/T22-17实时行，纳入c033208解释器/真实close和超时oracle修正，历史原记录保持。本批按授权提交`fix(T22-23): detect tests against the bundled Node runtime`，继续T22-28 Git状态首列边界。

### 2026-10-24 —— T22-28 Git状态首列

- T22-23测试运行时批已提交`703ece7`。git_status_tool不再trim整段--short输出，只去掉尾随CR/LF，保留第一条记录的index列空格；按CRLF/LF分行。修正旧Git集成中锁死错误计数的断言，显式检查首条` M app.txt`。
- 新git-status-columns专项Node13 **9/9**，单次真实私有Git仓库：clean→首项未暂存→仅暂存→MM→混合未跟踪→只剩未跟踪→clean；另用原分支校验CRLF及已确认仓库中status失败。夹具清空继承GIT_*覆盖并用独立空global配置，所有commit仅作用于临时仓库。旧B git-integration **4/4**，单次真实REPL审批/工具链，包含diff、提交/快照及非仓库结果。四份相关JS Node13语法与diff检查通过。
- 未跑完整A–J/UI/test-all、Win7或打包。该修复不处理其它Git配置/可执行文件预检、空仓库HEAD等未列场景；不改stage/commit/snapshot语义，不推送。
- 新npm/test-all入口登记。本批按授权提交`fix(T22-28): preserve Git status index column`，继续T22-25/29路径边界与memory分隔符。

### 2026-10-24 —— T22-25/29根路径包含与memory分隔符

- Git首列批已提交`659fc75`。isInsideDir由手工拼接base+sep改为相对路径边界：等根或非父级/非绝对相对结果才在范围内，避免盘符/UNC共享根自带尾分隔符时重复分隔符误拒。保留Windows大小写折叠、不同卷/共享拒绝以及realPathSafe的junction/最长前缀/深度fail-closed，未扩大跨卷权限。
- memory自动写例外先将path.relative的本机分隔符归一为/再做原匹配。deny/protected/denial仍在例外之前，普通source不自动批准，不修改权限模式或用户规则。
- 新path-boundaries首跑11项路径判断通过，进入虚拟根状态写入时因测试沙箱漏传Buffer而ReferenceError、exit1；对照既有state-store夹具补Buffer/require后，按现有失败自动复测授权仅复跑该专项一次：**25/25，exit0**。包括drive根/相等/大小写/不同卷/前缀/父级、UNC共享根/大小写/不同共享/不同server、POSIX根及大小写；映射drive/UNC根的源码原state读写/previous、反斜杠memory自动写、普通source需审批、deny/protected-extra/denial、真实外指junction拒绝。所有IO由有边界断言的虚拟FS映射到本次私有临时目录，既未写真实盘符根也未访问真实网络共享。
- 旧B perm-rules **8/8**，仅首跑，修夹具后没有重复；三份相关JS Node13语法与diff静态检查通过。未运行全套A–J/UI/test-all、真实驱动器根/UNC共享故障、Win7、24/72h或打包。代码修复及所列验证关闭T22-25/29，目标机/网络文件系统实机门槛继续保留。
- 新npm/test-all入口登记。本批按授权提交`fix(T22-25,T22-29): normalize root containment and memory paths`，未推送。

### 2026-10-24 —— T22-30搜索输入与真实访问预算

- 路径批已提交`05086b9`。确认原glob的visitedCount仅在进入目录时增长，不能限制平铺的大量不匹配文件；改按每个目录条目计数（包含跳过/无法读取项），glob最多4×maxEntries，匹配条目仍维持原1000+sentinel契约。深度/访问耗尽和IO错误用显式incomplete标记，真正空结果才为无匹配。内部pruneBackups不传opts，保留无预算/无过滤遍历。
- grep显式输入可为普通文件或目录；不存在的起始路径带errno返回Tool error，外指junction仍先被sanitizePath拒绝。显式大文件/二进制输入有跳过原因，不再误报无匹配；嵌套读取失败报告incomplete/errno。模型侧除5000实际文本文件和每文件50匹配行外，新增20000访问条目/深度12，跳过的二进制/重目录同样消耗条目预算，真实路径去重继续防junction循环。schema同步。
- Node13新scan-budget首跑7项通过后，外指junction断言错误地期待返回文本，而原sanitizePath已抛Security异常，产品保护有效；改为assert.throws后按失败自动复测授权仅重跑该专项一次：**21/21**。包括实际中文/空格私有路径、文件/无匹配/缺失、binary/2MiB、匹配行cap、原regex lint、真实junction逃逸/循环、计数IO、无opts全量、深度及EACCES注入。旧B scan-caps/tool-results-b2 **13/13**首跑，未重复。Node13语法、diff静态检查通过；新专项登记npm/test-all。
- 本项关闭不等于同步IO有硬时限：readdirSync仍一次分配目录清单，单次读/stat/regex仍可能阻塞；尤其歧义分支正则疑点仍开放。未跑全套A–J/UI/test-all、Win7/真实ACL/网络盘、24/72h或打包。按授权提交本批，未推送；继续T22-31固定时钟下cron ID和独立回收。

### 2026-10-24 —— T22-31固定时钟cron身份验收

- 搜索批已提交`a470cb6`。实际源码在T22-15的`b190d26`中已经引入cronSeq后缀和重复ID拒绝；本批没有重复改写已正确的调度器。修正工具分支中过时的“仅Unsupported schedule会失败”注释，保留全部失败状态映射。
- 新cron-identity只加载源码原创建/调度/删除/子进程观察函数，冻结Date.now及Date构造时间，替换timer为可手动触发的句柄、child为明确记录kill/exit/close的自有夹具。Node13首次单次 **9/9**：两个创建别名在同一毫秒生成不同ID，Map和timer均保留；显式重复不替换；独立执行；各自running跳过tick且仅保留一个后续timer；删除第一个只关闭自己的child/timer，迟到旧callback不复活；第二个close后可再运行且独立删除，最终timer/Map无残留。
- 新专项登记npm/test-all，相关JS Node13语法及diff检查通过。没有重跑task-budget/cron-overlap或全套A–J/UI/test-all；此处是确定性调度与句柄身份验证，不宣称真实OS后代或Win7/休眠/时钟跳变、24/72h已验收。T22-31关闭；不关闭T22-07/验证门槛。按授权提交本批，未推送；继续T22-32最低运行诊断。

### 2026-10-24 —— T22-32最低运行诊断与有界故障记录

- cron身份批已提交`8d04d9b`。/api/info保留已有chat准入/核心排队/摘要队列指标，新增runtime：活动CLI/HTTP任务、活动工具、累计完成/非成功操作、最后成功/错误/事件及日志可用性。finish幂等；工具wrapper即使异常抛出也释放计数，CLI初始化checkpoint纳入原try/finally；HTTP流式/非流式响应、失败、断连均落终态。最后成功不会擦掉最后错误，进程重启后内存状态重新计数。
- UTF8 `.7coder/runtime.jsonl`独立于可关闭的audit，记录CLI/HTTP终态、工具非成功、HTTP ready/server错误及background/cron直属child close/spawn error。可用时保留scope、任务ID、errno/syscall/path、PID、真实exitCode/signal，字段白名单/长度有界及常见token形式脱敏；成功工具继续由原audit记录，不双写成功工具日志。不专门拷贝正文/模型配置，但错误文本可能带输入片段；不是完整保密过滤或跨会话追踪。
- 写前按UTF8字节预算轮转，保留current/old各最多1MiB；旧代替换失败/rename失败就跳过append，防日志故障反而无限增长。磁盘满/权限失败不影响原任务结果，记录loggingError且console最多每分钟提示一次，下次写成功清除故障。保持原审计机制，不把本批新增runtime限额冒充T22-26全部磁盘策略。
- Node13新runtime-diagnostics首次单次 **21/21**：活动计数/幂等、成功失败并存、UTF8 errno/path、字段脱敏/截断及快照不可变、连续轮转、EACCES阻止append/告警限频、ENOSPC结果不变/恢复；真实自有Node exit7与无PID spawn错误；真实HTTP ready、活动＋排队、503失败恢复、流式成功、AUDIT_LOG=false仍记工具失败、断连取消和日志终态。旧tool-cancellation **20/20**、B cron-overlap **6/6**单次，确认工具取消/审计契约及独立cron继续；无失败复测。为提取源码的旧夹具显式补新诊断依赖的空实现，不改原业务断言；新专项另行加载并检查真实诊断函数。收尾静态核对工具退出码来源为res.data.exitCode，非顶层属性。
- 新专项登记npm/test-all，README写明日志位置/预算/降级。相关JS Node13语法及diff检查通过。未重复其它task/Win32专项，未跑完整A–J/UI/test-all、真实CLI执行诊断链、Win7/实际ACL/磁盘耗尽/强制终止、24/72h或打包。故障注入不等于真实磁盘满验收；早期配置加载失败尚未进入诊断初始化，仍依赖stderr/启动脚本日志。MCP/持久shell/任意树的全部进程事件未纳入，close仍只证明直属句柄；完整runId和跨会话提交统计按OPT-3/DS-13暂缓。T22-32最低范围关闭，按授权提交本批、未推送。

### 2026-10-24 —— T22-27代码围栏语言属性边界

- 运行诊断批已提交`fcc4072`。实际render将esc(lang)拼入双引号data-language，而esc用DOM.textContent→innerHTML只承担文本转义，不保证双引号转义。新增escAttr复用文本转义并显式把双/单引号转为实体，只有属性位置改用；语言标签文字、代码内容、围栏解析与copy逻辑保持原实现。
- Node13 webui-dom-sim单次 **15项通过**（新增3项）：含紧邻onmouseover形状的引号只能留在一个data-language值内，单双引号/&/尖括号编码正确，空language不产生属性；原c++/c#、CRLF、未闭合围栏、SSE/保存/错误气泡回归保留。此桩DOM不执行HTML事件，原“window未变化”断言本身不能证明浏览器执行隔离；本批证据是原render输出的属性边界编码，真实目标浏览器继续由V22-02验收。
- webui内联脚本经该专项vm解析，测试文件Node13语法及diff检查通过。未运行其它UI/真实浏览器、完整A–J/test-all、Win7、24/72h或打包；未推送。T22-27关闭，按授权提交本批，继续T22-24 PowerShell编码闭环。

### 2026-10-24 —— T22-24 PowerShell输入、stdout/stderr与退出码

- Markdown属性批已提交`6879af9`。PowerShell工具选SystemRoot下系统WindowsPowerShell可执行文件（无SystemRoot才fallback PATH），用execFile argv和隐藏子窗口；不走cmd命令拼接。固定ASCII bootstrap解码用户UTF16LE Base64，PS2/.NET2可用的New-Object/Console API在解析用户脚本前设置UTF8；截图复用，input.ps1写UTF8 BOM并用独立argv运行，修中文/带引号路径和PS2默认ANSI读取风险。
- 真实专项识别原先未被普通ASCII用例覆盖的宿主差异：仅设置OutputEncoding/Console后stdout正确，EncodedCommand仍输出混合UTF8直接stderr＋ANSI CLIXML Write-Error。两组私有、有限文本探针对比原入口/SetError以及ASCII bootstrap/BOM file，证实改Console.Error不能修宿主serializer，bootstrap/file均能输出完整中文错误。采用无临时脚本的ASCII bootstrap；不是在Node侧猜GBK编码。官方PowerShell参数UTF16LE文档已链接README，宿主路径结论依据本机字节实测，不冒充PS2实测。
- 随后的真实最终Write-Error验证发现scriptblock调用会掩盖非终止错误的默认失败退出码；集中修复为脚本末尾立即检查$?并exit1，显式exitN仍先退出保留N；编码prefix在ScriptBlock.Create之前，解析错误也有UTF8错误输出。
- 新powershell-encoding四次执行：首跑3项后夹具遗漏cancelled参数失败；修夹具复跑10项后真实stderr失败；修宿主路径复跑11项后新退出语义断言失败；集中修正后按用户“失败自动再测”授权定向复跑 **14/14、0SKIP**。含中文/空格/百分号/感叹号/&/单引号输入与路径、UTF8 BOM、截图/键鼠dispatch捕获（从未执行实际截图或键鼠）、真实现代WindowsPowerShell stdout/stderr、实际文本读写、exit7、最终Write-Error/throw及解析错误。实际仅启动文本PowerShell；有界10秒、独立cwd、专属Base64命令manifest/直属句柄，未调用真实桌面。
- 旧B tool-results-followup/tool-results-b6 **21/21**单次：取消、stderr、数值exit/unknown和实际Agent命令契约保留；其unit仅补新helper依赖stub，真实编码由新专项检查。新npm/test-all登记；相关JS Node13语法/diff通过。未重跑全套A–J/UI/test-all或其它成功专项，未跑真实Win7 PS2/CLR2/CP936、native自定义输出编码、关机/24/72h或打包；故T22-24保持部分完成，不能因本机modern PowerShell通过就宣称Win7验收完成。按授权提交本批，未推送。

### 2026-10-24 —— T22-19网页最新快照、失败回合和恢复

- PowerShell批已提交`ae504f8`。保存调度由autoSaving直接丢请求，改为最多一个在途＋一个深复制最新快照；首存确认后最新快照携带同一file，只有新建/真正载入/编辑等会话身份变化才失效旧响应，普通发送不再改变身份。失败dirty不清、状态/重试按钮可见，15秒取消占位；只在有更新快照时补存，不循环重试同一故障。流式变化最多每秒快照，终态立即补存；有未确认内容时刷新提示，切会话/新建/编辑需明确确认可能丢失。强制确认刷新/杀浏览器不保证未确认数据持久化，未把提示伪称为强一致保存。
- 发起回合即保存user＋running assistant占位，模型请求不含当前占位；流中更新partial正文，failed/cancelled保留正文、原因和用户轮，不再pop；按turnId累计reasoning/tool活动，手动和自动恢复均按轮重放并显示未完成/失败/取消状态。下一模型上下文给partial与可能已执行副作用的固定说明，降低盲目重试风险。只有收到DONE且正常结束才记ok；无DONE的EOF明确失败。没有重写Markdown或模型协议。
- Web保存请求/持久记录及CLI保存按2MiB UTF8字节预算（原CLI按JS字符数、Web路由1MiB）。不会静默截正文；活动最多2000条，超限明确拒绝且保留旧文件，不再只留前200条；单条展示/脱敏的既有12k文本预算继续保留。旧无metadata会话仍可读；Web save/load保留经过校验的turnId/status/error，继续复用T22-13原子写/previous。
- 新session-continuity首跑16项后大中文响应长度断言失败；根因在共享工装httpReq把每个Buffer块单独toString，跨块UTF8字符被替换，而实际保存完整。改为res.setEncoding连续解码，按现有失败自动复测授权仅复跑新专项：**20/20**。包括慢首存/合并/深快照/file复用、500/413/dirty/重试/刷新与切换提示、手动超时、真实隔离后端failed+partial+已完成工具落盘、两轮活动/两种恢复、停止partial落盘、无DONE失败、1.35MiB中文成功/2MiB超限原文件不动、活动溢出、模型提醒和CLI字节预算。修复该真实共享工装缺陷作为T22-33新增局部证据，不宣称全部oracle已修。
- 原UI模拟 **43项**、DOM **15项**与B bodycap-edge **7/7**本批各单次通过；更新原“失败pop用户轮”错误期望、首存之后补存应带file、成功SSE fixture明确DONE。UI harness只在直接执行时跑原suite，导出供新专项复用，并为Node13显式提供浏览器AbortController事件桩/手动计时器，不伪称Node13原生支持该浏览器API。源码静态复核再给容量失败加revision栅栏，避免老save成功隐藏较新超限提示；这一收尾分支只做静态核对，未为小改动重复已通过的专项。
- npm/test-all登记，相关JS/页面内联脚本语法及diff检查通过。未运行完整A–J/test-all、其它UI/实际浏览器或重跑state-store；GUI键鼠、真实Win7、实际硬刷新/掉电/磁盘满、72h及打包未验收。多客户端冲突策略、CLI/Web共同目录保留和UI历史/DOM长期内存仍由原OPT-6/T22-26/15范围跟踪，不在本批假装解决。T22-19对应R1网页M03/M04范围关闭，按授权提交本批、未推送；继续T22-21审批展示与生命周期。
