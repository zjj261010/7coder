# 7coder 项目审阅清单（问题与优化建议）

> 生成于 2026-09-30。审阅范围：`index.js`（全 3105 行）、`webui.html`、`scripts/pack-offline.js`、
> `test/`（runner.js 及 runner-b~r、mock-server.js）、`README.md` / `INSTALL.md` / `KNOWN-ISSUES.md` /
> `.env.example` / `package.json` / `.gitignore` / `.npmignore` / `7coder.bat`、git 历史与 `dist/` 打包产物。
> 与 KNOWN-ISSUES.md 不重复：以下均为**本次新发现**或**既有条目状态已过时**的项。

---

## P0 — 严重（崩溃 / 安全 / 功能静默失效）

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P0-1 | `test/runner.js:6` 及同款 ×9（runner-b/c/d/e/f/g/h/i/j.js） | **`rmrf` 自递归 bug**：`if (fs.rmSync) rmrf(p, {...})` 调用的是自身而非 `fs.rmSync`，无限递归至栈溢出后被 try/catch 吞掉。Node ≥14.14 上工作目录清理**静默无效**，靠 freshCwd 的唯一后缀兜底（`test/w-h-h8b` 残留 87 个 .bak 即证据）。Node 13 走 `rmdirSync` 分支反而正常，runner-k.js:31 已是正确写法。 | 全部改为 `fs.rmSync(p, { recursive: true, force: true })`（保留 Node 13 回退分支），并为该 helper 加一条"目录确实被删除"的断言 |
| P0-2 | `index.js:662` | **cron `every 0h` 同步无限递归崩溃**：秒档有 `Math.max(1000,…)`、分钟档有 `Math.max(60000,…)`，唯独小时档无下限 → `ms=0` → `armNext` 中 `remaining≤0` → `runCommand(); scheduleNext()` 同步互调直至栈溢出，进程崩溃且无捕获。 | 小时档加 `Math.max(3600000, …)`，并在 `parseSchedule` 对 `ms<=0` 一律返回 null；补一条 `every 0h` 被拒绝的断言 |
| P0-3 | `index.js:2146, 2984, 3003` | **HTTP 审批桥是全局单例，并发串扰**：`httpApprovalBridge` 模块级共享——两个并发流式客户端时后者覆盖前者；任一请求结束即 `= null`，会摘掉另一请求的桥，审批请求丢失或串线（`pendingApprovals` 亦为全局）。C7 的"6 并发零串扰"未覆盖审批路径。 | bridge 改为按请求创建、经 `processWithTools` 的 opts 传入；`pendingApprovals` 按连接隔离；补并发审批测试 |
| P0-4 | `index.js:2827`（`GET /api/settings`） | **明文下发 `apiKey`**：未设 `HTTP_API_KEY` 时（默认），本机任意进程（含恶意网页经 DNS rebinding 访问 loopback）可读取上游 OpenAI 密钥。 | 默认只返回 `apiKeySet` 布尔 + 掩码（`sk-…尾4位`）；完整密钥不下发，保存时"留空=不修改"；文档说明 |

---

## P1 — 中（真实 bug / 数据与文档不一致）

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P1-1 | `index.js:1712-1716` | `run_tests_tool` 输出含字面 `'\n'`：双引号字符串里嵌了单引号换行符（`"...summary.'\n'Output tail:'\n'"`），用户看到的是字面文本而非换行。 | 改为真换行拼接；补一条输出格式断言 |
| P1-2 | `index.js:2611` vs `webui.html:610` | Web UI 右上角恒显 **"v?"**：前端读 `info.version`，但 `/api/info` 未返回 `version` 字段。 | `/api/info` 增加 `version`（从 package.json 读取并缓存） |
| P1-3 | `webui.html:606-609, 737-750` | 模型选择持久化**只读不写**（`localStorage '7coder-model'` 从无 setItem）；权限模式下拉框不回显当前 `info.mode`。 | `modelSel.change` 时 setItem；`refreshInfo` 中 `modeSel.value = info.mode` |
| P1-4 | `index.js:2813-2820`（`writeWorkspaceEnv`） | Web UI 保存全局设置时 `dotenv.parse`→重新序列化整个工作区 `.env`，**所有注释与格式丢失**（`.env.example` 里"注释须独占一行"等说明文字一并消失）。 | 改为按行原地改写受管键（保留未知行与注释），或仅追加/替换受管键行 |
| P1-5 | `index.js:124,125,134` vs `.env.example` / `INSTALL.md` | 代码默认值与文档三处不符：`HTTP_PORT` 8000 vs 7103；`MAX_TOKENS` 2048 vs 42000；`TEMPERATURE` 0.7 vs 0.6。 | 以文档为准对齐代码默认值（或反向修订文档），消除"不设 .env 时行为与文档不符" |
| P1-6 | `INSTALL.md:111-113` | 验证命令 `set RUN_ONLY=cli,strict` 与 runner.js 实际场景名（`cli-exit/oneshot/perm/security/fs-tools/adv-tools/context/editnet/http/startup`）**无一匹配** → 运行 0 个场景却 `0/0 passed` 退出码 0，**假绿**。 | 文档改为真实场景名；runner 在 RUN_ONLY 匹配为空时打印警告并非零退出 |
| P1-7 | `INSTALL.md:19,115` vs `KNOWN-ISSUES.md:86` | 套件数/断言数三处打架：INSTALL"10 个套件 334 项"；KNOWN-ISSUES"十一个套件 A-J 共 373 项"（列出 10 个却写"十一"）；实际存在 12 个 runner 文件（含 k、r）。 | 统一口径并写明统计方式（建议脚本自动汇总生成） |
| P1-8 | `README.md:23-32` vs KNOWN-ISSUES B5 | B5 已决策**不发布 npm**，README 仍保留 "Now on NPM!" 安装教程，自相矛盾。 | 移除或标注"原作者历史信息，本项目以离线 zip 分发" |
| P1-9 | `scripts/pack-offline.js:47` + `dist/` | ① `dist/7coder-v2.6.0-offline/` 与 package.json `2.16.0` 差 10 个版本，为陈旧产物；② `copyRec` 排除项 `e === 'w-'` 恒为假（应为 `startsWith('w-')`），且未排除 `cur-*.json` —— 现在重新打包会把测试残渣（87 个 .bak 等）打进发行包。 | 修正排除规则；删除或重打 dist；把"打包前测试目录必须干净"写成脚本前置检查 |
| P1-10 | `README.md:142`、`KNOWN-ISSUES.md:74-78` | **内联代码内容整段丢失**：README"(to ) - start the REPL with (or type )"；KNOWN-ISSUES"保存到 （仅 user/assistant 轮…跳过）。 启动参数或  命令载入"——反引号包裹的内容疑似被某次写入吞掉。D4 条目还重复粘贴了 3 遍。 | 补回丢失的 `` `.7coder/session.json` ``、`` `--resume` ``、`` `/resume` ``；删除重复的 D4 段落 |
| P1-11 | git `54d09d7` | 提交信息乱码："妯″瀷璁剧疆闈㈡澘"（GBK 当 UTF-8 写入）。 | 仓库配置 `git config i18n.commitencoding utf-8`；可视情况 `git commit --amend`（未推送时） |
| P1-12 | `index.js:1450`（`mcp_tool` 无配置分支） | 返回 `"[OK] … executed locally"` 但实际什么都没执行——与项目"移除假装工作的工具"的原则（README:108-110）相悖。 | 改为明确报错"未配置 MCP_SERVER_URLS / MCP_NPX_PKGS" |
| P1-13 | `index.js:524-534`（`isSuperDangerous`） | 误报与漏报并存：`'shutdown'`、`'rm -rf *'`、`'rmdir /s /q'` 子串会误伤常见良性命令；同时**无一条 PowerShell 模式**（`Remove-Item -Recurse -Force`、`Format-Volume`、`Stop-Computer` 等），`powershell_tool` 裸奔。 | 模式收窄（锚定路径/词边界），并为 PowerShell 增加危险命令表；新增"误报/拦截"双向断言 |
| P1-14 | `index.js:2562, 3123, 3308` | one-shot 任务失败时**退出码仍为 0**（catch 仅 console.error；`main().catch(console.error)` 不设 exitCode）——脚本化调用无法感知失败。 | 失败路径设 `process.exitCode = 1`（经 flushExit 退出） |

---

## P2 — 低（体验 / 整洁 / 性能）

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P2-1 | `index.js` 多处 | 工作区根目录污染：`.7coder_last_interaction`、`7C.dream.lock`、`BTW.md`、`TODO.md`、`screenshot_*.png`、`*.summary` 散落根目录。 | 收纳进 `.7coder/`（迁移时读旧路径兜底一次） |
| P2-2 | `index.js:1990` | 过时注释"computer_use input actions are simulated no-ops today"——A7 已实现 Windows 真实输入注入。 | 更新注释 |
| P2-3 | `index.js:619-653, 573-617` | `grepSearch` 整读文件（含二进制）、无大小/结果上限；`recursiveReaddir` 无深度上限，不跳过 `node_modules`/`.git` —— 大工作区下 glob/grep 又慢又占内存。 | 默认排除 `node_modules`/`.git`；单文件 >N MB 跳过；结果截断并提示 |
| P2-4 | `index.js:2345-2381` | `backupFile` 每次写文件执行 **两次** `pruneBackups`（写前+写后），每次都全量遍历备份目录。 | 保留写后一次即可；prune 结果可短缓存 |
| P2-5 | `index.js:2019` | 审计日志 `argsPreview` 原样记录参数前 200 字符——`run_command` 中的 `curl -H "Authorization: Bearer sk-…"` 之类会落盘。 | 对 `key/token/secret/authorization/password` 键与 Bearer 模式做脱敏 |
| P2-6 | `index.js:3054` / `2599-2607` | `server.listen` 无 `error` 处理（端口占用直接抛 EADDRINUSE 崩溃）；`webui.html` 每请求同步读盘。 | 加 `server.on('error', …)` 友好提示；HTML 启动时读一次缓存 |
| P2-7 | `test/mock-server.js:9`、`runner.js:51` | 测试工装 Windows 专属：`__dirname + '\\mock-log-'`、`ping -n 2 … >nul` 在 POSIX 失效——与"macOS/Linux 兼容"目标不符。 | 用 `path.join` 与跨平台 sleep |
| P2-8 | `README.md:197` | "no modern JS syntax used" 不准确（对象展开、无参 catch、async/await 均为 ES2018+）。 | 改为"语法不超过 Node 13.14 支持范围" |
| P2-9 | `KNOWN-ISSUES.md:3,27` | 头部"末次核对 2026-09-27"未随 09-29 内容更新；A12 称"`--prompt ""` 静默进 REPL 为既定设计"，但代码（index.js:56-59）已改为 fail-fast——条目状态过时。 | 更新日期与 A12 状态 |
| P2-10 | `index.js:1667-1670` | `parseTestOutput` 正则 `(\d+)+\s+pass` 嵌套量词（同类 4 处）。 | 改 `(\d+)` |
| P2-11 | `index.js:1736-1741` | `git_status_tool` 计数口径：`"M "`（纯暂存修改）同时计入 staged 与 modified，数字易误导。 | 明确口径（XY 分列统计） |
| P2-12 | `index.js:2991-2993` | Web 审批 120 秒无操作自动拒绝，UI 无倒计时提示，用户易困惑"为什么被拒绝"。 | webui 审批框加倒计时；超时值可配 |
| P2-13 | `index.js:1534, 1902-1940` | 截图 PNG 落工作区根且不清理；`auto_debug_tool` 最少 2 分钟/轮无进度输出。 | 截图进 `.7coder/`；debug 循环加进度行 |
| P2-14 | `scripts/pack-offline.js:40` | 打包脚本用 `fs.rmSync`（Node ≥14.14），但 README 未声明**打包机**需要现代 Node（目标机才是 13.14）。 | README/INSTALL 补一句打包机要求 |
| P2-15 | `index.js:1298-1304` | `ask_user_question_tool` 在服务器/非交互模式静默返回 "skipped"，模型可能误读为用户已作答。 | 返回文本改为强指令（"用户不可达，禁止假设回答，改为自行决策并在最终答案中说明"） |
| P2-16 | `webui.html:344-345, 400` | 死代码：`var keyOk`、`var sessionPath` 未使用；`.cursor` 样式被引用未定义。 | 清理 |
| P2-17 | `.npmignore` | 仅一行 `.env`；既已决策不发 npm，文件去留应明确。 | 删除或在 KNOWN-ISSUES 注明保留理由 |

---

## 优化建议（方向性）

1. **安全面**：
   - `/api/settings` 密钥脱敏（见 P0-4）；审计日志参数脱敏（见 P2-5）。
   - 未设 `HTTP_API_KEY` 时，对一切**写操作类** `/api/*`（settings/models-config/mode/sessions/save/delete/open/approve）默认拒绝或要求一次性确认，而不是仅靠 loopback 信任。
   - 危险命令表覆盖 PowerShell 方言（见 P1-13）。
2. **工程结构**：
   - `index.js` 3105 行单文件 → 建议拆分 `tools/`、`http-server.js`、`repl.js`、`security.js`、`context.js`，降低改动爆炸半径。
   - 10 个 runner 复制粘贴的公共件（rmrf/runCli/startMock/freshCwd）抽 `test/_shared.js`——P0-1 正是复制粘贴的代价。
3. **测试**：
   - RUN_ONLY 空匹配非零退出（见 P1-6）。
   - 为 P0-2（cron 下限）、P1-1（run_tests_tool 输出）、P1-4（.env 注释保留）补回归断言。
   - 清理 `test/` 残渣（~300 个 `cur-script-*`/`mock-log-*` 文件，含单个 5.2 MB 日志）；或 runner 结束时自清理。
4. **文档**：
   - 统一套件数/断言数（P1-7）；修复丢失的内联代码段（P1-10）；README 移除 npm 教程（P1-8）；KNOWN-ISSUES 头部日期与 A12 状态（P2-9）。
   - 建议每次发版用脚本从 runner 自动汇总断言数写入文档，杜绝口径漂移。
5. **功能**：
   - one-shot 失败非零退出（P1-14）；`/api/info` 带版本（P1-2）；webui 模型/模式持久化与回显（P1-3）。
   - 会话/审批按连接隔离后，可考虑真正支持多客户端并发（呼应 D6 并行只读工具）。

---

### 验收建议（修复后回归）

```bat
:: 1. 全量套件（双运行时）
set NODE_BIN=C:\path\to\node13\node.exe && node test\runner.js && node test\runner-b.js
:: 2. 新增断言：cron 0h 拒绝 / run_tests_tool 换行 / rmrf 真删 / settings 脱敏
:: 3. 打包前检查
node scripts\pack-offline.js --with-node  →  检查 zip 内无 w-*、cur-*.json、mock-log-*
```
