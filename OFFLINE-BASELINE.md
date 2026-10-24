# Win7 离线运行与交付基线

这是项目的固定候选基线和交付检查表，不是 Win7 实机验收通过声明。版本与物料状态记录在 `scripts/offline-baseline.json`。

## 固定范围

| 项目 | 基线及交付状态 |
|---|---|
| 目标系统 | Windows 7 SP1 x64；32 位 Windows 不属于此 win64 包的验收范围 |
| Agent 运行时 | 官方 Node.js **13.14.0 win-x64/node.exe**，随 `--with-node` 包提供，不依赖系统 Node/npm |
| Node SHA256 | `8468f81ef779568e6c9f03f582ac90ce4d68364f8a01839457c0b05b8cdf1bef`；当前仓库文件与官方清单一致 |
| 生产依赖 | 随包完整 `node_modules`，以 package-lock.json 和该离线包为准；目标机不运行 npm install |
| 网页浏览器候选 | **Google Chrome 109.0.5414.120 x64**；这是待验收的固定候选，不声称是 109 的最后补丁 |
| 浏览器物料 | **尚未随包提供**；安装包/可用已安装浏览器、来源、SHA256、目标机实测仍需交付方准备和记录。manifest 的 null/false 不能当作已验收 |
| 模型服务 | 不随包提供模型服务或权重。提前准备本机或可达内网的 OpenAI-compatible 服务、模型和工具调用能力；客户端不要求该服务运行在同一台 Win7 上 |
| 工作区 | 普通用户可写，安装目录和工作区可以不同；中文/空格路径须按 Win7 验收表实测 |

Node “13+”不是“任意新 Node 都能在 Win7 运行”。不要拿现代开发机 Node 替换固定运行时。打包机仍需 Node >=14.14 和可用打包工具；这些是打包机条件。

依据：[Node 13.14.0 官方散列清单](https://nodejs.org/download/release/v13.14.0/SHASUMS256.txt)、[该版本的历史平台表](https://github.com/nodejs/node/blob/v13.14.0/BUILDING.md)、[Google 的 Windows 支持时间表](https://support.google.com/chrome/a/answer/7100626?hl=en)、[109.0.5414.119/.120 官方发布记录](https://chromereleases.googleblog.com/2023/01/stable-channel-update-for-desktop_24.html)。历史兼容基线不等于当前官方维护或本项目实机验证。

## 浏览器与页面

Win7 自带 IE 不能运行网页聊天。不要在断网机器首次启动时才尝试下载浏览器；交付前准备固定候选版本，记录实际完整版本、架构和物料散列。当前项目没有内嵌 Chromium/Electron/WebView2，也不会自动下载安装它们。

页面在初始化网络请求和定时器前检查 Promise、fetch、AbortController/Signal、UTF-8 TextDecoder、流式 Response.body.getReader，以及必要页面 API。缺少时显示具体原因和离线安装说明，不停在一个无法操作的聊天界面。该探针不验证全部 CSS、剪贴板、实际 fetch 取消或流式网络行为，也不保证其它通过探针的浏览器可部署。复制按钮已有非 Clipboard API 回退；禁用 localStorage 不应使聊天初始化失败。

物理断开外网，用实际候选浏览器连接实际 Agent，完成中文流式聊天、一次工具写入、审批/拒绝、停止、下一轮恢复、保存/刷新/载入；核对没有依赖 CDN/字体/在线安装。头部“服务已连接”只代表 Agent HTTP 可读，不代表模型可用。浏览器自身行为也应纳入现场离线验收。

## 模型和可选工具

离线配置示例（在所选工作区的 `.env` 中填写现场实际值）：

```ini
OPENAI_ENDPOINT=http://127.0.0.1:1234/v1
OPENAI_API_KEY=
HEAVY_MODEL=现场已加载的模型名称
ENABLE_HTTP_SERVER=true
ENABLE_AUTO_DEBUG=false
```

如果模型在内网另一台机器，改成其真实内网地址。服务必须实际支持本项目使用的 chat completions、SSE 和 tool_calls；模型可用不等于工具调用质量已验收。云端默认地址在完全离线时不能工作。

基础聊天/文件操作不要求目标机安装 npm、Python、Git、编译器或 .NET 开发环境。可选 Bash/Git、Python、tsc/eslint、C#/.NET 调试、GUI 截图/输入各有独立依赖，未准备的能力不能列为已交付；目标机器存在 PowerShell 2/CLR2 也不能代替这些工具的功能验收。操作系统补丁/运行库/DLL 和普通用户权限以干净 Win7 实测确认，不根据开发机能启动就推定目标机齐备。

在线搜索、外部网页/下载和远程MCP依赖对应资源可达，不属于基础离线承诺。旧npx MCP桥可能请求npm registry，离线现场不应依赖首次下载；预装可选工具或使用已准备的stdio服务，并通过功能预检。当前没有把所有在线工具从schema中删除。

## 交付前记录

在解压后的包目录运行：

```bat
runtime\node.exe --version
runtime\node.exe -p "process.arch"
runtime\node.exe -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('runtime/node.exe')).digest('hex'))"
7coder-web.bat "D:\现场 项目"
```

应分别得到 v13.14.0、x64、上述 SHA256，并在页面/`/api/info` 确认真正监听完成。若 Node 自身无法启动，先保留 Windows 的 DLL/加载错误和退出码，不进入浏览器排障。散列命令不依赖 Win7 默认 PowerShell 缺少的 Get-FileHash。

`pack-offline.js --with-node` 在删除原 stage 之前校验 Node 文件散列；错版、架构不符或文件损坏直接拒绝，不自动下载。此检查只固定 Node，不验证整个离线包、浏览器或现场系统。浏览器物料、依赖清单和完整包 manifest/打包复验尚未完成。

最终仍需 ISSUES-LOG.md 中 V22-01/02/03/05/06/07/08 的相关门槛，尤其干净 Win7、真实浏览器、异常退出/再次启动和 24/72h 工作量。当前不能仅凭本文件或本机专项测试批准无人值守发布。
