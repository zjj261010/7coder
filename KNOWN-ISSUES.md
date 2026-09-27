# KNOWN ISSUES & PENDING DECISIONS

> 生成于 2026-09-27，末次核对同日。依据：最初代码审阅 + 八轮多维测试 + 一轮修复审计（套件 A-H 共 281 项断言，Node 24 / Node 13.14.0 双运行时全绿，axios 已升级至 1.20.0）。
> 已修复问题不在此列，见 git log。2026-09-27 逐项复核：下列 A/B/C/D 各项状态与当前代码一致（A1/B1 已于本日关闭，见下），无已被顺带解决而未更新状态的条目。

## A. 未修复的已知缺陷

> 2026-09-27 修复审计（三子代理核验历轮修复）已额外修复并回归：junction 深度守卫绕过（fail-closed）、
> `.mcp` 基址词法比对、备份 mtime 继承（copyFileSync 保留源时间戳 → 触碰为创建时间）、
> 关闭 readline 上 rl.question 永久挂起（askApproval/ask_user 守卫）、/btw 粘贴竞态、
> dream 异常吞噬任务、env 负值下限、压缩死区与零进展循环、流式断连崩溃风险（res.close 跟踪）、
> 解析器 flag 吞并、遍历跟随外链（linkStaysInside）、worktree 路径沙箱、截断标记防误写指引。

| # | 问题 | 影响 | 现状 / 建议 |
|---|------|------|------------|
| A1 | ~~axios 0.21.4 存在 CVE-2023-45857~~ **已关闭**（B1 验证通过：axios 1.20.0 在真实 Node 13.14.0 上 9/9 API 面探针全过——POST/超时/流式 SSE 含跨块 CJK/错误形状/ECONNREFUSED；272 项回归无破坏。依赖升级至 ^1.20.0，node_modules 传递包由 2 增至 25，G 套件供应链断言改为校验"index.js 仅 require axios+dotenv+内置模块"） | 安全 | 已解决 |
| A2 | ~~外部命令输出的 GBK 中文乱码~~ **已关闭**（子进程会话前置 chcp 65001，实测 14→0 个 U+FFFD，零依赖，不影响 POSIX） | 体验 | 已解决 |
| A3 | ~~`--background` 模式输出全部丢失~~ **已关闭**（子进程 stdout/stderr 指向 .7coder/background.log 追加写入并带运行头部；同时以 flushExit 修复 Windows 上 process.exit 截断缓冲输出的一般性问题） | 可观测性 | 已解决 |
| A4 | ~~子代理会话永不压缩~~ **已关闭**（切分点放宽为“非 tool 角色”边界——assistant 可作切分起点且配对合法；Suite F subagent-long 正向断言子代理内压缩触发且上下文有界） | 已解决 |
| A5 | ~~HTTP 客户端断连后上游处理继续空跑~~ **已关闭**（processWithTools 取消令牌在步骤/工具边界生效；断连后跳过摘要、不写 7CODER.md；F5b 断言验证） | 已解决 |
| A6 | ~~dream 整理与摘要机制互相打架~~ **已关闭**（摘要写入 <!-- 7coder:auto-log --> 标记节并原位重建；标记外内容——dream 成果、用户笔记——逐字保留） | 已解决 |
| A7 | ~~computer_use 鼠标/键盘为模拟 no-op~~ **已关闭**（Windows 真实输入：光标移动/点击经 user32 mouse_event + Cursor.Position，打字/按键经 SendKeys；临时 .ps1 避免引号地狱；实测光标移动后位置回读一致。非 Windows 平台返回警告） | 功能 | 已解决 |
| A8 | ~~审批经济性~~ **已关闭**（确定性风险分类+解释表覆盖常见工具，default 模式编辑审批零额外轻调用；无规则工具仍回退轻模型） | 已解决 |
| A9 | ~~Ralph 循环复用 MAX_RETRIES~~ **已关闭**（新增 RALPH_ITERATIONS 独立配置，默认回退 MAX_RETRIES；注意 A9 提交曾引入 TDZ 启动崩溃，已在 A10 提交中热修） | 已解决 |
| A10 | ~~/bye 遗留~~ **已关闭**（退出时停止 cron 定时器+击杀在途 cron 命令、拒绝关机中新任务、删除 dream 锁） | 已解决 |
| A11 | ~~glob/grep 仅匹配文件名~~ **已关闭**（glob_tool 支持目录感知：`src/*.js`、`src/**/*.js`、`**/*.test.js`；`*` 不跨目录、`**` 跨目录且可匹配零段；无分隔符模式保持按文件名任意深度匹配的既有行为。grep 的 pattern 是正则内容匹配，本来就与文件名无关） | 功能 | 已修复并回归（Suite H glob-dir：15 项单测 + 7 项端到端） |
| A12 | **解析器怪癖**：`--prompt ""` 静默进 REPL；未知 flag 及其值并入任务文本；词序重排（`file.js --prompt fix it` → "fix file.js it"） | 体验 | 两遍解析的既定设计；如需严格模式另立 issue |
| A13 | ~~HTTP 客户端 content 非字符串时字面化为 "[object Object]"~~ **已关闭**（改为 JSON.stringify 回退） | 已解决 |

## B. 待决策事项

| # | 决策点 | 选项 / 备注 |
|---|--------|------------|
| B1 | ~~axios 升级~~ **已关闭**：实测通过并升级至 ^1.20.0（证据见 A1） | ~~先在 Node 13.14.0 实测 axios 1.x 再定~~ 完成 |
| B2 | dotenv 升级 | 8.x 不剥行内注释（已在 .env.example 用文档规避）；9+/16+ 行为不同 |
| B3 | 被移除工具的路线 | workflow_tool（建议 JSON 步骤解释器而非 eval）；remote_trigger_tool（需先定隐私边界）；send_message_tool（需先做持久代理）；monitor_tool（低价值）；mcp_auth_tool（依赖完整 MCP 协议栈）；team_*（建议并入 agent_tool 扇出参数） |
| B4 | exit_worktree_tool 与路径沙箱冲突 | "进入工作树"语义 = 切换沙箱根，需整体重设计，非补一个工具 |
| B5 | npm 发布 | README/安装名仍为原作者的 @nodemixaholic/7coder；自有包名/是否发布待定 |
| B6 | 运行时 emoji | 已全部移除（Win7 GBK 兼容）；README 保留排版字符（决策：保留，渲染场景不受影响） |

## C. 测试盲区（自动化未覆盖）

| # | 盲区 | 原因 |
|---|------|------|
| C1 | auto_debug_tool 完整循环 | 单轮最少 2 分钟 × 修复轮次；其组件（spawn/taskkill 树杀/子会话修复）已被分别覆盖 |
| C2 | web_search_tool 真实外网、web_browser_tool 真实外网站点 | 保持离线确定性；本地 HTML/图片 fixture 已覆盖解析路径 |
| C3 | computer_use 真实截屏 | 仅在真机手动验证过一次；自动化无法断言屏幕内容 |
| C4 | macOS / Linux 分支 | 本机 Windows；平台分支代码从未在真实非 Windows 环境运行 |
| C5 | 真 Win7 硬件 | 以 Node 13.14.0 运行时做等价验证；无法覆盖驱动/代码页/权限差异 |
| C6 | 超长 cron（>24.8 天分段续期） | 只验证了排期计算与短周期实际触发 |
| C7 | 大规模并发（>6 并发 HTTP） | 已验证 6 并发零串扰 |
| C8 | ~~内存泄漏~~ **已关闭**（Suite H rss-soak：24 任务 RSS 采样，无失控增长） | 剩余：仅验证短会话；数小时级 soak 仍未测 |
| C9 | 压缩按字符数近似 token | 非精确 tokenizer 估算 |

## D. 功能路线候选（来自评估，未排期）

按建议顺序：
1. Git 集成（diff/commit/stash 感知、编辑前 stash 保护）
2. 测试运行器集成（解析 npm test/pytest 结构化 pass/fail，替代 grep error）
3. LSP 客户端（纯 JS 可行，Win7 上 typescript-language-server 可跑；周级工程）
4. 会话跨进程持久化与 /resume（当前仅 7CODER.md 摘要播种）
5. 结构化审计日志（JSONL 动作记录，机器可读、可回放追责）
6. 并行工具调用 / 后台子代理（当前严格串行）
7. per-project 配置（当前 .env 仅在安装目录）

## E. 测试资产现状

- 套件：A 基线 73 项（`npm test`）、B 故障注入/对抗 39（`npm run test:b`）、C 并发/逃逸/cron 35、D 沙箱酷刑/视觉 32、E 流式 UTF-8/模糊 22、F 性能/E2E/schema 20、G 命令面/差分 oracle 26、H 交互组合/RSS/静态审计 + audit-fixes 25——合计 **272 项/运行时**
- 全部支持 `NODE_BIN=<node13>` 换运行时、`RUN_ONLY=场景名` 筛选；均以 mock LLM 端点离线运行
- 八轮测试 + 一轮修复审计累计发现并修复的产品缺陷详见两个 fix 提交（f4a6e4a、4541da0）的提交说明
