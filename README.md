# 7coder

**Clean-room Claude Code-style assistant** for Windows 7 / Node.js 13+.

**v2.18.0** - Highlights include in-UI model settings: configure endpoint / API key / main model and per-model profiles (models.json) directly from the web UI - takes effect immediately and persists (workspace .env + models.json). Also fixes the reasoning-block collapse (separate containers).

## System Requirements

- **OS**: Windows 7 SP1 or later (also works on Windows 10/11, macOS, Linux)
- **Node.js**: Win7 offline baseline pins official v13.14.0 x64; newer Node versions are not a Win7 compatibility promise
- **RAM**: 2 GB minimum (4 GB+ recommended for heavy models)
- **Disk Space**: 500 MB free
- **Model endpoint**: provisioned local/LAN OpenAI-compatible service for offline use; internet only for optional online endpoints/tools
- **Web UI**: separately prepared Win7 browser; fixed candidate Chrome 109.0.5414.120 x64 is not bundled or yet validated. See [OFFLINE-BASELINE.md](OFFLINE-BASELINE.md).

## Offline Package

A fully offline distribution (bundled Node.js 13.14.0 runtime + pre-installed
dependencies + install/usage guide) can be built with
`node scripts/pack-offline.js --with-node` - see **INSTALL.md** for the
three-step install. No internet, no npm install, no system Node required
on the target machine for the Agent runtime. A compatible browser and reachable local/LAN model must be prepared separately; neither is included. Note: the packaging machine (the one executing
`scripts/pack-offline.js`) needs Node >= 14.14, because the packer uses
`fs.rmSync`; the target machine itself still only needs the bundled
Node 13.14.0.

## Distribution

This project is distributed as an **offline zip** with bundled runtime — see **INSTALL.md**.


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

On Windows offline packages, run `7coder-web.bat` to start the built-in browser chat. It prefers the bundled Node.js 13.14.0 runtime and loads `.env` from the selected workspace. Pass a workspace path to override the default:

```bat
7coder-web.bat "D:\projects\my-app"
```

Open `http://127.0.0.1:7103/` after startup.

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
- `run_command` (default shell) / `bash_tool` (**real bash**; on Windows needs Git for Windows) / `powershell_tool` (**real Windows PowerShell**; uses PS2-compatible APIs and a fixed ASCII bootstrap decoding UTF-16LE Base64 input).
  `bash_tool {persistent:true}` runs in ONE long-lived bash for the whole conversation: `cd`, `export` and aliases survive across calls. A hung command (interactive program) times out (`timeout_ms`, default 120s) and the session restarts fresh; bare `exit` ends the session - the next call respawns it. Default (persistent unset) stays a fresh stateless shell per call.
- `glob_tool` / `grep_tool` / `list_dir`
- `web_fetch_tool` / `web_search_tool` / `web_browser_tool` / `download_tool` (streamed, 500 MB cap)
- `process_list_tool` / `process_kill_tool` — `tasklist` / `taskkill /T /F` on Windows (kills the whole child tree), `ps`/`kill` elsewhere
- `computer_use` — **real screenshots**; mouse/keyboard input is really injected on Windows, other platforms warn
- `schedule_cron_tool` / `cron_create_tool` — schedules like `30s`, `5m`, `2h`, `every 10m`, `daily 09:30`
- `auto_debug_tool` (explicit opt-in; bounded process observation and repair, passive GUI only), `bickering_tool`, `plan_mode`
- `run_tests_tool` - runs a test suite and parses output into **structured pass/fail counts** (jest/mocha/karma and node:test formats) + failure lines; auto-detects `npm test` / `node --test`
- `git_status_tool` / `git_diff_tool` / `git_commit_tool` - **native Git awareness**: see branch + dirty state, real diffs (auto-safe, read-only); commit with an audit-log-generated or explicit message, with a pre-commit `git stash create` snapshot for recovery (never pushes)
- **MCP stdio servers** (see the MCP section below): `mcp_list_tools_tool` discovery + `mcp_tool { server, tool_name, args }` calls against real Model Context Protocol servers
- MCP resources (`.mcp` directory), git worktrees, notebook editing, TODO.md, 7CODER.md auto-generation

Everything listed above does what it says. Tools that were previously advertised
but only simulated (teams, workflows, remote triggers, MCP auth) have been
**removed** rather than pretending to work.

In **default** mode the AI asks for confirmation on risky actions.
In **`--danger`** or **`--permission-mode=bypass`** it runs instantly.
In bypass mode a best-effort blocklist still rejects a few known-destructive command shapes (rm -rf /, format, dd...); it is a denylist, not a sandbox.

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
requires approval in default/auto mode (in bypass they are only warned about,
not approved). Path traversal and dangerous commands are
blocked at every level; the HTTP endpoint is localhost-only by default.

### User Permission Rules

Extend the fence from the workspace with `.7coder/permissions.json` (a
`permissions.json` next to index.js also loads; both layers concat):

```json
{
  "protected_extra": ["*.key", "secretzone/**"],
  "deny":  ["read_file(blocked.txt)", "run_command(*format*)"],
  "allow": ["write_file(scratch/**)", "run_command(*npm test*)"]
}
```

Rule syntax `tool(pattern)` - `*` as the tool means any tool, `*` inside the
pattern matches anything; file tools match the workspace-relative path
(forward slashes on every platform), command tools match the command text.
Security-first semantics:

- **`deny` blocks in EVERY mode** (even bypass) - your own fence outranks
  convenience. Checked before auto-safety, so it beats built-in auto-safe
  tools too.
- **`allow` skips only the approval step.** It can never override protected
  files, the super-dangerous command block, denial mode, or a `deny` rule.
- `protected_extra` adds to the built-in protected-file list (matches the
  relative path or the bare file name).

In `auto` mode the light model returns a structured verdict; every decline
carries its reason back to the model and is recorded as an
`approval_decline` entry in `.7coder/audit.jsonl`.

## Computer Use

Enable with `ENABLE_COMPUTER_USE=true` in `.env`.
Screenshots are real on Windows, macOS, and Linux. Mouse/keyboard input
injection is real on **Windows** (mouse move/click via user32, typing and
key presses via SendKeys); on other platforms those input actions return
a Windows-only warning instead of being injected.

## Session Continuity & Context Safety

- The REPL **keeps the conversation across tasks** — the first task seeds it
  (with the 7CODER.md summary), later tasks are appended, so iterative
  "now fix the tests too" workflows work. `/clear` starts fresh.
- The conversation is **auto-saved** after every task (to `.7coder/session.json`) -
  start the REPL with `--resume` (or type `/resume`) to continue a previous
  session across restarts.
- When the conversation grows past `CONTEXT_CHARS` (default 120k chars), the
  oldest turns are **automatically summarized** by the light model and replaced
  with a compact digest; the newest ~60% of the budget stays verbatim.
- Every tool result is capped at `MAX_TOOL_RESULT_CHARS` (default 30k,
  head + tail kept) so a huge file or command dump can't blow the context.

## Edit Safety Net

- `write_file` / `append_file` / `edit_file` / `notebook_edit_tool` **automatically back up the
  previous file** to `.7coder/backups/` before writing (newest 5 per source
  file, 200 total kept).
- In default permission mode, file edits are approved against a **real diff
  preview** (`-` removed / `+` added lines), not an LLM paraphrase.
- `/undo <file>` restores the newest backup of a file.

## Per-Project Configuration

Drop a .env into the workspace and it overrides the install-dir .env for
that project only - models, endpoint, API keys, permission mode, everything.
The workspace .env is a protected file: the AI can use its values but never
edit the file.

The web UI 模型设置 panel configures all of this **live**: global endpoint/key/main
model (persisted to the workspace .env, effective immediately) plus per-model
profiles (models.json) with add/edit/delete rows.

## Multi-Model

Different models on different endpoints/keys? Put a `models.json` next to
index.js (or in `<workspace>/.7coder/models.json` for per-project overrides):

```json
{
  "qwen3.7-plus": { "endpoint": "https://...", "apiKey": "sk-a" },
  "local-llm":    { "endpoint": "http://127.0.0.1:1234/v1" }
}
```

Then switch models per request via the web UI model dropdown or the OpenAI
`model` field. Models without a profile use the global OPENAI_ENDPOINT/KEY.

An empty `LIGHT_MODEL` inherits the model selected for that execution; an empty `SUMMARY_MODEL` inherits its resolved light model. Explicit auxiliary model names stay independent and use their own profiles (or the global endpoint/key when no profile exists). Sub-agents inherit their parent execution model, including when delegated through a workflow. `/api/info` reports the currently resolved default light and summary names.

Each HTTP request captures its model names, endpoints and keys when received, including while it waits in the execution queue. CLI tasks and REPL drafts also keep one model context. Settings/profile changes apply to new executions; in-flight work and its queued action summary retain their captured routes. This covers main calls, permissions, compression, planning, synthetic output and delegation. To use an explicit helper model on a different service, give it a matching profile. Changing `LIGHT_MODEL`/`SUMMARY_MODEL` in `.env` requires restart; the web settings API still updates the main model and profiles.

## MCP (Model Context Protocol)

7coder speaks the real MCP **stdio transport**: JSON-RPC 2.0 over the server
process's stdin/stdout (newline-delimited). Configure servers like models -
two layers merged, the workspace file wins per server:

- `mcp.json` next to index.js
- `<workspace>/.7coder/mcp.json`

```json
{
  "servers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

Each entry: `command` (required), `args`, `env`, `cwd`. Servers start lazily on
first use, stay alive across calls (one handshake), and respawn automatically
if they crash. `mcp_list_tools_tool` discovers servers, tools and arg schemas
(auto-safe - it only spawns commands YOU configured); call tools with
`mcp_tool { server, tool_name, args }` (HIGH risk - goes through the normal
approval system). Per-call timeout: `MCP_CALL_TIMEOUT` (default 120000 ms).

MCP stdio frames are limited to 4 MB of UTF-8 data in either direction. An oversized outgoing request is rejected before sending. Pipe failure, EOF, disposal or timeout retires the client and settles all pending requests; the next call may create a new client. Sent calls report **result unknown**: check side effects before retrying. The transport does not automatically replay them. Retiring a direct child does not prove that its descendants or external operations stopped.

Persistent bash accepts one command at a time and retains at most 8 MB of combined stdout/stderr per active command; idle output is discarded. A completion marker plus a 300 ms trailing-output window determines success. Nonzero command status is preserved. Pipe failure, early exit, timeout or output overflow ends the wait and retires the session; the next call starts with fresh cwd/env. These failures also report unknown results. Direct-child termination is best effort; full process-tree cleanup remains separate work.

The old `mcp_url`/`npx_pkg` bridges (custom HTTP POST /invoke protocol) still
work but are legacy - real MCP ecosystem servers need the stdio config above.

## Other Features

- **7CODER.md** — AI automatically creates and updates this file in the project root with all findings and progress.
- **Layered memory (GAP-9)** — durable topic notes in `.7coder/memory/<topic>.md` via `memory_tool {action:save|read|list|delete, topic, content}`; at task start notes whose keywords match your prompt are recalled automatically (plus a topic index). Dream sessions may consolidate them. CJK-aware context budgeting (han chars count x2 toward CONTEXT_CHARS).
- **Structured audit log** - every tool call and permission change is appended as JSON lines to `.7coder/audit.jsonl` (machine-readable, 5 MB rotation, `AUDIT_LOG=false` to disable).
- **Runtime diagnostics** - `/api/info` combines current chat/summary queue load with active task/tool counts, last success/error and logging health. These in-memory counters reset on restart. CLI/HTTP terminal outcomes, tool failures and observed background/cron child closes also write UTF-8 `.7coder/runtime.jsonl`, independently of `AUDIT_LOG`; rotation keeps that file and one `runtime.old.jsonl`, each at most 1 MiB for records written by this logger. Failed rotation skips the append; disk/permission failures remain visible in `runtime.loggingError` and warn at most once per minute. Records limit metadata lengths, retain available errno/path/PID/exit code, and scrub common token forms. They do not copy request payloads or model configuration; error text can still contain input fragments. Early configuration failures before initialization remain on stderr, and a recorded direct-child close does not prove descendants have exited.

`MAX_TOOL_STEPS` limits model tool-call rounds, with a default of 30. Set it to `0` to request a final answer without offering or executing tools. A single permitted round can contain multiple tool calls. Values must be non-negative safe integers; invalid values produce a warning and use 30. This setting does not replace permission controls or the shared execution deadline.

Offline protocol tests use `test/_protocol.js` to check complete, unique tool-call/result IDs. `test/mock-server.js` accepts `MOCK_STRICT=1` for fixtures with `{expect, reply}` steps; expectations can check the model, tool availability, last user text, and tool results. Strict mode rejects malformed pairing, wrong expectations, unavailable scripted tools and exhausted scripts without advancing the step. Historical positional fixtures retain their repeat-last behavior until explicitly migrated. `npm run test:mock-protocol` exercises both modes against owned local processes.

Streamed tool calls/results, audit tool rows and saved Web activities retain `callId`. IDs up to 256 characters are preserved; longer IDs use a stable SHA-256 digest in these diagnostic fields. Missing IDs remain uncorrelated, including workflow-internal steps without a model ID. Model IDs may repeat in different requests; use the request/turn context when comparing records. This field is not a globally unique execution ID.
- **Token usage** - `/api/info`, the Web UI and `[USAGE]` show totals for the current process. Each upstream call that reports usage writes a `type: "usage"` audit event with model and prompt/completion counts; prompts and credentials are not included. Endpoints that omit usage cannot be counted.
- **Task checkpoints** - CLI, REPL and HTTP tasks create a local `refs/7coder/task-snapshots/*` ref when tracked files have pending changes. `git stash create` preserves working-tree and staged contents without changing either. Clean repositories produce no checkpoint; untracked files are excluded. Inspect with `git for-each-ref refs/7coder/task-snapshots/` and `git show <ref>:<path>`; refs stay local and are not automatically pruned.
- **Ralph Wiggum self-iteration loop** — still available (`ENABLE_RALPH_MODE=true`)
- **Anti-frustration system** — detects when you’re mad and makes the model extra calm/helpful
- **HTTP OpenAI endpoint** — works with any OpenAI-compatible UI (streaming and non-streaming)
- **Light model** for risk checks, explanations, and moderation (saves tokens)
- **Dream mode** (`DREAM_ALLOW=true`) — self-consolidates 7CODER.md after ≥5h idle

## Validation

Tool policy is declared once per tool in `index.js` (`TOOL_METADATA`): fixed risk and approval explanation, automatic approval, parallel read eligibility, change tracking, execution type, resources and current cancellation support. Startup checks require an exact match with the tool schemas and reject invalid declarations or parallel writes. Resource/cancellation descriptions do not grant approval or add cancellation support; protected paths, deny rules and dangerous-command checks keep their existing order. The frozen pre-migration fixture in `test/fixtures/tool-policy-before-opt12.json` checks policy and approval wording against the previous implementation, including model fallbacks.

All 53 current tool names use internal `ToolResult` values (`status`, `text`, optional `data`). Workflow control, audit events and streamed tool cards use the explicit status; the model receives the text. Reported test failures are failures even when the command exits 0. Diagnostic errors and failed toolchains stop required workflow steps; warnings alone remain successful, and missing toolchains are errors. Optional failed steps may continue, while cancellation always stops the workflow. Central permission/argument control messages retain a compatibility normalizer; successful tool data is explicitly marked so error-looking content is not inferred as failure. Structured data stays internal and is not copied into SSE or audit logs.

`agent_tool` also returns an explicit status: a cancelled request remains `cancelled` when the sub-agent returns or rejects. `run_command`, `bash_tool` and `powershell_tool` expose the observed process or shell-command exit code in internal `data.exitCode`; cancellation, launch failures and unknown results use `null`. Persistent-shell timeout/retirement codes are not reported as confirmed command exits. These result fields do not provide full active cancellation or process-tree cleanup.

`EXECUTION_TIMEOUT_MS` sets a shared deadline for a CLI task or HTTP chat request, including its model retries, approvals and action summary (default 1800000 ms / 30 minutes; clamped to 1 second through 24 hours). HTTP disconnects cancel both streamed and non-streamed model requests. Main/light/summary calls through `callOpenAI` use Axios CancelToken, which works on the bundled Node 13 runtime without AbortController. Cancellation stops retry backoff, revokes pending HTTP approvals and is checked again before tool dispatch. The request gate remains held until the old execution settles; completing a normal HTTP response does not cancel its summary, which keeps the remaining deadline.

Download, fetch/search/browser/vision and external MCP HTTP requests also observe cancellation while waiting for headers or data. Downloads keep the subscription until the writer closes, check cancellation again after flush/backup and before replacing the destination, then clean up owned temporary files on cancellation. MCP stdio initialization/discovery/tool calls and persistent-shell waits retire their session when cancelled; a later call creates a fresh session without replaying the old command. Sent MCP/shell operations may already have had effects, so cancellation does not imply rollback. Sleep waits observe the shared deadline too.

Dream consolidation has its own bounded execution control and an exclusively created owner lock that is released in finally. A recognized lock from an earlier run can recover under workspace exclusivity; fresh legacy locks retain their grace period. Failed or cancelled dream attempts preserve existing notes and do not record a successful interaction. HTTP chat completion also updates the interaction timestamp.

Each BTW note has a deadline starting when it is queued. Clearing its draft cancels its request and prevents prompt/log injection; cancellation does not fall back to the original note. `/bye` cancels active execution controls and blocks new work. Ordinary stdin EOF retains the existing behavior of letting an already-started task finish.

Auto-debug records actual process exit/close status, bounds combined stdout/stderr at 8 MB, refuses recursive debug and returns failure when repair attempts are exhausted. JS targets use the bundled executable; C# is recompiled after each repair and requires an installed `csc`. Missing launchers, output overflow and unconfirmed cleanup stop the repair loop. GUI observation sends no random clicks/typing and cannot validate UI functionality. Existing installations must explicitly set `ENABLE_AUTO_DEBUG=true`; the shipped configuration template defaults it to false. Error-text detection remains heuristic and can require manual review.

Cancellation still has limits: synchronous operations cannot be interrupted by a JavaScript timer. Startup awaits dream consolidation before the HTTP listener starts, although the wait is now bounded. Auto-debug requests a stop through the live ChildProcess handle, never a saved PID after exit, and waits up to five seconds for close; unconfirmed cleanup is reported as unknown. This does not prove descendants stopped. Process-tree ownership and bounded summary/admission queues remain separate work.

`npm run test:all` runs A–J and the dependency-free UI simulations in sequence using fixed offline defaults. Scenario-specific settings still override them. Set `NODE_BIN` to test the backend with another runtime; UI simulations use the modern Node running the entry point. Set `REAL_TEST=1` to append K/R and preserve real-endpoint settings.

K/R require exactly `REAL_TEST=1`. They use private installs/workspaces, owned Agent processes, dynamic loopback ports, bounded HTTP/SSE reads, explicit DONE/error checks and observed direct-child close. `RUN_ONLY` selects K scenario names or R's `r1`..`r5`. R5 requires a distinct `REAL_SECOND_MODEL`; optional `REAL_SECOND_ENDPOINT` and `REAL_SECOND_API_KEY` configure its profile. Without a distinct model it reports SKIP. These tests cannot prove that a remote gateway maps a model name to particular weights. `npm run test:endpoint-oracles` tests their positive and negative checks against local fixtures, including actual K workflow and R5 routing, without evaluating a real model or contacting an external service.

The entry point also includes `test/stream-context.js` (`npm run test:stream-context`): malformed SSE isolation and next-request recovery, plus context compression failure/empty-summary handling, complete segmented input and verbatim active-instruction retention. A failed context summary stops the current task with its original history intact; it does not continue using a placeholder digest.

`npm run test:repl-approval` covers the CLI question queue and actual isolated REPL against a local model fixture: parallel protected reads, approval EOF, ordered BTW notes, repeated execution commands and stale notes after `/clear`. The REPL asks one question at a time; EOF declines unanswered approvals and marks unanswered user questions unreachable. `/bye` remains available during a question. `/execute-task-now` takes the current draft immediately, waits for all its earlier BTW notes, and holds the execution slot while waiting. Input and BTW notes received afterwards belong to the next draft; another execution command while busy is refused and must be issued again after completion. `/clear` discards the current draft, including late results of its pending notes. Non-interactive user-question tools return an explicit unreachable result.

`npm run test:download-commit` checks download replacement and failure recovery with real files, streams and local fixtures. Downloads exclusively create a unique sibling `.part-*` file, wait for writer close, flush the completed file and publish a complete previous-version backup before renaming over an existing destination. A failed rename never falls back to deleting the destination. Failed backup/flush/close operations stop the replacement. Completed backups use the existing `.7coder/backups` and `/undo <path>` mechanism, with the current rollback copy protected during the existing five-per-file/200-total pruning pass. Text writers share the strict snapshot routine described below.

On restart, use the destination as it stands: there is no intermediate step that removes the old destination. Incomplete `.part-*` and `.bak.tmp` files are never automatically promoted or selected by `/undo`. After an interrupted commit, the complete previous version can be restored with `/undo <path>` (the successful download result also reports its backup path). Temporary cleanup failures report the retained file path. Interrupted operations may leave temporary files; inspect them before manual removal, especially if another instance is active. Backups have count limits and require space for the previous file; this does not guarantee hardware power-loss durability or coordinate concurrent instances. Real Win7 filesystem/antivirus and power-cut verification remain required.

`npm run test:text-encoding` checks text safety and strict backups. `read_file` and `prompt_from_file` require lossless UTF-8 decoding. Existing files used by `write_file`, `append_file`, `edit_file` and `notebook_edit_tool` must also pass that check before mutation. Invalid UTF-8, common GBK/CP936/UTF-16 byte sequences and NUL-containing text are refused with an explicit error. Tool input rejects unpaired surrogates and NUL. This is a UTF-8 contract: bytes that happen to be valid in both UTF-8 and a legacy encoding cannot reveal their intended encoding. Prepare an explicitly converted copy for legacy projects; the Agent does not guess or automatically convert them.

`npm run test:model-routing` runs the real backend against two local fixture endpoints that each reject foreign model names and keys. It exercises per-request selection, settings/profile hot changes during a held request, default and explicit helpers, compression, approval, planning, synthetic output, direct/workflow sub-agents and action summaries. It uses no real model service.

`npm run test:pipe-lifecycle` injects asynchronous Writable errors and late child events into the original transports, checks timeout/dispose settlement and byte limits, then exercises owned real MCP children and available Git Bash. Missing bash is explicitly skipped. This does not substitute for Win7 native pipe faults, process-tree ownership or long-running stress tests.

`npm run test:state-store` checks state replacement with real temporary files, injected disk/permission/flush/close/rename failures, abrupt process exits at commit boundaries, native HTTP handlers and second-start/CLI resume recovery. It uses no model service or real user configuration.

Agent-owned todos, CLI/web sessions, model profiles, workspace `.env`, memory notes and worklogs use exclusive sibling staging files, file flush/close, then rename replacement. The destination is never deleted first. `<file>.7coder-prev` retains the preceding complete version; identical writes preserve that version. JSON stores validate their shape and accept a UTF-8 BOM. Invalid JSON/schema/UTF-8 is preserved as `<file>.7coder-corrupt-<sha256>` before restoring a valid previous version. Without a valid version, reads/writes fail visibly; todos do not silently become an empty list. Unrecoverable `.env` encoding or model profiles stop startup, and failed settings persistence leaves runtime settings unchanged. Plain text and dotenv retain their existing syntax/semantics: valid UTF-8 text or syntactically valid but semantically incomplete JSON cannot always be identified as damaged.

One Agent process owns a canonical workspace at a time, across CLI, REPL, background and HTTP modes and regardless of HTTP port. Windows uses a named pipe derived from the real workspace path (case folded); junction aliases share its identity. The bundled Node 13 uses libuv 1.37, whose [Windows pipe bind implementation](https://raw.githubusercontent.com/libuv/libuv/v1.37.0/src/win/pipe.c) requests the first pipe instance exclusively. Ownership begins before config loading/recovery and ends with the process. A competing start fails nonzero and reports a verified PID/run identity when available. An unresponsive or unknown owner also blocks startup; it is never reclaimed by age or PID checks. No persistent lock file needs stale-lock deletion. `--help` remains available.

Use the existing HTTP Agent for clients sharing its workspace, or stop it before running another CLI there. Independent workspaces may run together. Shared installation `.env`/`models.json` outside the owning workspace are read only: when the primary is invalid and a valid previous version exists, it is used with a warning while the installation bytes stay intact. Repair those shared originals separately. Background launch explicitly hands ownership to its child and reports acceptance after the child owns the workspace and finishes synchronous config/setup; task completion or failure is recorded in `.7coder/background.log`.

Task stop and cron deletion wait up to five seconds for the direct child's `close`, including its pipes. A timed-out stop reports `stop-unknown`; a cron is disabled but retained for diagnosis and another delete attempt. A late close reconciles a stopped task. `/bye` attempts these stops together and warns about unconfirmed closes. Windows still uses an asynchronous, bounded `taskkill /T` attempt for a child not yet observed exiting; known exit never triggers another PID stop. This does not eliminate the PID reuse race or contain descendants through forced Agent termination. Native process ownership, one-shot exit semantics and Win7 termination/restart tests remain release requirements.

Background tasks admit at most four live children, including unconfirmed stops. Each task retains the last 128 KiB of valid UTF-8 output; exceeding 8 MiB combined stdout/stderr requests a stop and records a failed task once close is observed. Output tools identify discarded history and output-limit failures. Finished history retains at most fifty tasks. The underlying command collector also has an 8 MiB per-stream buffer limit; this is a fallback, not the whole-Agent memory budget. Cron admits at most 32 jobs; deleting a job releases its slot after direct-child close. Command strings are limited to 32768 characters. Split large workloads or poll/finish existing tasks rather than launching unlimited work.

HTTP chat admits at most eight requests before body collection, sharing 16 MiB of decoded UTF-8 body bytes (10 MiB per request). Busy admission returns 429; body reading has a 30-second deadline and core execution queueing a 60-second deadline. Disconnecting a queued request removes it immediately. The permission-sensitive core remains serial. `/api/info` reports admission counts/bytes, core queue length and summary queue load.

Both streaming and JSON replies schedule their action summaries outside the core gate. The summary collector permits eight active/pending items and 2 MiB of input including route metadata, one model call at a time; pending age is limited to 60 seconds and lifetime to 120 seconds or the original request deadline, whichever comes first. Overload or excess pending age writes a compact record containing bounded task/response excerpts and a reason. An expired original request or Agent shutdown writes no fallback. A model wait reaching its deadline is cancelled and diagnosed. Replies shorter than 200 characters retain the existing no-summary rule. These budgets bound the queues, not every Agent allocation or the size of user-maintained files; target-machine soak tests are still required.

HTTP startup binds before optional dream maintenance or an explicit startup task makes model calls. The UI and `/api/info` remain available during these tasks; `startup.phase/error` distinguish maintenance, cancellation and failure. Optional startup dream holds the normal execution gate, has at most 120 seconds (also capped by the configured execution deadline), and yields to a valid foreground chat by cancelling and awaiting its work. `--server --prompt` runs the explicit task first under the gate while chats queue; optional startup dream is skipped for that launch. An explicit task failure is visible in startup status and leaves HTTP available for recovery. A bind/configuration failure exits nonzero. CLI/REPL dream scheduling retains its existing idle rule.

HTTP server mode explicitly blocks `bash_tool` with `persistent=true`, including nested agents/workflows and bypass mode. A backend conversation identity and restore/close protocol must be designed before enabling it there; `/api/info` reports `capabilities.persistentShell=false`. Use stateless commands with explicit working directories and environment. CLI/REPL main conversations keep persistent shells; sub-agent/workflow shells retire when their own scope ends, including failure or cancellation, so a later scope does not inherit earlier cwd/env. A workflow inside an agent shares that agent's shell until the enclosing agent ends. Retirement stops reuse and attempts direct-child cleanup; full descendant ownership remains a separate requirement.

For Git-layout persistent shells on Windows, the Agent prefers the adjacent `usr/bin/bash.exe` interpreter over a `bin/bash.exe` compatibility launcher, and supplies local Git/Unix command paths to that child only. The Git distribution itself [copies a compatibility program into bin/bash.exe](https://github.com/git-for-windows/build-extra/blob/main/portable/release.sh), while its [installation script uses usr/bin/bash.exe with an explicit Unix PATH](https://github.com/git-for-windows/build-extra/blob/main/post-install.bat). The real Bash deadline test observes process `close`, rather than treating a timeout message as proof of termination. Other layouts and arbitrary commands launching descendants still require process ownership work; the one-shot/debug launch paths are not changed by this persistent-shell adjustment.

Test autodetection respects the Agent runtime. A valid `package.json` test script still selects `npm test --silent` and therefore requires an appropriate npm installation. Loose root `*.test.js` files select the current Agent executable with `--test` only when its version supports that flag ([introduced in Node 18.1 and 16.17](https://nodejs.org/download/release/v19.2.0/docs/api/cli.html#--test)). Bundled Node 13 reports that an explicit framework/standalone command is required and starts no guessed test process. Explicit commands are preserved; they remain responsible for their own executables and PATH. Invalid package configuration is diagnosed rather than silently bypassed.

`npm run test:workspace-lease` exercises real competing processes, case/junction aliases, sequential todo preservation, unknown/frozen owners, forced exit/restart, `/bye`, background handoff and shared config fallback. Win7, different users/terminal sessions and real Ctrl+C/logout/shutdown still require target-machine checks. All processes must use this protocol; older Agents, arbitrary shell/file writers and overlapping workspace roots do not participate. This is a same-machine ownership rule, not a distributed network-share lock. On non-Windows hosts the fallback reserves a deterministic loopback TCP port; a collision fails closed and that branch is not covered by the Windows test run.

Use the session/memory delete action to remove both primary and previous files; deleting only the primary manually allows recovery to restore it. Corruption evidence remains for diagnosis. Credential companions inherit file-tool protection; built-in Git `stage_all` excludes `*.7coder-*`. Add `*.7coder-*` to other workspaces' ignore rules before using external Git commands. Keep these files local: they may contain keys or conversation data. After an interrupted operation, inspect retained staging/evidence files before manual cleanup and first confirm that no instance is active. Distinct corruption evidence and crash leftovers are not automatically pruned.

The state protocol retains a recoverable version and the ownership rule excludes cooperating local instances; neither guarantees rename/directory durability through a hardware power cut or termination of old descendants. Real Win7 filesystem, sharing/antivirus and power-loss tests remain required. Full-file note/log replacement adds IO proportional to file size; log retention and total storage budgets remain separate work.

Existing UTF-8 BOMs are retained. Uniform CRLF, LF or CR line endings are used for incoming write/append/replacement text and edit matching; untouched bytes stay intact. Mixed/no line-ending styles keep incoming text literal. Every existing target modified by those four text writers requires a complete, flushed, published backup; backup or recovery-metadata failure stops the write. Backup ordering advances across rapid writes and clock rollback so `/undo` selects the latest complete version. Managed state text writers additionally use the state protocol above. Other user-file writes retain their ordinary write/append behavior: an interrupted or partially failed write can require `/undo` recovery. Total backup-byte limits remain separate work.

A–J run a private copy of the application in a `7coder-test-*` system temporary directory, with workspaces outside the source repository. The real install `.env`, model profiles and permission files are not loaded. `npm run test:harness` checks the isolation and child ownership helpers. Real keyboard/mouse injection is excluded by default; explicitly set `DESKTOP_TEST=1` only in a controlled desktop session. Skipped desktop scenarios are reported separately from passed assertions. K/R remain explicit real-endpoint tests.

Each run prints its temporary directory and records `owned-processes.tsv`. If interrupted, inspect only that run with `powershell -NoProfile -File test/kill-orphans.ps1 -Manifest "<run-directory>\owned-processes.tsv"`; it defaults to a dry run. Add `-Apply` to stop matching recorded PIDs whose command line still carries that run's identity. It does not search for or stop ordinary Agent servers. The temporary install and manifest are retained for diagnosis.

`npm run test:browser` runs message editing, cancellation, session switching and token refresh in real headless Chrome against local fixtures. It requires modern Node, an installed Chrome and Playwright supplied by your development environment (or `PLAYWRIGHT_MODULE_PATH`). `BROWSER_BIN` selects another Chromium executable. Playwright is not a production dependency or required by the offline package. Set `BROWSER_TEST=1` to append this test to `test:all`; missing browser tooling is an explicit failure when requested.

## Compatibility

- Node.js 13.14.0 → latest (syntax stays within what Node.js 13.14 supports)
- Windows 7 SP1 → Windows 11, macOS, Linux
- Any OpenAI-compatible API (OpenAI, Groq, local LLMs, etc.)

## Why 7coder?

Because real Claude Code is expensive and doesn’t run on Windows 7.
This is the free, broad-compatibility, semi-open version that delivers a lot of
what Claude Code does — with straightforward security controls and zero proprietary code.

Vibe-coded with love (and a lot of Windows 7 debugging) by NodeMixaholic.
Enjoy my hard work.

PowerShell command input travels as UTF-16LE Base64 inside a fixed ASCII `-Command` bootstrap, passed through `execFile` argv. The bootstrap sets `$OutputEncoding` and `Console.OutputEncoding` before parsing user code; a footer retains the usual final-error exit status while explicit `exit N` remains N. Using `-EncodedCommand` directly was observed on the current Windows PowerShell host to keep ANSI-encoded CLIXML stderr despite changing console encoding. The Base64 UTF-16LE representation follows [Microsoft's PowerShell executable documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1); the bootstrap avoids that host serialization path. Desktop input `.ps1` files use UTF-8 BOM and direct argv; screenshot dispatch uses the same Base64 helper. Tests capture desktop calls without sending input or capturing the screen. Actual Win7 PS2/CLR2, CP936 and native programs with their own encodings still require target-machine validation; scripts that explicitly change encoding can override the defaults.

Web sessions keep one save request in flight and merge later updates into one latest immutable snapshot. The page shows save failures and a retry button, warns before leaving unsaved content, and saves partial/failed/cancelled replies with turn-linked tool activities. Normal EOF without `[DONE]` is an incomplete reply. Both manual and startup restore retain these records; they do not imply that completed tool effects were rolled back. Save payloads/stored sessions and CLI saved sessions have a 2 MiB UTF-8 byte limit; excess session activity is rejected rather than silently removing older turns. Unacknowledged content can still be lost if the user forces reload/exit, and the existing separate multi-client conflict/retention limitations remain.

Permission decisions are checked again after asynchronous approval work and immediately before dispatch. Changing mode revokes pending approvals and invalidates earlier decisions, including a change away and back. Denial overrides `--danger` and an active sub-agent policy; otherwise `--danger` is shown as effective bypass. Default approval includes actual arguments and complete workflow steps; previews over 64 KiB require smaller actions. The page displays approval success only after a successful server confirmation and disposes old countdowns/results on Stop or completion. Process identities plus permission revisions prevent a restarted backend or delayed old response from leaving the page on a stale mode. Permission changes do not undo actions already dispatched.

MCP discovery reports a failure if any configured server fails while retaining the successful listings. The legacy HTTP `/invoke` bridge honors `isError: true` and JSON-RPC 2.0 error envelopes; arbitrary business data containing an `error` field or error-looking text is still data. Image browsing requires a working configured vision model rather than claiming an unseen image was viewed. Plan-mode JSON is validated before activation. Debate results distinguish actual agreement from a bounded no-agreement compromise; model/protocol errors and cancellation remain failures. These statuses do not replace third-party protocol or Win7 integration validation.

Automatic package-script testing checks for npm before launching any test process and invokes the executable found on PATH by its checked absolute path. Missing npm is an explicit prerequisite error; the bundled Node executable does not include npm, and this check neither installs npm nor guarantees an arbitrary installed npm supports Node 13/Win7. Git tools distinguish a real non-repository from a missing/broken Git executable, config/permission failures and ownership errors. Shell codepage requests do not transcode arbitrary native or cmd redirected error output; those encoding cases still require target validation.

CLI history retention recognizes both a dedicated archive name and `kind: 7coder-cli-session-v1`, keeping twenty new CLI archives and always protecting the current save. It preserves legacy/Web/unknown/corrupt records, evidence and staging files. Changed content or delete errors stop cleanup. Continuing a CLI/legacy archive in the Web UI creates a Web-owned copy instead of overwriting the source; later saves reuse that Web file. Session listing orders by savedAt across both entry points. This is not a total disk quota: Web/legacy history, snapshots, screenshots and other logs still need the separate retention work tracked in T22-26.
