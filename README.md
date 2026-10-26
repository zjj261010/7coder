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

- `write_file` / `append_file` / `edit_file` / `notebook_edit_tool` (and the
  download commit) **automatically back up the previous file** before writing.
  New snapshots publish as an owned store under `.7coder/backups/v1/`:
  `store.json` holds the workspace identity (`storeId`) and a monotonic
  `lastSequence`; each record is `<16-digit sequence>-<32hex id>/` containing
  the raw `data.bak` bytes plus a `manifest.json` (source path, size, sha256).
  A backup reserves its sequence, copies through held descriptors in 64KiB
  chunks, verifies the digest by re-reading, and publishes with one rename.
- Retention computes ONE survivor set: the count quotas (newest 5 per source,
  200 global) and the byte quotas (1GiB owned-bytes target, 2GiB hard
  admission including the new snapshot, 1GiB per snapshot) all count every
  owned record - the just-published snapshot and pinned records occupy quota
  slots and bytes and are only exempt from becoming victims. If pins keep the
  count or byte targets unreachable, that is reported instead of pretended.
  Successive rules trim the previous rule's survivors: per-source, global
  count, then bytes. Expired records cannot consume global quota slots and
  unnecessarily evict another source's only recovery point. Deletion
  re-verifies the record immediately before touching it (directory type and
  real path inside the store root, exactly the two protocol members, payload
  identity and exclusive ownership, manifest storeId and every field, content
  digest), renames it to `.deleting-*`, re-checks the moved object, and only
  then unlinks the two members. The store's real path and identity are fixed
  at discovery and checked against the workspace before destructive steps;
  replacing the store or its ancestors with a junction defers cleanup and
  preserves evidence. Member iterators read at most two entries plus EOF,
  rejecting a third/unknown entry without a full directory array. These
  optimistic checks do not provide an OS atomic compare-and-swap against
  arbitrary external writers between the final check and an IO call.
  Over-budget writes are rejected before the original file is touched. Legacy
  flat `*.bak` files, foreign/corrupt records, staging and crash residue are
  never auto-deleted. Backup/restore copy, hash and cleanup phases check
  cancellation and a per-operation wall-clock budget at entry, between chunks
  and before publication/restore commit, including empty files (5 minutes
  for create/restore, 5 seconds for cleanup passes; a single synchronous OS
  call still cannot be interrupted in JavaScript).
- Transaction cleanup records the parent directory's real path/identity and
  the exclusive temporary descriptor's file identity at creation. State
  replacement, download parts and restore staging re-check those identities
  before commit and cleanup. A replaced file, shared hard link, changed parent
  or missing ownership proof is retained with a diagnostic, rather than
  unlinking whatever currently occupies the old pathname. Install config
  retains its existing explicit allowed root. Backup staging tracks ownership
  separately for its directory, payload and manifest; the manifest is created
  with `wx` and flushed through its own descriptor. A foreign manifest or
  unexpected directory member blocks publication/reclamation without being
  overwritten or deleted. Cleanup remains best effort: evidence may require
  manual inspection, and these path checks cannot eliminate an external
  writer's final-check-to-IO race.
- `/undo <file>` restores the newest backup of a file. New-format history
  wins; legacy flat backups are a fallback only when the source has no v1
  record, and hard-linked legacy payloads are excluded under the same rule as
  the v1 store. A damaged record sharing the newest sequence makes the result
  unknown instead of a guessed restore. The restore stages and verifies the
  content (digest, and the strict parser for managed state files) in a sibling
  temp file, stays inside its operation budget, and commits with a single
  rename; any failure or conflict before that rename leaves the current file
  byte-for-byte intact. Outcomes are explicit: restored, no backup found,
  failed (with stage), conflict, or unknown (index unreadable/incomplete or
  identity cannot be proven) - read failures are never reported as "not
  found". Successful restores may carry warnings (legacy snapshots have no
  creation-time digest; restored managed configuration changes disk only -
  restart or reload to affect running state), printed as `[UNDO WARNING]`.
  The REPL also displays why legacy candidates were excluded, rather than
  collapsing that explanation into a generic "no backup found". Legacy digest
  verification and restore staging share the same operation deadline.
- In default permission mode, file edits are approved against a **real diff
  preview** (`-` removed / `+` added lines), not an LLM paraphrase.

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

MCP stderr keeps a 4 KiB UTF-8 tail, continues draining omitted output, and forwards at most one 4 KiB diagnostic per second and 64 KiB per client lifetime. It skips forwarding when doing so would push the parent's stderr queue over 1 MiB; other log writers retain separate behavior. `/api/info.mcp` exposes active-client queue/cache sizes and stderr byte/suppression/log-budget counters, without raw stderr or schemas. Restarting a client resets its diagnostic budget; this does not rotate every Agent log or bound output CPU.

MCP tool discovery follows at most eight pages, admitting 256 unique nonempty tool names (at most 256 UTF-16 units each) and a 1 MiB JSON cache in total. Cursors are limited to 1024 units and must not cycle. Invalid/over-limit discovery fails without caching a partial list; an invalid forced refresh clears stale cache. One discovery per client can be in flight, with concurrent refreshes refused before sending. Existing complete cached lists remain immediate until refresh or retirement.

Persistent bash accepts one command at a time and retains at most 8 MB of combined stdout/stderr per active command; idle output is discarded. A completion marker plus a 300 ms trailing-output window determines success. Nonzero command status is preserved. Pipe failure, early exit, timeout or output overflow ends the wait and retires the session; the next call starts with fresh cwd/env. These failures also report unknown results. Direct-child termination is best effort; full process-tree cleanup remains separate work.

The old `mcp_url`/`npx_pkg` bridges (custom HTTP POST /invoke protocol) still
work but are legacy - real MCP ecosystem servers need the stdio config above.

## Other Features

- **7CODER.md** — AI automatically creates and updates this file in the project root with all findings and progress.
- **Layered memory (GAP-9)** — durable topic notes in `.7coder/memory/<topic>.md` via `memory_tool {action:save|read|list|delete, topic, content}`; at task start notes whose keywords match your prompt are recalled automatically (plus a topic index). Dream sessions may consolidate them. CJK-aware context budgeting (han chars count x2 toward CONTEXT_CHARS).
- **Structured audit log** - every tool call and permission change is appended as JSON lines to `.7coder/audit.jsonl` (machine-readable, 5 MB rotation, `AUDIT_LOG=false` to disable).
- **Runtime diagnostics** - `/api/info` combines current chat/summary queue load with active task/tool counts, last success/error and logging health. These in-memory counters reset on restart. CLI/HTTP terminal outcomes, tool failures and observed background/cron child closes also write UTF-8 `.7coder/runtime.jsonl`, independently of `AUDIT_LOG`; rotation keeps that file and one `runtime.old.jsonl`, each at most 1 MiB for records written by this logger. Failed rotation skips the append; disk/permission failures remain visible in `runtime.loggingError` and warn at most once per minute. Records limit metadata lengths, retain available errno/path/PID/exit code, and scrub common token forms. They do not copy request payloads or model configuration; error text can still contain input fragments. Early configuration failures before initialization remain on stderr, and a recorded direct-child close does not prove descendants have exited.

`MAX_TOOL_STEPS` limits model tool-call rounds, with a default of 30. Set it to `0` to request a final answer without offering or executing tools. A single permitted round can contain multiple tool calls. Values must be non-negative safe integers; invalid values produce a warning and use 30. This setting does not replace permission controls or the shared execution deadline.

Each model round admits at most 64 tool calls. The complete batch must have distinct nonempty IDs and valid function/argument field types before any call is announced or executed. Oversized or malformed batches fail the task with a clear error; split them into smaller rounds. JSON syntax inside an argument string is still reported as a per-tool parse error. This preflight does not make later IO failures transactional or cap all model-response and tool-output memory.

`read_file` reads regular files asynchronously in 64 KiB chunks. A requested line window can finish before EOF; each operation scans at most 16 MiB and checks a five-second/caller deadline between IO operations. Returned text respects the configured result cap and a physical 128 KiB character ceiling, with room reserved for an incomplete-view warning. Large single lines and unreachable windows produce explicit incomplete output. UTF-8 checks cover scanned bytes; unscanned tails remain unknown. Do not rewrite a whole file from a partial view. The reader closes its descriptor on every settled path and rejects detected file identity/size/timestamp changes; these checks are not a filesystem snapshot or an OS-level IO timeout. Other tools and overall memory use retain separate limits and remaining work.

Text writers accept existing sources and final UTF-8 results up to 8 MiB, including preserved BOMs and normalized newlines; over-limit actions fail before backup or mutation. `edit_file` counts literal nonoverlapping matches and checks the resulting byte size before replacement, using a bounded output buffer rather than per-match split arrays. Notebook edits preflight indentation growth before pretty printing. `prompt_from_file` collects at most 1 MiB and rejects larger files without returning partial instructions. These full-text reads use synchronous bounded chunks and reject detected changes. Approval diffs use sources/results up to 64 KiB; larger bounded texts use complete action arguments with the existing 64 KiB approval-detail limit. A preview size-limit error rejects the action before asking. These are per-operation limits; concurrent calls, JSON parsing, normalization, unrelated tools and native IO still need overall resource/deadline validation.

Offline protocol tests use `test/_protocol.js` to check complete, unique tool-call/result IDs. `test/mock-server.js` accepts `MOCK_STRICT=1` for fixtures with `{expect, reply}` steps; expectations can check the model, tool availability, last user text, and tool results. Strict mode rejects malformed pairing, wrong expectations, unavailable scripted tools and exhausted scripts without advancing the step. Historical positional fixtures retain their repeat-last behavior until explicitly migrated. `npm run test:mock-protocol` exercises both modes against owned local processes.

Streamed tool calls/results, audit tool rows and saved Web activities retain `callId`. IDs up to 256 characters are preserved; longer IDs use a stable SHA-256 digest in these diagnostic fields. Missing IDs remain uncorrelated, including workflow-internal steps without a model ID. Model IDs may repeat in different requests; use the request/turn context when comparing records. This field is not a globally unique execution ID.

Each stdio MCP client admits at most 32 pending requests and 4 MiB of encoded writes awaiting completion callbacks, in addition to its existing 4 MiB frame limit. All clients also share 128 pending slots and 16 MiB of queued writes. Admission/queue overflow rejects the new request as not sent and keeps earlier requests live. Responses release pending slots; write callbacks release queued bytes. Retirement settles sent requests as unknown and clears the retired client's logical counters, but its shared byte charge remains until the write callback, stdin close or child close confirms settlement. Recreating a client cannot bypass that charge. If closure remains unconfirmed, capacity stays reserved; inspect the pipes/processes before restarting the Agent. `/api/info.mcpBudget` exposes aggregate usage and limits even when no client remains in the active array. `npm run test:mcp-aggregate-budget` checks cross-server admission, independent slot/write settlement, late callbacks and owned native pipes.

Incomplete decoded input frames share a separate 16 MiB UTF-8 budget, checked before each fragment is appended. Completed frames release that charge before dispatch; one chunk containing multiple valid frames is processed frame by frame. Exceeding the shared input limit retires the offending client and reports its sent calls as unknown, without discarding other clients' input. Tool discovery accumulators and complete schema caches share 4 MiB, while each client still has the 1 MiB/256 tools/8 pages limit. Failed/cancelled discovery releases its own partial reservation without publishing a partial cache; refresh releases its previous cache first. `/api/info.mcp` includes per-client `incomingBytes` and `schemaBytes`; `mcpBudget` includes both shared usages/limits. `npm run test:mcp-inbound-budget` covers boundaries, concurrent discovery and owned native MCP servers. These are logical UTF-8 retention budgets, not a total heap cap: parsed pending results, JSON allocations, decoder/native pipe buffers and callers retaining returned lists remain separate.

Each upstream model response has an 8 MiB collection limit, shared by streaming, buffered and vision requests. SSE counts all received UTF-8 bytes, including reasoning, tool arguments, comments and unfinished lines; buffered responses also enforce the HTTP adapter's decompressed content limit. Exceeding the limit fails the request, closes the upstream and skips automatic model retries. Partial streaming text may already be visible, but the incomplete choice is not executed as a tool batch. This is a per-response limit, not an overall heap guarantee.

`callOpenAI` also admits outbound JSON within 8 MiB, 100000 values and 64 nested levels. Preflight counts actual escaped UTF-8 JSON bytes before building the complete serialized body; invalid/oversized input fails explicitly before sending or retrying, without truncating messages. Payloads must contain plain JSON data rather than accessors or executable serializers. A single serialized body is reused across retries, with the transport's body limit as a second check. This applies to main, risk, approval, compression, Dream, BTW and summary calls through that helper; direct vision retains its separate image/envelope limits. It does not bound payloads already held by callers or total concurrent heap.

For streamed HTTP operations, cancellation and consumer/parser failure close both the response wrapper and its owned native request. This avoids Node13/Axios wrapped-stream cleanup leaving a raw source socket open after the core has already reported cancellation. Normal completed streams preserve ordinary connection reuse. Native descendants and local file IO have separate ownership/deadline requirements.

Screenshot-to-vision conversion reads at most 4 MiB before Base64 encoding and checks the PNG signature; it does not fully decode or validate PNG contents. Vision URL input is limited to 6 MiB of UTF-8 bytes and its request body to 8 MiB. If a configured vision operation cannot read or encode the captured file, the tool reports an error and retains the screenshot path for diagnosis. Screenshots without a vision model keep their path-only behavior. Names include random bytes to avoid same-timestamp replacement; screenshot disk retention and actual Win7 desktop capture remain separate work.

Buffered fetch/browser/search responses are limited to 2 MiB after decompression. External HTTP MCP requests and responses are limited to 4 MiB; transport or result-formatting failures warn that the remote operation may have run, and are not automatically replayed. Oversized buffered request bodies are refused before sending. Download streaming retains its separate 500 MB disk cap. JSON tool results preflight formatting growth with an 8 MiB text ceiling. Local MCP resource text reads collect at most 4 MiB, and skill instructions 1 MiB; both require lossless UTF-8 and report read/encoding/size failures separately from missing files. Aggregate concurrent memory, all resource listings and caches still require separate limits.

Browser link/text previews and DuckDuckGo HTML results run fixed parsing code in a timed VM, with at most 200 ms or the earlier caller deadline. Malformed tags can make even fixed regexes backtrack; a parsing timeout returns an error rather than a successful empty/partial preview. HTML is passed as data and never evaluated as JavaScript. This limits parser CPU, not native IO or total memory; the VM is not used as a security sandbox. The browser's 20 links/3000 text characters and search's 10 links are display limits inside that shared parse budget.

Glob patterns are limited to 4096 characters. Each file-name/path regex match uses a fixed timed VM script with at most 100 ms, and model-side directory traversal checks five seconds or the earlier caller deadline between IO operations. A matching timeout fails the tool; an exhausted traversal budget reports an explicit incomplete marker. Existing `**/`, `*`, `?`, basename and Windows-separator behavior remains. Internal no-pattern backup walks retain their existing traversal scope. Native directory reads, metadata operations and directory-entry allocation are not hard-aborted by the JS checks.

New Git recovery snapshots use versioned refs scoped to the canonical workspace and tagged stash subjects. Each workspace retains at most 50 owned task checkpoints and 50 owned pre-commit snapshots under normal successful cleanup. Legacy, unknown and symbolic refs are preserved; another worktree has a separate scope. Names remain monotonic across clock rollback and use random nonces. Pruning compares the old object ID and never follows a symbolic ref; failure stops cleanup and keeps the current snapshot. No Git GC is run, so these reference budgets do not impose a byte limit or immediately reclaim old objects. Older recovery hashes can eventually become unavailable after their refs expire and Git performs its own cleanup.
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

Dream consolidation has its own bounded execution control and an exclusively created owner lock that is released in finally. `/bye` uses the same bounded, exact-owner check and never unconditionally deletes foreign or legacy-root locks. A recognized lock from an earlier run can recover under workspace exclusivity; fresh legacy locks retain their grace period. Failed or cancelled dream attempts preserve existing notes and do not record a successful interaction. HTTP chat completion also updates the interaction timestamp.

Each BTW note has a deadline starting when it is queued. Clearing its draft cancels its request and prevents prompt/log injection; cancellation does not fall back to the original note. `/bye` cancels active execution controls and blocks new work. Ordinary stdin EOF retains the existing behavior of letting an already-started task finish.

Workspace `/name` commands load `.7coder/commands/name.md` as complete lossless UTF-8 within 64 KiB, then trim surrounding whitespace as typed input does. Oversized, unreadable, invalid-encoding or empty files report `not queued` and preserve the current draft; command instructions are never silently truncated. Only a missing command retains the literal `/name` input fallback.

Each REPL draft admits at most 1 MiB of UTF-8 text, including capacity reserved for queued BTW notes. Input that does not fit is explicitly refused intact; execute or clear the draft before retrying. A completed note summary must fit alongside other reservations before injection/persistence. At most 32 BTW notes remain unsettled across all drafts, including running or cancelled drafts; `/clear` cancels their work but does not reset admission until their cleanup finishes. These bounds do not limit readline's allocation for one incoming line, the conversation's total history, kernel IO or the whole Agent heap.

The startup workspace sketch and `list_dir`, local MCP resource listing and missing-skill discovery enumerate directories with Node13 `opendirSync`, releasing their handles in `finally`. Tool listings collect at most 200 entries/64 KiB of UTF-8 names and check five seconds or the earlier execution deadline between IO; partial results are marked at the start. Startup discovery also limits each directory to 400 entries and the whole sketch to 2000 visited entries, retaining the existing 150-line/depth-two presentation. Counts from incomplete discovery are lower bounds, not exact totals. Enumeration is in filesystem order before any local sorting; narrow the requested directory/glob to explore omitted paths. Native directory/stat calls cannot be forcibly interrupted by these checks, and session/history/backup indexes have separate remaining work.

Test autodetection reads `package.json` as complete lossless UTF-8/BOM JSON within 1 MiB, validating the manifest object, optional `scripts` object and string `scripts.test` before choosing npm. Loose `*.test.js` discovery uses a bounded 1000-entry directory scan. If no test is found and discovery is incomplete, the tool starts nothing and asks for an explicit framework command; observed loose tests still require a runtime with `--test` support. An explicit command bypasses autodetection metadata, retaining the existing prerequisite/runtime behavior.

Audit records are bounded to 16 KiB including their newline; oversized or non-plain records become marked compact metadata preserving available type/tool/call ID/status/mode and usage counts. The current log rotates before an append would exceed 5 MiB, retaining one old log. Rotation failure stops that append; warnings are rate limited, and `/api/info.audit` reports cumulative written/dropped/compaction-attempt counts, last observed size, last success and current failure. A partial final line or preexisting oversized log is preserved for explicit repair/movement instead of concatenating new records or replacing an older archive. Links/nonregular log paths are refused. Logging failure does not stop core work, so failed intervals intentionally have missing audit evidence. These limits cover this writer under workspace exclusivity; external concurrent writers, total disk retention, power-loss durability and real Win7 sharing/ACL behavior remain separate concerns.

Audit and runtime logs now share the descriptor-based append protocol: capture the log parent identity, reject aliased/nonregular primary/archive files, verify the named file against the opened descriptor, and recheck ownership before short writes. Rotation replaces the archive directly by rename; it never deletes the archive in advance. A failed append retains any torn tail and refuses later concatenation until explicit repair. Runtime logs also preserve preexisting oversized files rather than replacing another archive with them. `npm run test:diagnostic-log-ownership` covers hardlinks, parent junction changes, file replacement, failed rotation and recovery of an actual isolated Agent. These checks reduce detectable path races; they cannot make the final pathname-based rename gap atomic against arbitrary external writers or guarantee hardware durability.

`--background --prompt ...` hands output management to the worker after it acquires the workspace. No log file descriptor is inherited. The launcher drains bootstrap stdout/stderr into an 8192-character tail and includes a bounded recent excerpt when the worker fails before acknowledgement. The worker uses a shared 64 KiB UTF-8 pending buffer, flushes on line/batch boundaries or a 100 ms unreferenced timer, and flushes remaining text on normal process exit. Large writes are streamed through that buffer. `.7coder/background.log` and `background.old.log` each retain at most 1 MiB of output written by this logger; older output is intentionally replaced by rotation. Legacy files already above the cap are retained and require explicit archiving before background startup. Hardlinks, changed parents and failed rotation follow the diagnostic ownership checks. Raw console fragments may end without a newline; the JSONL tail rule remains enabled for audit/runtime logs.

Background logging errors do not block task execution or build an output queue: counters retain dropped bytes/current fault, recovery emits a loss marker, and initialized workers report faults to runtime diagnostics at most once per minute with recursion protection. `/api/info.backgroundLog` exposes those counters when the worker also serves HTTP. A forced kill can lose up to one pending batch; fatal native output or code bypassing the normal Node stdout/stderr write methods is outside this capture contract. `npm run test:background-log-budget` covers buffer/rotation/UTF-8/failure behavior and a directly owned real worker; the workspace-lease and Suite I flush regressions cover actual launcher handoff and retained tool stderr.

Automatic Git commit titles read audit hints within 5 MiB, then scan lines without a split array, up to 50000 records or 200 ms between records. Only complete lines within 16 KiB and registered tool names affect the top-three counts; invalid/overlong/torn or unscanned content produces a `partial audit` title marker. Unavailable/oversized/invalid-encoding logs warn and fall back to a generic title while preserving the intended commit. Cancellation propagates before commit; an explicit title bypasses hint collection. Snapshot retention and Git operations retain their separate contracts.

The packaged UI is read once per HTTP startup within 2 MiB and must be nonempty lossless UTF-8. Missing pages return 404; other read/size/encoding failures return 503, warn at startup and appear in `/api/info.ui`. API readiness remains available for diagnosis and work; UI availability means the file passed these checks, not that a browser executed or rendered it correctly. Repairing the page requires restarting the process. Creating workspace configuration from `.env.example` reads within 1 MiB and propagates template/write errors before any editor launch, rather than selecting a nonexistent fallback `.env`. Existing workspace and install configuration precedence is retained. Desktop command spawning and real Win7 editor/ACL behavior still require their own validation.

`POST /api/open` waits for its system launcher to close: exit 0 returns `200`, `ok:true`, `status:accepted`; launcher errors/nonzero exits return `500`, unknown/overdue close returns `504`, and four unclosed launchers cause `429` without spawning another. Input/configuration errors remain `400` and dry requests still start nothing. Node13-compatible error/exit/close events are used without relying on the newer `spawn` event. A five-second deadline attempts to stop only the retained direct launcher handle; an unconfirmed close retains its capacity slot until a late close reconciles it. Runtime diagnostics and audit records include the outcome, path, PID and available exit/error information. Exit 0 confirms only the launcher, not that an editor/window actually opened or that remote/descendant effects were rolled back.

The UI permits one desktop opening at a time and disables both buttons while waiting. It confirms accepted launcher requests, shows explicit backend rejection, and labels timeout/network/ambiguous responses as an unknown opening result with a prompt to check the desktop before retrying. Its ten-second fetch deadline releases local controls without automatic replay or a claim that the server-side opening was cancelled. Actual Windows `cmd start` interpretation of special-character paths, associations, GUI behavior and full descendant cleanup remain target-machine/separate work.

Budgeted glob/grep traversal reads names incrementally with `opendirSync`, closing every recursion frame in `finally`, including early result limits, errors and cancellation. Glob options default/cap at 1000 matches, four times that many visited entries and depth 12; grep options cap at 5000 scanned files, 20000 visited entries, depth 12 and 50 reported matches per file. The existing five-second/caller deadline and 100 ms matching limits remain. One extra entry may be probed to detect visit-limit exhaustion. Budgeted grep collects each file through the bounded reader (2 MiB with `skipHeavy`, otherwise 8 MiB), refusing detected growth/replacement before matching partial data. Internal calls without options retain their legacy full traversal/whole-file behavior; production search tools always pass budget options. Directory handles, file reads and regex CPU are bounded separately, without an OS-level hard interrupt for native IO.

Auto-debug records actual process exit/close status, bounds combined stdout/stderr at 8 MB, refuses recursive debug and returns failure when repair attempts are exhausted. JS targets use the bundled executable. C# is recompiled after each repair using a compiler found on PATH or in installed Windows .NET Framework directories, passed through executable/argv rather than a shell command. Python requires a discoverable interpreter on PATH; missing Python/Bash/C# prerequisites fail before launching their target. Discovery does not prove compiler/interpreter version compatibility. GUI observation sends no random clicks/typing and cannot validate UI functionality. Existing installations must explicitly set `ENABLE_AUTO_DEBUG=true`; the shipped configuration template defaults it to false. Error-text detection remains heuristic and can require manual review.

For recognized Git for Windows layouts, managed persistent Bash, ordinary Bash commands and `.sh` debug launches select `usr/bin/bash.exe` directly and prepare its Git environment. Holding `bin/bash.exe` alone may only hold a compatibility launcher. Unknown non-Git layouts retain their configured executable; these changes do not provide native ownership of every descendant process tree.

Cancellation still has limits: synchronous operations cannot be interrupted by a JavaScript timer. Startup awaits dream consolidation before the HTTP listener starts, although the wait is now bounded. Auto-debug requests a stop through the live ChildProcess handle, never a saved PID after exit, and waits up to five seconds for close; unconfirmed cleanup is reported as unknown. This does not prove descendants stopped. Process-tree ownership and bounded summary/admission queues remain separate work.

`npm run test:all` runs A–J and the dependency-free UI simulations in sequence using fixed offline defaults. Scenario-specific settings still override them. Set `NODE_BIN` to test the backend with another runtime; UI simulations use the modern Node running the entry point. Set `REAL_TEST=1` to append K/R and preserve real-endpoint settings.

K/R require exactly `REAL_TEST=1`. They use private installs/workspaces, owned Agent processes, dynamic loopback ports, bounded HTTP/SSE reads, explicit DONE/error checks and observed direct-child close. `RUN_ONLY` selects K scenario names or R's `r1`..`r5`. R5 requires a distinct `REAL_SECOND_MODEL`; optional `REAL_SECOND_ENDPOINT` and `REAL_SECOND_API_KEY` configure its profile. Without a distinct model it reports SKIP. These tests cannot prove that a remote gateway maps a model name to particular weights. `npm run test:endpoint-oracles` tests their positive and negative checks against local fixtures, including actual K workflow and R5 routing, without evaluating a real model or contacting an external service.

The entry point also includes `test/stream-context.js` (`npm run test:stream-context`): malformed SSE isolation and next-request recovery, plus context compression failure/empty-summary handling, complete segmented input and verbatim active-instruction retention. A failed context summary stops the current task with its original history intact; it does not continue using a placeholder digest.

Suite I's `compress-edges` and `content-fallback` use strict local scripts and shared business predicates in `test/_i-context-fixture.js`. They check the complete compression transcript, distinct main/light calls, unchanged active instructions and tool pairing, one audited read, exact nested JSON and literal string content, and recovery after a nonretryable upstream HTTP 400. `npm run test:i-context-oracles` supplies positive and negative controls for those same predicates, including truncation, wrong digests, missing/duplicate results, request contamination and unexpected retries. These local fixtures do not evaluate real-model summary quality or replace Win7/browser acceptance.

Suite I's `cancel-boundary` uses explicit gates in a private local endpoint to hold each background summary until the complete streamed/JSON reply has returned. Bounded condition waits replace fixed startup/300 ms sleeps. It checks the exact four main/summary requests, task/response ownership, one ordered bullet per summary and released queue counters. Main and summary requests use the same fixture model name; tool availability, complete prompts and transport mode distinguish their roles. `npm run test:i-summary-oracles` checks that wrong/missing/duplicate calls, truncated or crossed responses, misplaced bullets and retained queue bytes fail these predicates. This covers normal HTTP completion; active client aborts remain separate cancellation tests.

`npm run test:context-budget` checks compression admission and recovery. Before weighted size counting, history must fit 8 MiB of serialized JSON; the portion selected for summarization must fit 1 MiB before any full transcript is built. These limits include JSON escaping and share the model serializer's depth/value limits. Every admitted character reaches the model in parts of at most 20,000 UTF-16 units, with surrogate pairs kept intact. Only part boundaries are retained. Combined summaries, including separators, are limited to 256 KiB UTF-8; each raw response must also fit the remaining budget before trimming. Oversized input or output, a failed part, cancellation, or failed replacement validation stops compression with the original message array intact. This intentionally refuses some large histories that could otherwise be compressed; split large input at the source. It is a local allocation bound, not a total Agent heap guarantee or a guarantee of summary quality.

`npm run test:repl-approval` covers the CLI question queue and actual isolated REPL against a local model fixture: parallel protected reads, approval EOF, ordered BTW notes, repeated execution commands and stale notes after `/clear`. The REPL asks one question at a time; EOF declines unanswered approvals and marks unanswered user questions unreachable. `/bye` remains available during a question. `/execute-task-now` takes the current draft immediately, waits for all its earlier BTW notes, and holds the execution slot while waiting. Input and BTW notes received afterwards belong to the next draft; another execution command while busy is refused and must be issued again after completion. `/clear` discards the current draft, including late results of its pending notes. Non-interactive user-question tools return an explicit unreachable result.

`npm run test:download-commit` checks download replacement and failure recovery with real files, streams and local fixtures. Downloads exclusively create a unique sibling `.part-*` file, wait for writer close, flush the completed file and publish a complete previous-version backup before renaming over an existing destination. A failed rename never falls back to deleting the destination. Failed backup/flush/close operations stop the replacement. Completed backups publish as owned v1 records and are restorable with `/undo <path>` (the successful download result reports its backup path); the just-published record is protected during retention. Text writers share the strict snapshot routine described below. `npm run test:backup-ownership` and `npm run test:backup-restore` cover the ownership, retention, budget and atomic-restore contracts with real files and subprocess crash points.

On restart, use the destination as it stands: there is no intermediate step that removes the old destination. Incomplete `.part-*` files, `.stage-*` directories and other crash residue are never automatically promoted, claimed or selected by `/undo`. After an interrupted commit, the complete previous version can be restored with `/undo <path>`. Temporary cleanup failures report the retained path. Interrupted operations may leave temporary files; inspect them before manual removal, especially if another instance is active. Backups have count and byte budgets and require space for the previous file; this does not guarantee hardware power-loss durability or coordinate concurrent instances. Real Win7 filesystem/antivirus and power-cut verification remain required.

`npm run test:text-encoding` checks text safety and strict backups. `read_file` and `prompt_from_file` require lossless UTF-8 decoding. Existing files used by `write_file`, `append_file`, `edit_file` and `notebook_edit_tool` must also pass that check before mutation. Invalid UTF-8, common GBK/CP936/UTF-16 byte sequences and NUL-containing text are refused with an explicit error. Tool input rejects unpaired surrogates and NUL. This is a UTF-8 contract: bytes that happen to be valid in both UTF-8 and a legacy encoding cannot reveal their intended encoding. Prepare an explicitly converted copy for legacy projects; the Agent does not guess or automatically convert them.

`npm run test:model-routing` runs the real backend against two local fixture endpoints that each reject foreign model names and keys. It exercises per-request selection, settings/profile hot changes during a held request, default and explicit helpers, compression, approval, planning, synthetic output, direct/workflow sub-agents and action summaries. It uses no real model service.

`npm run test:pipe-lifecycle` injects asynchronous Writable errors and late child events into the original transports, checks timeout/dispose settlement and byte limits, then exercises owned real MCP children and available Git Bash. Missing bash is explicitly skipped. This does not substitute for Win7 native pipe faults, process-tree ownership or long-running stress tests.

`npm run test:state-store` checks state replacement with real temporary files, injected disk/permission/flush/close/rename failures, abrupt process exits at commit boundaries, native HTTP handlers and second-start/CLI resume recovery. It uses no model service or real user configuration.

Agent-owned todos, CLI/web sessions, model profiles, workspace `.env`, memory notes and worklogs use exclusive sibling staging files, file flush/close, then rename replacement. The destination is never deleted first. `<file>.7coder-prev` retains the preceding complete version; identical writes preserve that version. JSON stores validate their shape and accept a UTF-8 BOM. Invalid JSON/schema/UTF-8 is preserved as `<file>.7coder-corrupt-<sha256>` before restoring a valid previous version. Without a valid version, reads/writes fail visibly; todos do not silently become an empty list. Unrecoverable `.env` encoding or model profiles stop startup, and failed settings persistence leaves runtime settings unchanged. Plain text and dotenv retain their existing syntax/semantics: valid UTF-8 text or syntactically valid but semantically incomplete JSON cannot always be identified as damaged.

Manual `mcp.json` and `permissions.json` configurations (installation and workspace layers) accept lossless UTF-8 JSON with an optional BOM, up to 1 MiB per file. A missing file is optional; an existing unreadable, invalid or oversized configuration stops startup before ready, preserving the file. These manual files are not automatically repaired from previous versions. Both layers validate before publication: MCP admits up to 32 merged server names and validates command/args/cwd/env types; permissions admit up to 1000 distinct rules across all buckets/layers, each at most 4096 UTF-16 units. Invalid recognized permission fields/rules fail instead of silently removing restrictions; unrelated metadata is ignored. MCP workspace overrides, bare server maps and deny-over-allow behavior remain supported. Empty JSON objects explicitly disable a layer's entries; deleting an entry from the workspace does not remove an installation entry.

Permission argument and protected-file wildcards match the entire text, case-insensitively, with `*` spanning any characters including newlines. Matching searches ordered fixed literals instead of translating stars to a backtracking regex; ordinary regex metacharacters stay literal. A pattern admits at most 128 nonempty literal segments, with repeated adjacent stars retaining the same meaning. Tool argument text is computed once per permission bucket. This prevents wildcard-combination backtracking; large aggregate policy/input workloads still need overall execution budgets.

Managed state reads, previous versions and existing corruption evidence have an 8 MiB byte ceiling, checked on the opened file and while collecting chunks. Proposed writes are checked before encoding/JSON validation. Oversized files fail visibly in place, without duplicating them as evidence or restoring over them, even when a valid previous version exists; repair or move the oversized file explicitly before retrying. Normal bounded corruption recovery is unchanged. Detected read-time file changes also fail without recovery. The limit applies before startup config parsing, so oversized `.env`/model profiles cannot produce a ready Agent; it is a per-file collection limit, not an overall heap or OS IO deadline guarantee. Saved conversations retain their stricter 2 MiB write limit.

Disabled Dream maintenance reads no interaction timestamp or lock. Enabled maintenance reads timestamps within 1 KiB and owner locks within 4 KiB; only a missing timestamp may fall back to the legacy layout. Invalid/unreadable metadata defers automatic consolidation, and unavailable source notes fail maintenance before a model call. Legacy BTW reads use the state-size budget and warn on incomplete migration. CLI archive selection and pre-delete hash checks share the bounded retention pass described below; detected growth is rejected instead of collecting the enlarged file. Directory-wide disk quotas and the Web history index retain separate work.

Legacy `BTW.md` migration publishes a small `.7coder/btw-migration.json` intent journal before appending to `.7coder/BTW.md`. Source and before/after target hashes distinguish pending writes from already committed appends; failed source deletion or abrupt process exit can resume without appending twice. The target is verified before source cleanup, and the journal is removed last. Conflicting edits or invalid metadata retain available files/journal and warn for manual review. Source links/directories and detected source/target hardlink aliases are refused. Content checks are optimistic: external writes between checks/native replacement, loss of both copies, directory durability on power failure and real Win7 file-sharing behavior still require separate validation.

Automatic memory recall and list previews read each note/previous version within 64 KiB, retaining at most five scored note bodies. Corruption evidence is compared within the expected source-byte size. Explicit `memory_tool read` retains the larger state limit. Recall respects protected-file patterns, isolates unavailable notes, and marks incomplete input instead of dropping the user's request. Scoring computes at most 128 distinct keywords from the first 8192 prompt characters once; the original prompt remains intact. Injected note bodies respect the configured weighted-unit budget with a 16384-unit ceiling, preserving emoji pairs. Directory discovery uses bundled Node13.14 `opendirSync`, closes handles, and visits at most 400 entries to discover up to twenty valid regular-note topics; limits/errors are explicit. Note-reading/scoring checks a five-second scan budget between IO. Native directory IO, aggregate requests and total memory-note disk retention remain separate constraints.

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

Existing UTF-8 BOMs are retained. Uniform CRLF, LF or CR line endings are used for incoming write/append/replacement text and edit matching; untouched bytes stay intact. Mixed/no line-ending styles keep incoming text literal. Every existing target modified by those four text writers requires a complete, flushed, published backup; backup or recovery-metadata failure stops the write. Backup ordering uses the store's monotonic sequence, so rapid writes, tied timestamps and clock rollback cannot make `/undo` select an older generation. Managed state text writers additionally use the state protocol above. Other user-file writes retain their ordinary write/append behavior: an interrupted or partially failed write can require `/undo` recovery.

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

CLI retention collects at most 4096 directory entries / 256 KiB of UTF-8
names, inspects at most 256 CLI-looking candidates, and shares a 64 MiB
archive-read budget and five-second deadline across discovery and pre-delete
verification. Each archive remains limited to 2 MiB and is read in 64 KiB
chunks through a held descriptor. Failed or unowned payload reads also consume
the byte budget; hard-linked records are preserved. Incomplete discovery
cannot authorize deletion. If a budget is exhausted, cleanup reports its
reason and counts, keeps the primary session already saved, and starts no
automatic retry. History may exceed twenty until a later successful pass or
explicit maintenance; this bounds collection, not total disk use. Directory
identity and workspace boundaries are checked again before deletion. Native
IO still cannot be interrupted within one synchronous OS call, and ordinary
path checks are not an atomic condition against arbitrary external writers.
CLI retention and the Web listing below have separate collection budgets.

The Web history list uses a resumable, read-only in-memory metadata index.
`GET /api/sessions` returns either `status: "indexing"` (with an empty
`sessions` array and a continuation `cursor`) or `status: "ready"` (at most
50 rows). Continue indexing with `GET /api/sessions?cursor=<cursor>` until a
ready page arrives; an empty indexing response does **not** mean the history
is empty. Ready pages expose `previousCursor` and `nextCursor`. Each page
finishes directory discovery before selecting its globally ordered time
window, so old records remain reachable without treating filesystem order
as newest-first. Unreadable previews are marked and counted in `uncertain`;
their unknown timestamps cannot establish the newest session.

Search uses `?q=<text>` (at most 160 UTF-8 bytes) and matches the first user
message's 80-character preview across the directory, rather than just the
currently displayed page. A request visits at most 512 entries / 256 KiB of
names, reads at most 8 MiB of archive bytes, and checks a two-second deadline;
each preview file remains limited to 2 MiB. One scan retains at most fifty
candidate rows, the metadata LRU holds 512 records, and eight completed pages
are cached. There are at most sixteen pending cursors and four open or
unconfirmed-close directory slots. Idle cursors expire after five minutes
(checked on requests and by an unreferenced timer at most every thirty
seconds). Closing the server releases the pager; native close errors remain
visible in `/api/info.sessionHistory` and consume admission capacity, rather
than silently allowing unlimited new handles. All history queries retain the
normal HTTP authentication gate.

Saving or deleting through the Web API invalidates old cursors; HTTP 410
asks the client to refresh instead of mixing generations. The UI provides
previous/next/refresh controls, replaces rather than appends page rows, and
allows at most sixteen automatic indexing requests and fifteen seconds per
action before offering manual continuation or retry. Late responses cannot
replace a newer page. Automatic restore loads the remembered filename
directly even when it is outside the first page; without one, incomplete or
uncertain indexing never authorizes a guessed newest restore.

The index does not create disk metadata or repair/quarantine history files.
Each newly requested time window traverses the directory again; beyond the
metadata cache, this can require repeated body IO. This bounds working
collection and response size, not total directory size, total lifetime IO,
hardware latency or the Agent's complete memory usage. Native synchronous
calls cannot be interrupted, and arbitrary external edits across pages are
not an atomic snapshot; refresh after such changes. Real Win7/browser and
long-running filesystem validation remain required.
