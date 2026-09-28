# 7coder 离线安装与使用说明

> 适用于离线分发包 `7coder-v2.6.0-offline-win64.zip`（Windows x64，含内置 Node.js 13.14.0 运行时）。
> 目标环境：Windows 7 SP1 及以上（也兼容 Win10/11、macOS、Linux）。全程无需联网、无需 npm install。

## 一、包内清单

| 路径 | 说明 |
|---|---|
| `index.js` | 主程序（唯一入口，零编译） |
| `runtime\node.exe` | 内置 Node.js 13.14.0 运行时（Win7 可用，MIT 许可，可再分发） |
| `node_modules\` | 预装的生产依赖（axios 1.20.0、dotenv 8.2.0） |
| `.env.example` | 配置模板（复制为 `.env` 后填写） |
| `7coder.bat` | 便捷启动脚本（自动使用内置运行时） |
| `INSTALL.md` | 本说明 |
| `README.md` | 项目简介与功能总览 |
| `KNOWN-ISSUES.md` | 已知问题与待决策清单（透明记录） |
| `LICENSE` | 许可证 |
| `test\` | 自动化测试套件（10 个套件，334 项断言，可选运行） |

## 二、快速开始（三步）

1. **解压** 本 zip 到任意目录（路径建议不含空格，例如 `D:\tools\7coder`）。
2. **配置**：复制 `.env.example` 为 `.env`，用任意文本编辑器填写：
   ```ini
   OPENAI_API_KEY=sk-你的密钥     # 云端必填；本地 LMStudio/Ollama/vLLM 可留空
   OPENAI_ENDPOINT=https://api.openai.com/v1
   ```
   - 兼容任何 OpenAI 协议端点（Groq、本地 Ollama 等），改 `OPENAI_ENDPOINT` 即可。
   - `HEAVY_MODEL` / `LIGHT_MODEL` 按你的端点支持的模型名填写。
3. **运行**（二选一）：
   ```bat
   :: 方式 A：双击或命令行执行启动脚本（使用内置运行时）
   7coder.bat

   :: 方式 B：显式调用（等价）
   runtime\node.exe index.js
   ```
   看到 `7coder initialized at: ...` 即启动成功，进入交互式 REPL。

> 无需安装 Node.js：`runtime\node.exe` 就是完整的运行时。
> 如果你机器上已有 Node.js ≥ 13.14，也可以直接 `node index.js`。

## 三、非交互与后台模式

```bat
:: 单发任务（执行完退出）
runtime\node.exe index.js --prompt "写一个斐波那契函数"

:: 后台/守护模式（终端立即可用；输出写入 .7coder\background.log）
runtime\node.exe index.js --background --prompt "重构整个后端"

:: HTTP 服务（OpenAI 协议端点，供 Cursor / Cline / Open WebUI 等接入）
runtime\node.exe index.js --server
```

HTTP 服务默认只监听 `127.0.0.1:7103`（本机回环，安全）。

**浏览器聊天界面**：服务启动后用浏览器打开 `http://127.0.0.1:7103/`，即可在网页里
用中文与 AI 对话（流式输出、可随时停止；工具仍在服务器工作区内执行）。在 Cursor 等工具里把
Base URL 设为 `http://127.0.0.1:7103/v1` 即可。局域网访问需设 `HTTP_BIND=0.0.0.0`
并强烈建议同时设置 `HTTP_API_KEY`。

## 四、权限模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `default`（默认） | 敏感操作弹 y/n 确认，文件编辑展示真实 diff | 日常使用（推荐） |
| `auto` | 由轻量模型自动判断是否放行 | 信任度高的自动化 |
| `bypass` | 全部直接执行（等于 `--danger`） | 沙箱/虚拟机 |
| `denial` | 全部拒绝 | 只读体验 |

设置方式：`.env` 里 `PERMISSION_MODE=auto`，或命令行 `--permission-mode=auto`。
即使 bypass 模式，`rm -rf /`、`format c:` 等极端命令仍被硬拦截；`.env` 等凭证文件
永远不可被 AI 改写。

## 五、特色功能开关（.env）

```ini
ENABLE_COMPUTER_USE=true   # 真实截屏 + 真实鼠标键盘注入（Windows）
ENABLE_RALPH_MODE=true     # 自迭代循环（RALPH_ITERATIONS 控制轮数）
DREAM_ALLOW=true           # 空闲 5 小时后自动整理 7CODER.md
ENABLE_HTTP_SERVER=true    # 等效于 --server
```

- 截屏：`computer_use` 工具 `action=screenshot`，PNG 落在工作区根目录。
- 鼠标/键盘：`mouse_move`/`click`/`type_text`/`press_key`（Windows 真实注入）。

## 六、常用 REPL 命令

| 命令 | 作用 |
|---|---|
| `/execute-task-now` | 执行当前输入的任务 |
| `/btw <备注>` | 不打断当前任务，追加一条备注（自动摘要注入下个任务） |
| `/undo <文件>` | 把文件恢复到最近一次 AI 修改前（自动备份于 `.7coder\backups\`） |
| `/clear` | 清空会话，重新开始 |
| `/bye` | 退出（自动清理后台任务/定时器） |

## 七、验证安装（可选）

```bat
:: 内置运行时自检
runtime\node.exe --version

:: 运行基线测试套件（离线可用，跑 mock 端点，不消耗 API 额度）
set RUN_ONLY=cli,strict
runtime\node.exe test\runner.js
```

十个测试套件（A–J，334 项断言）详见 `test\` 目录与 `README.md`。

## 八、常见问题

- **中文乱码**：程序输出已全部 ASCII 化；Windows 命令输出已自动切换 UTF-8 代码页，无需手动 chcp。
- **杀毒/防火墙提示**：HTTP 服务只绑定本机回环；如需局域网访问会被明确警告，务必设置 API key。
- **GLM/本地模型**：任何 OpenAI 协议端点均可；`OPENAI_ENDPOINT` 留空则默认 OpenAI 官方。
- **7CODER.md**：AI 自动维护的工作日志；`<!-- 7coder:auto-log -->` 标记节之外的内容（如 dream 整理结果）不会被覆盖。
- **升级**：备份 `.env` 与 `.7coder\` 目录，解压新包覆盖即可。
- **已知限制**：见 `KNOWN-ISSUES.md`（A 节为未修复缺陷，均不影响核心功能）。
