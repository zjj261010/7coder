# 7coder

**Clean-room Claude Code-style assistant** for Windows 7 / Node.js 13+.

**v2.14.0** - Native Git integration: git_status_tool / git_diff_tool (read-only, auto-safe) and git_commit_tool (approval-gated, pre-commit snapshot, auto message from the audit log).

## System Requirements

- **OS**: Windows 7 SP1 or later (also works on Windows 10/11, macOS, Linux)
- **Node.js**: v13.14.0 or higher
- **RAM**: 2 GB minimum (4 GB+ recommended for heavy models)
- **Disk Space**: 500 MB free
- **Internet**: Required for online OpenAI compatible API endpoint (or LAN for one on the local network)

## Offline Package

A fully offline distribution (bundled Node.js 13.14.0 runtime + pre-installed
dependencies + install/usage guide) can be built with
`node scripts/pack-offline.js --with-node` - see **INSTALL.md** for the
three-step install. No internet, no npm install, no system Node required
on the target machine.

## Now on NPM!

Steps:

1. install using: `npm install -g @nodemixaholic/7coder`
2. find your global root using `npm root -g`, append '/@nodemixaholic/7coder' to it (could be something slightly different on Windows, I'm not sure, I'm on macOS.)
3. change directory to that
4. find the **.env.example** file in that folder
5. copy it to ".env" and then edit ".env" using your favorite plaintext editor (mine is nano!)
6. you can now use 7coder by typing **7coder** in your terminal

## Cheat Sheet

**Interactive REPL (default)**

```bash
 index.js
```

**One-shot task (non-interactive)**

```bash
 index.js --prompt "Create a todo list app in React with localStorage"
 # Short form
 index.js -p "Build a simple HTTP server in Node"
```

**HTTP OpenAI-compatible endpoint** (use with Cursor, Windsurf, Continue.dev, etc.)

```bash
 index.js --server
 # or set ENABLE_HTTP_SERVER=true in .env
```

The server binds to **127.0.0.1 only** by default (`HTTP_BIND` to change) and can
require an API key (`HTTP_API_KEY` in .env → clients send `Authorization: Bearer <key>`).
Both non-streaming and streaming (`stream: true`, SSE) `/v1/chat/completions` are
supported, plus `/v1/models`. Client message histories are honored for multi-turn chats.

**Background / daemon mode** (frees your terminal)

```bash
 index.js --background --prompt "Refactor the entire backend"
```

**Permission mode control**

```bash
 index.js --permission-mode=auto     # Light model decides approvals
 index.js --permission-mode=bypass   # Same as --danger
 index.js --permission-mode=denial   # Block everything
```

**Danger mode (no confirmations)**

```bash
 index.js --danger --prompt "Install dependencies and run tests"
```

**Help**

```bash
 index.js --help
```

## How Tools Work

7coder has tool calling with these tools:

- `read_file` (optional line `offset`/`limit` for large files) / `write_file` / `append_file` / `edit_file` (surgical unique-substring replacement)
- `agent_tool` — **real sub-agents**: a fresh AI conversation with full tool access that works through a task and returns its final answer (no nesting; sub-agent tool approvals run in auto mode)
- `task_create_tool` / `task_get_tool` / `task_list_tool` / `task_output_tool` / `task_stop_tool` — **real background shell tasks** (async exec, output streaming, `taskkill /T /F` tree-kill on Windows)
- `skill_tool` — **real skills**: instructions loaded from `.7coder/skills/<name>.md`
- `synthetic_output_tool` — validated structured output (JSON parsed + type-checked against your schema)
- `run_command` (default shell) / `bash_tool` (**real bash**; on Windows needs Git for Windows) / `powershell_tool` (**real Windows PowerShell**, works on Win7's PowerShell 2.0 via `-EncodedCommand`)
- `glob_tool` / `grep_tool` / `list_dir`
- `web_fetch_tool` / `web_search_tool` / `web_browser_tool` / `download_tool` (streamed, 500 MB cap)
- `process_list_tool` / `process_kill_tool` — `tasklist` / `taskkill /T /F` on Windows (kills the whole child tree), `ps`/`kill` elsewhere
- `computer_use` — **real screenshots**; mouse/keyboard actions are simulated no-ops
- `schedule_cron_tool` / `cron_create_tool` — schedules like `30s`, `5m`, `2h`, `every 10m`, `daily 09:30`
- `auto_debug_tool` (launch + observe + auto-fix loop; on Windows closes test apps with `taskkill /T /F`), `bickering_tool`, `plan_mode`
- `run_tests_tool` - runs a test suite and parses output into **structured pass/fail counts** (jest/mocha/karma and node:test formats) + failure lines; auto-detects `npm test` / `node --test`
- `git_status_tool` / `git_diff_tool` / `git_commit_tool` - **native Git awareness**: see branch + dirty state, real diffs (auto-safe, read-only); commit with an audit-log-generated or explicit message, with a pre-commit `git stash create` snapshot for recovery (never pushes)
- MCP resources (`.mcp` directory), git worktrees, notebook editing, TODO.md, 7CODER.md auto-generation

Everything listed above does what it says. Tools that were previously advertised
but only simulated (teams, workflows, remote triggers, MCP auth) have been
**removed** rather than pretending to work.

In **default** mode the AI asks for confirmation on risky actions.
In **`--danger`** or **`--permission-mode=bypass`** it runs instantly.
Even in bypass mode, super-dangerous commands (`rm -rf /`, `format`, `dd`, etc.) are still blocked.

**Every tool action is risk-classified** by the light model (`LOW` / `MEDIUM` / `HIGH`).

## Permission & Security System

| Mode      | Behavior                                    |
| --------- | ------------------------------------------- |
| `default` | Interactive y/n prompts (recommended)       |
| `auto`    | Light model decides approvals automatically |
| `bypass`  | No approvals (same as `--danger`)           |
| `denial`  | Block every tool call                       |

Protected files (`.env`, `.gitconfig`, `.bashrc`, `.npmrc`, SSH keys, `credentials.json`, etc.)
can **never** be edited by the AI in bypass/auto mode, and reading them always
requires approval (never auto-safe). Path traversal and dangerous commands are
blocked at every level; the HTTP endpoint is localhost-only by default.

## Computer Use

Enable with `ENABLE_COMPUTER_USE=true` in `.env`.
Screenshots are real on Windows, macOS, and Linux. Mouse/keyboard input
injection is **not implemented** — those actions return an explicit
"simulated" notice to the model.

## Session Continuity & Context Safety

- The REPL **keeps the conversation across tasks** — the first task seeds it
- The conversation is **auto-saved** after every task (to ) - start the REPL with  (or type ) to continue a previous session across restarts.  starts fresh.
  (with the 7CODER.md summary), later tasks are appended, so iterative
  "now fix the tests too" workflows work. `/clear` starts fresh.
- When the conversation grows past `CONTEXT_CHARS` (default 120k chars), the
  oldest turns are **automatically summarized** by the light model and replaced
  with a compact digest; the newest ~60% of the budget stays verbatim.
- Every tool result is capped at `MAX_TOOL_RESULT_CHARS` (default 30k,
  head + tail kept) so a huge file or command dump can't blow the context.

## Edit Safety Net

- `write_file` / `edit_file` / `notebook_edit_tool` **automatically back up the
  previous file** to `.7coder/backups/` before writing (max 100 backups kept).
- In default permission mode, file edits are approved against a **real diff
  preview** (`-` removed / `+` added lines), not an LLM paraphrase.
- `/undo <file>` restores the newest backup of a file.

## Per-Project Configuration

Drop a .env into the workspace and it overrides the install-dir .env for
that project only - models, endpoint, API keys, permission mode, everything.
The workspace .env is a protected file: the AI can use its values but never
edit the file.

## Multi-Model

Different models on different endpoints/keys? Put a `models.json` next to
index.js (or in `<workspace>/.7coder/models.json` for per-project overrides):

```json
{
  "qwen3.8-max": { "endpoint": "https://...", "apiKey": "sk-a" },
  "local-llm":    { "endpoint": "http://127.0.0.1:1234/v1" }
}
```

Then switch models per request via the web UI model dropdown or the OpenAI
`model` field. Models without a profile use the global OPENAI_ENDPOINT/KEY.

## Other Features

- **7CODER.md** — AI automatically creates and updates this file in the project root with all findings and progress.
- **Structured audit log** - every tool call and permission change is appended as JSON lines to `.7coder/audit.jsonl` (machine-readable, 5 MB rotation, `AUDIT_LOG=false` to disable).
- **Ralph Wiggum self-iteration loop** — still available (`ENABLE_RALPH_MODE=true`)
- **Anti-frustration system** — detects when you’re mad and makes the model extra calm/helpful
- **HTTP OpenAI endpoint** — works with any non-streaming OpenAI-compatible UI
- **Light model** for risk checks, explanations, and moderation (saves tokens)
- **Dream mode** (`DREAM_ALLOW=true`) — self-consolidates 7CODER.md after ≥5h idle

## Compatibility

- Node.js 13.14.0 → latest (no modern JS syntax used)
- Windows 7 SP1 → Windows 11, macOS, Linux
- Any OpenAI-compatible API (OpenAI, Groq, local LLMs, etc.)

## Why 7coder?

Because real Claude Code is expensive and doesn’t run on Windows 7.
This is the free, broad-compatibility, semi-open version that delivers a lot of
what Claude Code does — with straightforward security controls and zero proprietary code.

Vibe-coded with love (and a lot of Windows 7 debugging) by NodeMixaholic.
Enjoy my hard work.
