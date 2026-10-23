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
| runner-b.js | 318 |
| runner-c.js | 36 |
| runner-d.js | 25 |
| runner-e.js | 22 |
| runner-f.js | 23 |
| runner-g.js | 31 |
| runner-h.js | 27 |
| runner-i.js | 52 |
| runner-j.js | 17 |
| runner-k.js | 11 |
| runner-r.js | 11 |
| runner.js | 60 |
| **合计** | **633** |

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
| GAP-6 | todo 只是往 TODO.md 追加文本 | 无状态流转，UI 无从展示进度 | 【✅ 2026-10-04 快赢批④（GLM+终检）】`.7coder/todos.json` {items:[{id,title,status,updated}]}（500 条上限、损坏自动重建）；todo_write_tool 改 action 式 add/update/list（旧 content 参数向后兼容）；GET /api/todos；webui 侧栏任务面板三色徽标（autoSave 成功回调刷新）。todos-api 场景 3 断言先红后绿。GLM 纠正了规格错误：todo_write_tool 本就不在 AUTO_SAFE，权限路径零改动 | 小 |
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
| A2-06 | index.js:3139-3142 | **bypass 分支漏传 cancelled**（核 实：executeToolRaw(name,args,conversation,approvalBridge) 少第五参）+ 同族：子代理不继承取消、持久 shell 仅事后检查、axios 无活动取消、审批等待期断连不即时 dispose。AST-09 的取消缺口 | ✅ 8fb0a99（最小范围）：bypass 补传 cancelled + 子代理经 processWithTools({cancel}) 继承；接线为源码级断言，行为级取消离线时序敏感未测（如实标注）；已知残留：axios 无活动中止（Node13 无 AbortController）、审批等待靠超时释放——随 OPT-15 上下文对象根治 |
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
| OPT-13 | 统一 ToolResult 结构化状态（先三工具试点） | 🔶 试点 run_tests/diagnostics/workflow 三工具（status/text/data，工作流/审计/SSE 共用显式状态）＋**第二批 7 个只读工具**（read_file/glob/grep/list_dir/git_status/git_diff/process_list——内容驱动误判修复）＋**第三批 7 个状态读取/内容透传工具**（task_get/task_list/task_output/memory/list_mcp_resources/read_mcp_resource/prompt_from_file——内容透传误判与 not-found 缺口）＋**第四批 7 个校验/查找缺口工具（2026-10-20）**：skill_tool/todo_write_tool/task_create_tool/task_stop_tool/cron_delete_tool/process_kill_tool/agent_tool——Skill/Task/Cron/PID/Agent 七类失败文本获显式 error、task_stop 幂等停止锁定为 ok。累计 **24/53**；其余 29 工具仍走旧字符串兼容。实现与验收见文末 |
| OPT-14 | 统一文件访问门（内建状态路径过真实路径校验） | ✅ internalStatePath/managedWorkspacePath 统一校验产品状态目录、会话、备份、MCP、skills、memory、todos、summaries、审计和工作区状态文件；junction/symlink 越界 fail-closed。普通用户文件仍走 sanitizePath，取消契约留 OPT-15 |
| OPT-15 | 统一取消契约（上下文对象） | ⬜（A2-06 根治） |
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
| ⬜ | T22-06 | High／确认 | **贯穿取消与截止时间**：主/轻/摘要/子代理模型、重试、审批和工具共享取消；断连立即撤销待审批，执行前再次检查；主动关闭上游。取消后不得再开始写入/启动进程，旧执行结束后才释放执行门，下一任务能继续。 | R1 H03；R2 C02；OPT-15、A5、A2-06 |
| ⬜ | T22-07 | High／确认＋风险 | **统一进程树所有权与退出清理**：覆盖普通命令、后台 task、cron、MCP、持久 shell、调试；超时/取消/正常退出树杀并确认结果；明确 one-shot 后台任务语义。删除运行中 cron 不能丢句柄；强杀后重启可诊断残留。保留 cron running 防重叠。 | R1 H04、M08；A10、NEW-2；与 T22-06 联动 |
| ✅ | T22-08 | High／确认＋风险 | **串行化交互审批并修 REPL 等待**：2026-10-23 第三批落地单一 CLI 问题队列，EOF/close 结算全部问题、取消结算对应问题；审批和询问用户共用输入分派。任务在首个 await 前占位并取走草稿，BTW 按草稿排队，后续输入进入下一草稿，clear 后旧回调不污染新草稿。Node13 新回归20/20＋既有btw-eof 1/1，均单次；真实Win7终端待验收，HTTP活动取消仍属T22-06。 | R2 N01；R1 M10；D6；提交5149903 |
| ✅ | T22-09 | High／确认 | **下载替换不先删原文件**：2026-10-23 第四批移除目标 unlink；独占打开唯一临时文件，等 close＋fsync，严格完整旧版备份发布后单次 rename 覆盖，失败不删目标；复用有保留上限的 /undo 恢复。Node13故障专项获准复跑41/41，既有下载6/6；提交边界骤停及新进程恢复通过，实Win7/占用/断电仍待验收。 | R1 H07；AST-05；提交7ce82f9 |
| ✅ | T22-10 | High／确认错误路径 | **文件编辑编码止损**：2026-10-23 第五批对读/提示词文件/写/追加/编辑/notebook实施UTF-8可逆检查，拒绝不支持的字节与NUL，不猜测GBK；保留BOM及单一换行风格。现存文件写入统一完整严格备份，失败阻断；恢复时间戳顺序保护。Node13专项46/46、既有读取/保留6/6，均单次。普通文本写入仍可能部分失败，需undo恢复；实Win7/字节编码歧义见第五批边界。 | R1 H08；A2 的 chcp 修复不覆盖文件编码；提交f2e9409 |
| ✅ | T22-11 | High＋Medium／确认 | **统一模型继承与请求路由**：2026-10-23 第六批区分显式/默认辅助模型，以不可变上下文固定选定主/轻/摘要及端点/密钥，贯穿子代理、workflow、审批、压缩、摘要等；设置热切换作用于新执行，在途及其摘要保留原路由。严格双端点专项获准复跑33/33，流/压缩31/31；实Win7与真实模型待验收。 | R1 H09；R2 N06；OP5-4、DS-2、多模型路由；提交c86614b |
| ✅ | T22-12 | High／高可信风险 | **处理 MCP/持久 shell 管道故障**：2026-10-23 第七批补stdin/stdout/stderr错误、EOF/close结算、幂等退役及缓存身份校验；覆盖Node13缺stdio的异步spawn失败，不缓存失败会话；MCP双向4MB帧、shell采集8MB/单活动命令；超时/失败明确结果未知，不重放。专项首跑28/28，补边界后经用户允许仅复跑一次30/30（均无跳过）；既有MCP8/8仅首跑。Win7原生EPIPE及进程树停止仍待实机/T22-07。 | R1 M07／R2 C03；GAP-1/GAP-2；不含已撤回的 .cmd 断言 |
| ⬜ | T22-13 | High／数据风险 | **关键状态可靠落盘与损坏恢复**：todos、session、models、`.env`、记忆/工作日志等采用可靠替换和上一版本；解析失败隔离原件并告警，不能静默当空后覆盖。磁盘满、占用、提交中断后可恢复完整版本。与下载提交协议共享经验，不削弱路径检查。 | R1 H10；GAP-6 的「损坏自动重建」不能当成数据保全 |

P0 中 T22-03 属交付条件，T22-01 属验证前置；没有把二者伪装为新增代码崩溃。若某能力明确禁用，只能关闭对应受限发布门槛，原问题仍保留待修。

### P1：长期运行稳定性与状态一致性

| 状态 | ID | 严重程度／证据 | 待办与完成条件 | 来源／既有项 |
|---|---|---|---|---|
| ⬜ | T22-14 | High／数据风险 | **建立工作区多实例协调**：明确单实例或写锁策略；身份/陈旧锁可恢复，不只判断 PID 存在；阻止 CLI、不同端口服务并发覆盖同一状态。两个实例修改不丢数据，异常退出后可再次启动。 | R1 H10 多实例部分；依赖 T22-13；不等于重开多用户并行产品设计 |
| 🔶 | T22-15 | High／高可信风险 | **在采集处限制内存**：T22-12已补shell每次8MB采集/单活动命令、MCP每帧4MB；其余后台任务/调试输出、总并发/总字节预算、MCP待发积压、大文件窗口仍待实施。不能以单帧限制等同全进程内存有界。 | R1 H06；C8；10-23第七批仅完成局部 |
| ⬜ | T22-16 | High风险＋Medium确认 | **有界摘要队列与聊天准入**：流式 DONE 后摘要不占核心执行门；后台队列有数量/字节/队龄/截止时间及过期合并策略；取消的排队请求可移除。不能把 M01 简单改成追加到无界 summaryChain。慢摘要时主任务可继续且积压受限。 | R1 M01；R2 N04；AST-R1，AST-15 串行主任务语义保留 |
| ⬜ | T22-17 | High／确认＋风险 | **隔离 HTTP 持久 shell 状态**：shell 归属真实后端会话；新建/恢复/结束时正确释放，cwd/env 不跨对话或不同子代理串扰。身份协议未定义前可先禁用 HTTP persistent。 | R1 H05；OPT-16、GAP-2、A2-14；不要求取消请求门串行 |
| ⬜ | T22-18 | High／确认＋风险 | **修 auto_debug 生命周期与终态**：记录 spawn/exit/close/code，避免按过期 PID 杀其它进程；失败不报 OK；桌面操作确认目标窗口与焦点；取消贯穿 fixer，限制递归再入。可靠前默认禁用/明确限制；静默 exit1、spawn失败、仍有错误、焦点丢失都有真实结果。 | R1 H11；R2 重大疑点4；A2-09、C1/C3 |
| ⬜ | T22-19 | Medium／确认 | **会话保存与失败历史完整性**：保存有 dirty/最新快照补存、失败可见、容量一致；保存 failed/cancelled 回合、部分正文及已完成副作用；活动按回合保留，手动/自动恢复一致。慢保存、413/500、停止后刷新不能静默丢最新状态。 | R1 M03/M04；OPT-16、A2-12；不自动重开 OPT-6 多客户端保存设计 |
| ⬜ | T22-20 | Medium／确认 | **继续收口权威工具状态**：先修 agent 失败仍为 ok，以及 Worktree/Fetch/MCP external/Synthetic/Screenshot/schedule 等已列前缀缺口；成功命令保留 stderr/exitCode；再分小批迁移余下工具，保留内容透传语义。必选失败步骤不执行后续写入。 | R1 M05；OPT-13 仍为24/53；A2-07、10-20 主动留下的 Worktree 缺口 |
| ⬜ | T22-21 | Medium／确认 | **统一有效权限、审批展示与生命周期**：执行前复核 mode/cancel；界面反映 --danger 强制项；收到成功审批响应才显示批准；工作流展示真实嵌套 steps/参数再继承批准；停止/切会话 dispose 审批倒计时。denial切换、迟到审批、400/401、具体命令预览均有验收。 | R1 M09/L05；R2 N05；P0-3/P2-12；取消实现复用 T22-06 |
| ⬜ | T22-22 | Medium／确认＋风险 | **启动失败与 dream 恢复闭环**：初始化与 ready 分离；顶层失败非零退出并清理；dream 不无期限阻塞服务就绪；interaction 覆盖 HTTP；锁原子获取、owner/finally 释放、陈旧恢复。模型离线/目录不可写/重启均不留下假活服务。 | R1 M12；A2-08、A10 |

### P2：近期补齐

| 状态 | ID | 严重程度／证据 | 待办与完成条件 | 来源／既有项 |
|---|---|---|---|---|
| ⬜ | T22-23 | Medium／确认 | **内部工具复用随包运行时**：JS 调试使用 process.execPath；自动测试识别 Node13 能力，不默认选择 node --test；npm/Git/Bash/Python/csc/tsc/eslint 按功能预检。无开发机 PATH 时基本功能正常，缺依赖有准确说明。 | R1 M02 |
| ⬜ | T22-24 | Medium／确认编码路径 | **PowerShell 输入输出编码闭环**：脚本用 BOM 或 EncodedCommand；输出明确编码后解码；CP936 下中文内容、路径、错误输出不乱码。保持 PS2 兼容。 | R1 M06；A2/chcp 只解决部分命令 |
| ⬜ | T22-25 | Medium／确认 | **修盘符/共享根目录包含判断**：正确处理根目录尾分隔符、大小写与不同卷；保留 real-path/junction fail-closed。根目录与普通工作区的状态/文件工具均正确，外指仍被拒。 | R1 M11；OPT-14 已完成访问门，不等于所有路径边界正确 |
| ⬜ | T22-26 | Medium／确认＋风险 | **磁盘保留与会话历史策略**：为 snapshot refs、Web会话、截图、background/BTW/TODO日志设时间/总字节策略；CLI/Web 不按文件名前缀误删对方历史；会话列表可分页/索引。保留现有审计轮转、每源5/全局200备份，不重复实现。 | R1 M14；GAP-12、OP5-5、C8 |
| ⬜ | T22-27 | Medium／确认 | **修 Markdown 语言属性转义**：使用 DOM 属性赋值或有限字符规则，含引号的 fenced language 不能改变 HTML 属性；普通 c++/c#、未闭合围栏仍正确。 | R1 M15；A2-04 只修错误气泡，不应反向宣布其修复无效 |
| ⬜ | T22-28 | Low／确认 | **修 git status 首行 trim**：保留 XY 前导空格；同时修正锁定错误 staged/modified 结果的测试；覆盖首项仅未暂存、已暂存与 MM。 | R1 L01；DS-4/P2-11 的分列修复保留，补首行边界 |
| ⬜ | T22-29 | Low／确认 | **统一 memory 自动写路径分隔符**：Win7 下 `.7coder/memory/*.md` 正确匹配声明的例外；protected/deny 仍有效。 | R1 L02；GAP-9 |
| ⬜ | T22-30 | Low／确认 | **修搜索输入与扫描预算**：grep 支持文件路径或明确拒绝，不能伪装无匹配；glob 按实际访问条目计预算，区分预算耗尽/无匹配。 | R1 L03；P2-3、A2-20 的已有保护保留 |
| ⬜ | T22-31 | Low／潜在风险 | **cron ID 唯一**：固定时钟下同毫秒创建两个 job 不覆盖 Map，不丢 timer，二者可独立删除/回收。 | R1 L04；NEW-2 不因新增ID问题重开 |
| ⬜ | T22-32 | Improvement | **补最低运行诊断**：记录当前运行/排队、最后成功/错误、关键 errno/路径/child exit；故障日志有限额。完整 runId 架构与跨会话提交统计仍留 OPT-3/DS-13 暂缓，不借此启动大拆分。 | R1 日志/长期运行章节；R2 N04；DS-13/OPT-3 |
| ⬜ | T22-33 | 工程验证缺口 | **修测试假阳性与证据口径**：信息项/skip 不记行为 PASS；D 路径表按调用ID核验；修 pshell 的10s/15s错误超时条件、stderr标记预览假命中、MAX_TOOL_STEPS=0弱断言、K/R未验证真实workflow/第二模型、配对只看role、mock错序填充。每个断言证明其声明的行为；避免仅增加数量。 | R1 §10.3；R2 N01/N02/N03测试缺口；OPT-8/OPT-17既有覆盖不全部撤销 |

### V22：验证与发布门槛（均未执行）

以下是有限、分阶段的验收任务；代码修复所需局部反例优先并入对应 T22，不再另立重复 Bug。V22-01/02/03/05/06/07/08 是相关 Win7 长期运行版本的交付门槛；V22-04 按启用能力验收。

| 状态 | ID／优先级 | 验证范围与通过条件 | 依赖／对应来源 |
|---|---|---|---|
| ⬜ | V22-01／P0 | **干净 Win7 SP1 x64**：PS2/CLR2、无系统Node/npm、普通用户与管理员、双击/CLI、中文/空格/盘符根工作区；确认真正 ready、失败退出码、DLL/补丁与浏览器前提。Node13在现代Windows运行不能代替此项。 | T22-02/03/23/24/25；C5；R1 Win7专项、R2重大疑点1 |
| ⬜ | V22-02／P0 | **真实目标浏览器＋实际后端＋物理断外网**：本地模型聊天/工具/审批/停止/重发/保存/恢复、无隐式在线资源；关键API缺失显示明确原因。不能仅用UI fixture替代后端。 | T22-03/06/19/21；OPT-17已有浏览器测试仍有价值 |
| 🔶 | V22-03／P0 | **核心负向时序**：T22-04/05/08/12已有坏SSE恢复、摘要/20K、双保护读取、管道结算/旧对象身份等局部证据；模型/重试/审批/工具各阶段活动取消与零迟到副作用仍待T22-06等验收。 | T22-04/05/06/08/12；R2新增High；10-23第二/三/七批 |
| ⬜ | V22-04／P1 | **启用能力专项**：记录双模型主/子/辅助调用路由；MCP断stdin/超时/重连；持久shell跨对话cwd/env；cron删除/超长间隔/重叠；auto_debug spawn/exit/焦点/取消/再入。危险桌面场景仅在受控环境。 | T22-07/11/12/17/18/31；C1/C3/C6、GAP-4（启用视觉时） |
| ⬜ | V22-05／P0 | **进程树与第二次启动**：三层心跳/文件锁/端口探针，覆盖超时、停止、/bye、Ctrl+C、关窗口、one-shot、父强杀、注销/关机；无未知残留，或下次启动可识别并恢复；不能只检查父PID退出。 | T22-06/07/14/22；R1 H04/M08 |
| 🔶 | V22-06／P0 | **数据完整性故障注入**：T22-09/10已完成本地下载提交与编码矩阵、备份失败及部分写恢复的定向证据；尚须关键JSON/配置写中断、真实磁盘满/只读/占用、双实例、Win7与断电验收。不能以本地注入替代整项发布验收。 | T22-09/10/13/14/19/24；R1 H07/H08/H10；10-23第四/五批记录 |
| ⬜ | V22-07／P0（最后执行） | **从最终固定源码重建实际ZIP并验收**：更新build identity，清单/哈希与源码对应；包含所需修复，零真实.env/测试残渣、运行时/依赖齐全；在解压包上完成冒烟及关键验收。现有同版本ZIP不能当当前源码证据。 | R1 M13；10-17 ZIP早于10-20迁移；依赖拟发布范围内的T22完成 |
| ⬜ | V22-08／P1（长期版发布门槛） | **24h→72h真实工作量**：限制队列/输出预算后，记录RSS、句柄、子进程、磁盘、排队年龄与最后成功；含慢摘要、模型断连恢复、连续会话/大输出。确认增长有界且不假活；更高并发限流按实际负载验证。 | T22-15/16/26/32；C7/C8；短24任务RSS不能关闭此项 |

### 待验证风险：先确认，不作为已复现 Bug

| 状态 | 疑点与处理方式 | 归属，避免重复计数 |
|---|---|---|
| ⬜ | grep 歧义分支如 `(a\|aa)+$` 是否仍阻塞事件循环；只在隔离进程＋严格时限中验证，确认后补修复项。 | R1疑似1；T22-30的扫描计数修复不等于regex预算已完成 |
| ⬜ | 截图/open/MCP批处理的特殊字符路径与参数；分别检查Node13与现代Node fallback。不得恢复「绝对路径.cmd必然启动失败」断言。 | R1疑似2、R2 C01；V22-01/04 |
| ⬜ | UNC/网络盘断连、cmd cwd、提权后映射盘可见性；若不支持，应明确部署限制。 | R1疑似3；V22-01/06 |
| ⬜ | audit轮转目标占用、download writer错误/关闭与HTTP body销毁组合，观察真实句柄而非只看catch。 | R1疑似5；T22-09/26、V22-06 |
| 🔶 | SSE reject/close-only已由T22-04提供结算/销毁证据；MCP/shell旧对象退出删新缓存已由T22-12验证并修复；auto_debug再入的实际可达性仍待查。 | R1疑似6、R2重大疑点2/3/4；T22-04/12/18、V22-03/04 |
| ⬜ | 历史受限环境5条断言逐项对账；无法对应时保持未验证，不能用另一环境全绿替代。 | ISSUES-LOG 10-04/10-11验证备注；按实际部署相关性定向核验 |

### 历史状态与报告修正：本次已做的文档归并

| 对象 | 当前采用的口径 |
|---|---|
| R1 M07 的绝对路径 .cmd 判断 | 按 R2 C01 撤回泛化断言，不列修复待办；管道异常与缓存竞争已由T22-12修复，进程树停止仍属T22-07。历史报告保留原文以便追溯。 |
| R1 Critical 与 --help 证据 | 按 R2 C04/C05：Critical 不要求所有部署触发；--help不证明dotenv初始化。本清单没有新增Critical或扩大既有验证结论。 |
| A5/A2-06/OPT-15 | 既有取消接线视为历史已做；活动取消、迟到审批与副作用截止仍未完成，合并到T22-06；不能把A5旧✅理解为完整取消已验收。 |
| OPT-13／10-20第四批 | 24/53迁移保持部分完成；参数校验失败获error不等于agent运行失败获error，余量及M05归T22-20，不重做已完成的24个工具。 |
| OP5-4／多模型路由 | 启动回落保留；2026-10-23 T22-11已补热切换继承、执行路由快照与子代理模型传递，原缺口由第六批证据关闭；并非重新宣称旧启动测试覆盖全部路由。 |
| GAP-2/A2-14、A2-12/OPT-16 | /clear清shell与页面sessGen已做；HTTP身份隔离与保存最新快照未做，分别归T22-17/19。 |
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

## 维护约定

1. **唯一事实来源**：本文件。修复某条后：改状态列 + 附提交号；新问题追加到当日期小节；跨日期的大问题可新建日期小节用 INC-/NEW- 编号。
2. **提交纪律**：状态变更与对应代码修复同一提交；提交信息引用条目号（如 `fix(P1-1): ...`）。**跨号联动（2026-10-03 增补）**：当以新编号（DS-/AST-/OPT- 等）修复的问题在旧表有同源行时，必须在同一提交内回翻旧行状态——2026-10-03 盘点发现 11 行"账实不符"正是只记新区块、漏翻旧行所致。
3. **归档（OPT-9 已执行 2026-10-02）**：KNOWN-ISSUES.md、REVIEW-CHECKLIST-2026-09-30.md、deepseek4.1flash审阅.md 已移入 `docs/history/`，只读历史快照，不再更新。
4. **套件计数防漂移（OPT-10 已执行 2026-10-02）**：`scripts/count-assertions.js --write` 回填头部标记段；实测通过数在规模快照行手写，两口径并列标注。
