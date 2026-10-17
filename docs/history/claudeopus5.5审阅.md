# Claude Opus 5.5 审阅（2026-10-16）

审阅基于提交 `67f1ada`。项目运行在内网环境，安全类问题按决定不在本次处理范围内，本文只记录其它问题。

## 1. 测试结果

| 运行方式 | 结果 |
|---|---|
| `node scripts/test-all.js`（runner A–J、webui-ui-sim、webui-dom-sim） | 全部通过，exit=0（A 85/85，B 312/312，C–J 全部通过） |
| `npm test`（即 `node test/runner.js`，会读取本地 `.env`） | 78/82，4 项失败 |

失败项：

- `adv: auto_debug disabled message`
- `net: approval shows real diff preview`（`editnet` 场景随之崩溃：`app.txt` 不存在）
- `http: GET /v1/models 401 without key / 200 with list when keyed`

## 2. 问题列表

### 2.1 `test/runner.js` 未隔离本地 `.env`

- 现象：本地 `.env` 中的 `PERMISSION_MODE=auto`、`ENABLE_AUTO_DEBUG=true`、`HEAVY_MODEL=qwen3.7-plus` 会进入测试进程，导致上面 4 项失败。把这三项改为默认值后重跑，85/85 全部通过。
- 原因：`scripts/test-all.js` 的 `loadBaseline()` 会用 `.env.example` 覆盖环境变量，并强制 `ENABLE_AUTO_DEBUG=false`；单独运行 `test/runner.js`（以及其它 runner）时没有这一步。
- 建议：把 `loadBaseline()` 的逻辑移到 `test/_shared.js`，让每个 runner 启动子进程时都使用同一份基线环境。

### 2.2 `index.js` 单文件过大

- 5391 行、约 279KB，工具实现、HTTP 路由、REPL、记忆、会话等全部在一个文件里。
- 建议优先拆出 `startHttpServer`（[index.js:4475](../../index.js)）和 `executeToolRaw`（[index.js:2178](../../index.js)），这两部分体量最大、边界也最清楚。

### 2.3 HTTP 路由结构

- 所有路由都由连续的 `if (req.method === ... && req.url === ...)` 组成，缩进前后不一致（`/api/todos` 之前与 `/v1/models` 之后的缩进层级不同）。
- 鉴权判断 `if (HTTP_API_KEY && req.headers.authorization !== ...)` 在每个路由里各复制了一遍，新增路由时容易遗漏。
- 建议：改为路由表（method + url → handler），鉴权抽成一个公共函数统一调用。

### 2.4 默认模型过时

- `LIGHT_MODEL` 默认值为 `'gpt-3.5-turbo'`（[index.js:123](../../index.js)），`SUMMARY_MODEL` 也继承这个值。建议更新默认值，或在未配置时直接使用 `HEAVY_MODEL`。

### 2.5 `7CODER.md` 自动日志不去重

- 自动日志区段中有 10 条内容几乎相同的"项目概述"条目。
- `updateCompleteSummary`（[index.js:4304](../../index.js)）每次直接追加，没有去重或条数上限，文件会持续增长。
- 建议：追加前与最近若干条做相似度比较，或限制保留条数。

### 2.6 仓库整洁

- 根目录有一个空目录 `-p`，推测是在 Windows 上误用 `mkdir -p` 留下的，可删除。
- `.workbuddy/` 未被 git 跟踪，也未加入 `.gitignore`。

## 3. 建议处理顺序

1. 2.1 测试环境隔离（影响日常 `npm test` 结果的可信度）
2. 2.6 仓库清理
3. 2.5 自动日志去重
4. 2.4 默认模型
5. 2.3 路由表与公共鉴权函数
6. 2.2 拆分 `index.js`
