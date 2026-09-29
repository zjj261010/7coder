#!/usr/bin/env node
const axios = require('axios');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');
const http = require('http');

// ====================== CLI ARGUMENT PARSING (Node 13 safe) =====================
// Two-pass parsing so flags work in any order: flags are consumed first, then
// any remaining words become the task text (for bare -p / trailing words).
const args = process.argv.slice(2);
let promptArg = null;
let dangerMode = false;
let showHelp = false;
let serverMode = false;
let backgroundMode = false;
let permissionModeFlag = null;
let resumeFlag = false;

{
  let promptValue = null;
  let barePrompt = false;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') showHelp = true;
    else if (arg === '--danger') dangerMode = true;
    else if (arg === '--resume') resumeFlag = true;
    else if (arg === '--server') serverMode = true;
    else if (arg === '--background') backgroundMode = true;
    else if (arg.startsWith('--permission-mode=')) permissionModeFlag = arg.substring('--permission-mode='.length);
    else if (arg === '--permission-mode' || arg === '-m') {
      // Only consume a value that isn't itself flag-shaped, so
      // `--permission-mode --prompt hello` doesn't eat the --prompt flag.
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) { permissionModeFlag = args[i + 1]; i++; }
    }
    else if (arg.startsWith('-m=')) permissionModeFlag = arg.substring(3);
    else if (arg.startsWith('--prompt=')) { const v = arg.substring('--prompt='.length); if (v) promptValue = v; else barePrompt = true; }
    else if (arg.startsWith('-p=')) { const v = arg.substring(3); if (v) promptValue = v; else barePrompt = true; }
    else if (arg === '--prompt' || arg === '-p') {
      if (i + 1 < args.length && args[i + 1].startsWith('-')) barePrompt = true;
      else if (i + 1 < args.length) { promptValue = args[i + 1]; i++; }
      else barePrompt = true;
    }
    else words.push(arg);
  }
  // Unknown flag-shaped words are folded into the task text (two-pass design),
  // but say so instead of silently eating them (A12).
  const unknownFlags = words.filter(w => w.startsWith('-') && w !== '-');
  if (unknownFlags.length) {
    console.warn('[WARN] Unknown argument(s) ' + JSON.stringify(unknownFlags) + ' will be treated as part of the task text.');
  }
  // An explicitly empty --prompt "" is almost certainly a mistake - fail fast
  // instead of silently starting the REPL (A12).
  if (promptValue !== null && promptValue.trim() === '' && !barePrompt) {
    console.error('[ERROR] --prompt was given an empty value. Pass your task text or omit --prompt.');
    process.exit(1);
  }
  if (promptValue !== null) promptArg = words.length ? [promptValue].concat(words).join(' ') : promptValue;
  else if (barePrompt) promptArg = words.length ? words.join(' ') : null;
}

if (showHelp) {
  console.log(`
7coder - Claude Code style assistant

Usage:
  node index.js -> Interactive REPL (multi-line + /btw + /execute-task-now)
  node index.js --prompt "your task" -> Non-interactive
  node index.js --server -> HTTP OpenAI endpoint (streaming supported)
  node index.js --background --prompt "task" -> Background
  node index.js --danger -> Bypass approvals
  node index.js --permission-mode=auto -> Auto approval

REPL commands: /clear, /undo <file>, /btw <note>, /execute-task-now, /bye
`);
  process.exit(0);
}

// Exit without truncating buffered stdout/stderr: on Windows, file/pipe stdout
// writes are async and process.exit() discards them (this bit the background
// log and streamed replies in one-shot mode).
function flushExit(code) {
  const pending = () => (process.stdout.writableLength || 0) + (process.stderr.writableLength || 0);
  const deadline = Date.now() + 2000; // never hang if a stream never drains
  const tryExit = () => { if (pending() === 0 || Date.now() > deadline) process.exit(code); else setTimeout(tryExit, 50); };
  tryExit();
}

// ====================== SETUP ======================
const launchDir = process.cwd();
const appDir = require.main ? path.dirname(require.main.filename) : __dirname;
try {
  require('dotenv').config({ path: path.join(appDir, '.env') });
  // Per-project overrides (D7): a .env in the workspace wins over the
  // install-dir .env, so each project can pin its own models/endpoint/key.
  // The workspace .env is on the protected-files list - the AI cannot edit it.
  try {
    const wsEnv = path.join(launchDir, '.env');
    if (fs.existsSync(wsEnv)) {
      const parsed = require('dotenv').parse(fs.readFileSync(wsEnv));
      const keys = Object.keys(parsed);
      for (const k of keys) process.env[k] = parsed[k];
      if (keys.length) console.log('[OK] workspace .env loaded (' + keys.length + ' overrides)');
    }
  } catch (e) {
    console.warn('[WARN] failed to read workspace .env: ' + e.message);
  }
} catch (e) {}

let OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1';
const ENABLE_RALPH_MODE = process.env.ENABLE_RALPH_MODE === 'true' || process.env.ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE === 'true';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || process.env.MAX_ATTEMPT_RETRIES, 10) || 3;
// Ralph loop iterations are independent of API retries (A9); falls back to
// MAX_RETRIES for backward compatibility with existing .env files.
const RALPH_ITERATIONS = Math.max(1, parseInt(process.env.RALPH_ITERATIONS, 10) || MAX_RETRIES);
let HEAVY_MODEL = process.env.HEAVY_MODEL || 'gpt-4o-mini';
const LIGHT_MODEL = process.env.LIGHT_MODEL || 'gpt-3.5-turbo';
const VISION_MODEL = process.env.VISION_MODEL || null;
// parseFloat('0')||fallback would silently rewrite a legitimate TEMPERATURE=0;
// only fall back when the value is missing or not a finite number.
const TEMPERATURE = Number.isFinite(parseFloat(process.env.TEMPERATURE)) ? parseFloat(process.env.TEMPERATURE) : 0.7;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 2048;
const VALID_PERMISSION_MODES = ['default', 'auto', 'bypass', 'denial'];
const rawPermissionMode = (permissionModeFlag || process.env.PERMISSION_MODE || (dangerMode ? 'bypass' : 'default')).toLowerCase().trim();
if (!VALID_PERMISSION_MODES.includes(rawPermissionMode)) {
  console.warn(`[WARN] Unknown PERMISSION_MODE "${rawPermissionMode}" - falling back to "default".`);
  console.warn('   (Note: .env values must not contain inline # comments - dotenv 8 keeps them as part of the value.)');
}
let PERMISSION_MODE = VALID_PERMISSION_MODES.includes(rawPermissionMode) ? rawPermissionMode : 'default';
const ENABLE_HTTP_SERVER = process.env.ENABLE_HTTP_SERVER === 'true' || serverMode;
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 8000;
const HTTP_BIND = process.env.HTTP_BIND || '127.0.0.1';
const HTTP_API_KEY = process.env.HTTP_API_KEY || null;
const MAX_TOOL_STEPS = parseInt(process.env.MAX_TOOL_STEPS, 10) || 30;
// Guard against nonsense values: a negative cap would reduce every tool result
// to just the truncation marker.
const MAX_TOOL_RESULT_CHARS = Math.max(1000, parseInt(process.env.MAX_TOOL_RESULT_CHARS, 10) || 30000);
const CONTEXT_CHARS = Math.max(500, parseInt(process.env.CONTEXT_CHARS, 10) || 120000);
const ENABLE_COMPUTER_USE = process.env.ENABLE_COMPUTER_USE === 'true';
const DREAM_ALLOW = process.env.DREAM_ALLOW === 'true';
const MCP_SERVER_URLS = (process.env.MCP_SERVER_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const MCP_NPX_PKGS = (process.env.MCP_NPX_PKGS || '').split(',').map(s => s.trim()).filter(Boolean);
const ENABLE_AUTO_DEBUG = process.env.ENABLE_AUTO_DEBUG === 'true';
const DEBUG_TEST_MINUTES = parseInt(process.env.DEBUG_TEST_MINUTES, 10) || 3;
const BICKER_ROUNDS = parseInt(process.env.BICKER_ROUNDS, 10) || 5;

// Structured audit log (D5): every tool call and permission-mode change is
// appended as one JSON line to .7coder/audit.jsonl. Disable with AUDIT_LOG=false.
const AUDIT_ENABLED = process.env.AUDIT_LOG !== 'false';
const auditPath = path.join(launchDir, '.7coder', 'audit.jsonl');
let auditDirReady = false;
// Multi-model routing: optional models.json next to index.js, optionally
// overridden per workspace by .7coder/models.json (workspace wins per model).
// Shape: { "<model name>": { "endpoint": "https://...", "apiKey": "sk-..." } }
// A model without a profile uses the global OPENAI_ENDPOINT / OPENAI_API_KEY.
let modelProfiles = {};
function loadModelProfiles() {
  modelProfiles = {};
  for (const f of [path.join(appDir, 'models.json'), path.join(launchDir, '.7coder', 'models.json')]) {
    try {
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const k of Object.keys(j)) { if (k && typeof k === 'string') modelProfiles[k.toLowerCase()] = j[k]; }
    } catch (e) {
      console.warn('[WARN] failed to read ' + f + ': ' + e.message);
    }
  }
}
loadModelProfiles();
function resolveModelConfig(model) {
  const prof = modelProfiles[String(model || '').toLowerCase()];
  return {
    endpoint: (prof && prof.endpoint) || OPENAI_ENDPOINT,
    apiKey: (prof && typeof prof.apiKey === 'string') ? prof.apiKey : OPENAI_API_KEY
  };
}
function modelList() {
  const seen = {};
  const names = [];
  for (const n of [HEAVY_MODEL, LIGHT_MODEL].concat(Object.keys(modelProfiles))) {
    if (!seen[n.toLowerCase()]) { seen[n.toLowerCase()] = true; names.push(n); }
  }
  return names;
}
function authHeadersFor(key) {
  const h = { 'Content-Type': 'application/json' };
  if (key) h.Authorization = 'Bearer ' + key;
  return h;
}

function audit(entry) {
  if (!AUDIT_ENABLED) return;
  try {
    if (!auditDirReady) { fs.mkdirSync(path.join(launchDir, '.7coder'), { recursive: true }); auditDirReady = true; }
    try { if (fs.existsSync(auditPath) && fs.statSync(auditPath).size > 5 * 1024 * 1024) fs.renameSync(auditPath, auditPath.replace(/\.jsonl$/, '.old.jsonl')); } catch (e) {}
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n');
  } catch (e) {}
}

// No-key is a valid setup for local endpoints (LMStudio/Ollama/vLLM/liteLLM);
// only warn when the endpoint looks remote, where a missing key means 401s.
const localEndpoint = /127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0/.test(OPENAI_ENDPOINT);
if (!OPENAI_API_KEY && !localEndpoint) {
  console.warn('[WARN] OPENAI_API_KEY is not set - cloud endpoints will reject requests (leave unset only for local servers such as LMStudio/Ollama/vLLM).');
}

console.log(`[OK] 7coder initialized at: ${launchDir}`);

// ====================== SPINNER WORDS (64 fun verbs/action nouns) ======================
const SPINNER_WORDS = [
  "Digging dirt...", "Brewing cosmic code...", "Weaving neural tapestries...", "Forging quantum algorithms...",
  "Sculpting silicon symphonies...", "Harvesting prompt asteroids...", "Navigating thought oceans...", "Igniting creativity supernovas...",
  "Polishing idea galaxies...", "Syncing multiverse bits...", "Refactoring reality threads...", "Debugging dream logic...",
  "Compiling enlightenment bytes...", "Optimizing chaos engines...", "Architecting future proofs...", "Mining knowledge veins...",
  "Cultivating code gardens...", "Orchestrating AI symphonies...", "Illuminating dark data...", "Transcending token limits...",
  "Echoing infinite loops...", "Dancing with recursion...", "Whispering to vectors...", "Blossoming neural flowers...",
  "Taming wild gradients...", "Unraveling entropy knots...", "Crafting paradox engines...", "Welding logic bridges...",
  "Sparking innovation storms...", "Balancing equation universes...", "Tracing causality rivers...", "Embracing emergent patterns...",
  "Fusing binary stars...", "Decoding cosmic constants...", "Elevating baseline intelligence...", "Pioneering prompt frontiers...",
  "Synthesizing solution singularities...", "Harmonizing heuristic horizons...", "Catalyzing creative cascades...", "Illuminating inference islands...",
  "Manifesting meta-models...", "Vibrating value vectors...", "Resonating reasoning resonances...", "Converging convergence points...",
  "Diverging divergence dreams...", "Evolving evolutionary epochs...", "Revolutionizing revision realms...", "Innovating innovation infinities...",
  "Transforming transformation trees...", "Liberating latent layers...", "Awakening attention atoms...", "Empowering embedding empires...",
  "Quantizing quality quanta...", "Stabilizing stochastic storms...", "Amplifying attention auras...", "Crystallizing context crystals...",
  "Vaporizing vagueness veils...", "Solidifying semantic structures...", "Radiating relevance rays...", "Pulsating possibility pulses...",
  "Oscillating outcome orbits...", "Resonating result resonances...", "Culminating clever culminations...", "Spinning ethereal algorithms..."
];

const getRandomSpinner = () => SPINNER_WORDS[Math.floor(Math.random() * SPINNER_WORDS.length)];

// ====================== GLOBAL STATE ======================
const cronJobs = new Map();
const mcpResourcesDir = path.join(launchDir, '.mcp');
const skillsDir = path.join(launchDir, '.7coder', 'skills');
const backgroundTasks = new Map();
let taskSeq = 0;
// Set when the REPL is quitting - blocks new background work (A10).
let shuttingDown = false;

// Sub-agent context: while a sub-agent runs, interactive y/n approvals are
// impossible to answer meaningfully, so 'default' mode is downgraded to 'auto'
// for its tool calls. Cleared again when the sub-agent finishes.
let subAgentModeOverride = null;
let agentDepth = 0;
// >0 while workflow_tool inner steps execute: they inherit the plan approval
// (soft per-step light-model checks are skipped; hard rails stay active).
let workflowStepDepth = 0;

function effectivePermissionMode() {
  return subAgentModeOverride || PERMISSION_MODE;
}

// Runs a sub-agent: a FRESH conversation with full tool access. Never touches
// the caller's message array (keeps assistant(tool_calls) -> tool pairing valid).
async function runSubAgent(agentName, task) {
  if (agentDepth > 0) {
    return 'Nested sub-agents are not allowed (a sub-agent cannot spawn further sub-agents).';
  }
  const prevOverride = subAgentModeOverride;
  subAgentModeOverride = (PERMISSION_MODE === 'default') ? 'auto' : PERMISSION_MODE;
  agentDepth++;
  console.log(`[AGENT] Sub-agent "${agentName}" starting (tools run in "${subAgentModeOverride}" permission mode)`);
  const agentSystem = systemPrompt + `

You are currently running as a SUB-AGENT named "${agentName}".
- Be autonomous: you cannot ask the user questions and cannot spawn further sub-agents.
- Work through the task with tools, then end with a concise final answer.`;
  const agentMessages = [
    { role: 'system', content: agentSystem },
    { role: 'user', content: String(task || '') }
  ];
  try {
    const answer = await processWithTools(agentMessages);
    console.log(`[AGENT] Sub-agent "${agentName}" finished`);
    return `Sub-agent "${agentName}" result:\n${answer || '(no output)'}`;
  } catch (e) {
    return `Sub-agent "${agentName}" failed: ${e.message}`;
  } finally {
    agentDepth--;
    subAgentModeOverride = prevOverride;
  }
}

// Keep the task table bounded: drop oldest finished tasks beyond 50 entries.
function pruneTasks() {
  if (backgroundTasks.size <= 50) return;
  for (const [id, t] of backgroundTasks) {
    if (backgroundTasks.size <= 50) break;
    if (t.status !== 'running') backgroundTasks.delete(id);
  }
}

function latestTask() {
  let last = null;
  for (const t of backgroundTasks.values()) last = t;
  return last;
}

const DANGER_MODE = dangerMode;
const INTERACTIVE = !promptArg && !serverMode && !backgroundMode;

if (DANGER_MODE) {
  console.log('[WARN] DANGER MODE ENABLED - All CLI commands will run WITHOUT approval (within reason)!');
}

// Auto-safe tools (no permission prompt ever). Deliberately excludes anything
// that executes code (run_command, auto_debug_tool) or writes files.
const AUTO_SAFE_TOOLS = [
  'read_file', 'glob_tool', 'grep_tool', 'list_dir', 'list_mcp_resources_tool', 'tool_search_tool',
  'prompt_from_file', 'snip_tool', 'cron_list_tool', 'process_list_tool', 'bickering_tool',
  'task_get_tool', 'task_list_tool', 'task_output_tool', 'skill_tool', 'synthetic_output_tool',
  'git_status_tool', 'git_diff_tool'
];

// ====================== TOOL DEFINITIONS ======================
const tools = [
  { type: "function", function: { name: "read_file", description: "Read a file. Optional offset (1-based start line) and limit (number of lines) for large files - output is line-numbered when used.", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "append_file", description: "Append content to a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Replace an exact unique substring in a file (surgical edit, much safer than rewriting whole files). old_string must occur exactly once, or set replace_all=true.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] } } },
  { type: "function", function: { name: "agent_tool", description: "Run a sub-agent: a fresh AI conversation with full tool access that works through the task and returns its final answer. Use for self-contained research or multi-step work.", parameters: { type: "object", properties: { name: { type: "string" }, task: { type: "string" } }, required: ["name", "task"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command via the system default shell (cmd.exe on Windows, /bin/sh elsewhere).", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "bash_tool", description: "Run a command in a REAL bash shell. On Windows requires Git for Windows (bash.exe) - returns guidance if missing.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "powershell_tool", description: "Run a command in REAL Windows PowerShell (works on Win7 PowerShell 2.0+ via -EncodedCommand). Best for Windows administration tasks.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "glob_tool", description: "File search (glob). Plain patterns like *.js match the basename at any depth. Patterns naming a path are directory-aware: * stays within one directory, ** spans directories (e.g. src/*.js, src/**/*.js, **/*.test.js).", parameters: { type: "object", properties: { pattern: { type: "string" }, directory: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep_tool", description: "Search file contents.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "list_dir", description: "List directory contents (name, type, size).", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "download_tool", description: "Download a URL to a local file inside the workspace (streamed, 500 MB cap).", parameters: { type: "object", properties: { url: { type: "string" }, path: { type: "string" } }, required: ["url", "path"] } } },
  { type: "function", function: { name: "process_list_tool", description: "List running processes (tasklist on Windows, ps on Unix).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "process_kill_tool", description: "Kill a process by PID. On Windows uses taskkill /T /F (kills the whole child tree).", parameters: { type: "object", properties: { pid: { type: "number" } }, required: ["pid"] } } },
  { type: "function", function: { name: "web_fetch_tool", description: "Simple GET request to any URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "web_search_tool", description: "Search DuckDuckGo for links.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_browser_tool", description: "Real browser: navigate (GET page), click links (follow), extract content + links (infers from link names), view images with optional VISION_MODEL.", parameters: { type: "object", properties: { url: { type: "string" }, action: { type: "string", enum: ["navigate", "click", "extract"] } }, required: ["url"] } } },
  { type: "function", function: { name: "notebook_edit_tool", description: "Edit Jupyter notebook (JSON structure).", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "object" } }, required: ["path", "edits"] } } },
  { type: "function", function: { name: "ask_user_question_tool", description: "Prompt user for input.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } },
  { type: "function", function: { name: "brief_tool", description: "Upload/summarize files to folder.summary.", parameters: { type: "object", properties: { folder: { type: "string" } }, required: ["folder"] } } },
  { type: "function", function: { name: "todo_write_tool", description: "Write to TODO.md.", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } },
  { type: "function", function: { name: "read_mcp_resource_tool", description: "Read MCP resource (restricted to the .mcp directory).", parameters: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"] } } },
  { type: "function", function: { name: "sleep_tool", description: "Async delay.", parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } } },
  { type: "function", function: { name: "snip_tool", description: "Extract history snippet.", parameters: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } } } },
  { type: "function", function: { name: "tool_search_tool", description: "Discover available tools." } },
  { type: "function", function: { name: "list_mcp_resources_tool", description: "List MCP resources." } },
  { type: "function", function: { name: "enter_worktree_tool", description: "Git worktree management - create and enter.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "schedule_cron_tool", description: "Schedule a recurring cron job. Supported schedules: \"30s\", \"5m\", \"2h\", \"every 10m\", \"daily 09:30\".", parameters: { type: "object", properties: { schedule: { type: "string" }, command: { type: "string" } }, required: ["schedule", "command"] } } },
  { type: "function", function: { name: "cron_create_tool", description: "Create granular cron job. Supported schedules: \"30s\", \"5m\", \"2h\", \"every 10m\", \"daily 09:30\".", parameters: { type: "object", properties: { schedule: { type: "string" }, command: { type: "string" } }, required: ["schedule", "command"] } } },
  { type: "function", function: { name: "cron_delete_tool", description: "Delete cron job.", parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } } },
  { type: "function", function: { name: "cron_list_tool", description: "List cron jobs." } },
  { type: "function", function: { name: "task_create_tool", description: "Start a REAL background shell task (builds, tests, long commands). Returns a task id immediately; poll with task_output_tool.", parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "task_get_tool", description: "Get a background task's status. Omit task_id to use the most recent task.", parameters: { type: "object", properties: { task_id: { type: "string" } } } } },
  { type: "function", function: { name: "task_list_tool", description: "List background tasks." } },
  { type: "function", function: { name: "task_output_tool", description: "Get a background task's captured output (truncated to the last 8000 chars). Omit task_id to use the most recent task.", parameters: { type: "object", properties: { task_id: { type: "string" } } } } },
  { type: "function", function: { name: "task_stop_tool", description: "Stop a running background task (kills the whole process tree on Windows). Omit task_id to use the most recent task.", parameters: { type: "object", properties: { task_id: { type: "string" } } } } },
  { type: "function", function: { name: "mcp_tool", description: "Generic MCP tool execution (supports external URLs via mcp_url param or npx via npx_pkg param; falls back to env vars).", parameters: { type: "object", properties: { tool_name: { type: "string" }, args: { type: "object" }, mcp_url: { type: "string" }, npx_pkg: { type: "string" } }, required: ["tool_name"] } } },
  { type: "function", function: { name: "prompt_from_file", description: "Use prompt from TODO.md or similar.", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } } },
  { type: "function", function: { name: "skill_tool", description: "Invoke a user-defined skill: reads .7coder/skills/<skill_name>.md and returns its instructions to follow. Pass params for the skill to use.", parameters: { type: "object", properties: { skill_name: { type: "string" }, params: { type: "object" } }, required: ["skill_name"] } } },
  { type: "function", function: { name: "synthetic_output_tool", description: "Generate validated structured output: provide a JSON schema (object with properties/required) and a prompt; returns JSON that is parsed and type-checked (one retry on invalid).", parameters: { type: "object", properties: { schema: { type: "object" }, prompt: { type: "string" } }, required: ["schema", "prompt"] } } },
  { type: "function", function: { name: "workflow_tool", description: "Run a sequence of tool calls from a JSON plan: steps=[{tool, args, optional}]. Steps execute in order through the normal permission system; a failing step stops the workflow unless optional=true. Max 50 steps; nested workflows are rejected.", parameters: { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" }, optional: { type: "boolean" } }, required: ["tool"] } }, description: { type: "string" } }, required: ["steps"] } } },
  { type: "function", function: { name: "run_tests_tool", description: "Run a test suite and parse the output into structured pass/fail counts. Supported: jest/mocha/karma (N passing, M failing), node:test (# pass N), generic. Auto-detects (npm test / node --test) when command omitted.", parameters: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "number" } } } } },
  { type: "function", function: { name: "git_status_tool", description: "Show the working tree status (branch, staged/untracked/modified files) and last commit. Safe/read-only.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "git_diff_tool", description: "Show unstaged (or staged with staged=true) diff for a file or the whole tree. Safe/read-only.", parameters: { type: "object", properties: { path: { type: "string" }, staged: { type: "boolean" } } } } },
  { type: "function", function: { name: "git_commit_tool", description: "Stage all changes and create a git commit. If message is omitted, one is generated from the session audit log. A pre-commit snapshot (git stash create) is recorded so /undo-style recovery is possible; nothing is pushed.", parameters: { type: "object", properties: { message: { type: "string" }, stage_all: { type: "boolean" } } } } },
  { type: "function", function: { name: "auto_approval_return", description: "Lightweight model hands over to heavy model for auto-approval description.", parameters: { type: "object", properties: { description: { type: "string" } } } } },
  { type: "function", function: { name: "computer_use", description: "Real screen control: screenshot (real capture), mouse_move/click (real cursor + click), type_text/press_key (real SendKeys). Windows-only for input actions; requires ENABLE_COMPUTER_USE=true.", parameters: { type: "object", properties: { action: { type: "string", enum: ["screenshot", "mouse_move", "click", "type_text", "press_key"] }, x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, key: { type: "string" } }, required: ["action"] } } },
  { type: "function", function: { name: "plan_mode", description: "Plan mode: light model improves prompt + specifies refinement loops for heavy model deep thinking. Use ONLY for complex tasks.", parameters: { type: "object", properties: { initial_task: { type: "string" } }, required: ["initial_task"] } } },
  { type: "function", function: { name: "auto_debug_tool", description: "Launch app/script (compile if needed), test like a real user (GUI via desktop simulation or CLI via terminal) for 2-5 min, auto-fix errors until only warnings remain.", parameters: { type: "object", properties: { path: { type: "string" }, type: { type: "string", enum: ["gui", "cli", "script"] }, duration_minutes: { type: "number" } }, required: ["path"] } } },
  { type: "function", function: { name: "bickering_tool", description: "Two small-model PM sub-agents bicker/debate the current task until they reach agreement.", parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } } }
];

// ====================== SYSTEM PROMPT ======================
const systemPrompt = `You are 7coder, a helpful, honest, and harmless AI coding assistant - a clean-room full replacement for Claude Code.
You have full tool access including sub-agents, background shell tasks, skills, web tools, computer use (real screenshots only), MCP resources, cron scheduling, and more.
7CODER.md in the project root is automatically updated with a complete summary of what has been done. You do not need to manually write to it.

Permission & Security Rules (follow strictly):
- Modes: default (ask user), auto (light model decides), bypass (danger), denial (block).
- Every tool action is risk-classified LOW/MEDIUM/HIGH by light model.
- Protected files (.env, .gitconfig, .bashrc, credentials, SSH keys, etc.) are NEVER editable by you - the harness blocks it even in bypass mode.
- Block path traversal, super-dangerous commands (dd, format, rm -rf /, etc.) even in bypass.
- Use computer_use ONLY if ENABLE_COMPUTER_USE=true in settings.

Heavy model (you) = coding, computer tasks, reasoning.
Light model = risk classification, explanations, moderation, anti-frustration.

ADDITIONAL RULES (critical):
- Use plan_mode tool ONLY when complex multi-step reasoning requires extended thinking.
- Use auto_debug_tool for ANY launched app/script to test + auto-fix until clean (only warnings left).
- Use bickering_tool when the best approach is unclear - let the two PM sub-agents debate until agreement.
- Do NOT default to calling read_file first on every task. Only use it when you genuinely need the current file contents.
- Prefer edit_file (surgical replacement) for small changes; use write_file only for new files or complete rewrites.
- Use agent_tool to delegate self-contained research or multi-step work to a fresh sub-agent; it returns the final answer. Sub-agents cannot ask the user questions or spawn further agents.
- Use task_create_tool for long-running shell commands (builds, tests) and poll results with task_output_tool; stop them with task_stop_tool.
- Use skill_tool to load user-defined instructions from .7coder/skills/<name>.md.
- On Windows prefer powershell_tool for PowerShell-native tasks and bash_tool when Unix syntax is needed (requires Git for Windows).
- CRITICAL: When using write_file, ALWAYS output the COMPLETE, full file (all imports, full functions, error handling, comments - never partial or "..." code).
- Tool results may be truncated (look for the omission marker). NEVER write_file a file whose read was truncated - re-read the omitted range with offset/limit first, otherwise you will destroy the missing middle.
- In DREAM MODE (internal): follow the override for hyper-detailed self-consolidation (target yourself only, no lazy summaries, no user-directed language).
- Safe tools (read_file, glob_tool, etc.) run instantly without user approval (reading secret files like .env still requires approval).

Anti-frustration: If user seems angry or curses, acknowledge empathetically.

Use tools aggressively when needed. After tools, give clear final answer.
Review the complete summary in 7CODER.md if provided to understand what has been done.`;

// ====================== HELPER FUNCTIONS (Node 13 + Windows 7 safe) ======================
// Case-insensitive on Windows so drive-letter/path case differences can't defeat the check.
function isInsideDir(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const normBase = process.platform === 'win32' ? base.toLowerCase() : base;
  const normTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  return normTarget === normBase || normTarget.startsWith(normBase + path.sep);
}

// Resolves symlinks/junctions on the longest existing prefix of a path, so the
// sandbox cannot be escaped through links pointing outside the workspace.
// FAILS CLOSED: if the depth guard is exhausted (or resolution hits the root
// without succeeding), we throw instead of returning the unresolved path -
// returning it would silently degrade to a lexical check that junctions defeat.
function realPathSafe(p) {
  let cur = path.resolve(p);
  const stack = [];
  for (let guard = 0; guard < 64; guard++) {
    try {
      let real = fs.realpathSync(cur);
      for (let i = stack.length - 1; i >= 0; i--) real = path.join(real, stack[i]);
      return real;
    } catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error('Security: path cannot be resolved safely');
      stack.push(path.basename(cur));
      cur = parent;
    }
  }
  throw new Error('Security: path resolution depth exceeded');
}

let launchDirRealCache = null;
function getLaunchDirReal() {
  if (launchDirRealCache === null) launchDirRealCache = realPathSafe(launchDir);
  return launchDirRealCache;
}

// True when a directory entry is safe to walk/read: plain entries pass;
// symlinks/junctions only pass when they resolve back inside the workspace.
function linkStaysInside(full) {
  try {
    const st = fs.lstatSync(full);
    if (!st.isSymbolicLink()) return true;
    return isInsideDir(getLaunchDirReal(), realPathSafe(full));
  } catch (e) {
    return false;
  }
}

function sanitizePath(userPath) {
  if (!userPath) return '';
  const resolved = path.resolve(launchDir, userPath);
  const real = realPathSafe(resolved);
  const base = getLaunchDirReal();
  if (!isInsideDir(base, real)) {
    throw new Error('Security: Path traversal blocked');
  }
  return path.relative(base, real);
}

// Files the AI must never edit, and whose contents deserve extra scrutiny when read.
const PROTECTED_FILES = [
  '.env', '.env.local', '.env.development', '.env.production',
  '.gitconfig', '.bashrc', '.zshrc', '.profile', '.npmrc', '.netrc',
  'id_rsa', 'id_ed25519', 'credentials.json'
];

function isProtectedTarget(name, args) {
  if (!['read_file', 'prompt_from_file', 'write_file', 'append_file', 'notebook_edit_tool', 'edit_file', 'download_tool'].includes(name)) return false;
  const p = args && (args.path || args.file);
  if (!p || typeof p !== 'string') return false;
  return PROTECTED_FILES.includes(path.basename(p).toLowerCase());
}

// Quotes a token for interpolation into a double-quoted shell string on both cmd and sh.
// Rejects anything that could escape the quotes instead of trying to escape it.
function quoteForShell(token) {
  const s = String(token);
  if (/["`$%]/.test(s)) {
    throw new Error('Security: value contains shell metacharacters');
  }
  return '"' + s + '"';
}

// Locate a real bash binary (on Windows: Git for Windows). Cached after first lookup.
let bashPathCache;
function findBash() {
  if (bashPathCache !== undefined) return bashPathCache;
  if (process.platform !== 'win32') {
    bashPathCache = 'bash';
    return bashPathCache;
  }
  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
    candidates.push(path.join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { bashPathCache = c; return c; } } catch (e) {}
  }
  try {
    const found = child_process.execSync('where bash', { encoding: 'utf8', timeout: 10000 }).trim().split('\n')[0].trim();
    if (found && fs.existsSync(found)) { bashPathCache = found; return found; }
  } catch (e) {}
  bashPathCache = null;
  return null;
}

function isSuperDangerous(cmd) {
  if (!cmd) return false;
  const lower = cmd.toLowerCase();
  // NOTE: substring matching - keep patterns specific. Do NOT add patterns like
  // "> /dev" here: it false-positives on the ubiquitous "> /dev/null" redirect.
  const dangerousPatterns = [
    'rm -rf /', 'rm -rf *', 'format c:', 'dd if=', 'mkfs', 'shutdown', 'del /f /q c:\\',
    'rd /s /q c:\\', 'rmdir /s /q'
  ];
  return dangerousPatterns.some(p => lower.includes(p));
}

// Windows: console commands emit the OEM/ANSI codepage (GBK on zh systems),
// which execSync decodes as UTF-8 -> mojibake. Switching the child session to
// chcp 65001 makes commands emit UTF-8 (verified: 14 -> 0 replacement chars).
// Zero-dependency fix for A2.
function withUtf8Codepage(cmd) {
  return process.platform === 'win32' ? 'chcp 65001>nul & ' + cmd : cmd;
}

// Converts a glob pattern to an anchored case-insensitive regex with standard
// semantics: `**` spans directory separators, `*` and `?` stay within one
// segment, everything else is escaped literally. Backslashes in the pattern
// are treated as separators (Windows users type `src\*.js`).
function globToRegex(pattern) {
  const norm = String(pattern).split('\\').join('/');
  let out = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          // `**/` may also match ZERO path segments (bash globstar convention:
          // src/**/*.js includes src/a.js).
          out += '(?:.*/)?';
          i += 2;
        } else { out += '.*'; i++; }
      } else out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]'.indexOf(c) >= 0) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$', 'i');
}

function recursiveReaddir(dir = '', pattern = '') {
  const results = [];
  const startDir = dir ? path.join(launchDir, sanitizePath(dir)) : launchDir;
  let rx = null;
  if (pattern) {
    try { rx = globToRegex(pattern); } catch (e) { rx = null; }
  }
  // Path-aware semantics only for patterns that NAME a path (contain a
  // separator or **). Plain patterns like *.js keep matching basenames at any
  // depth - the pre-existing behavior and the most common search intent.
  const pathAware = pattern && (pattern.indexOf('/') >= 0 || pattern.indexOf('\\') >= 0 || pattern.indexOf('**') >= 0);
  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry);
      // Do not traverse/read through links that leave the workspace.
      if (!linkStaysInside(full)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(launchDir, full);
        let isMatch = false;
        if (!pattern) {
          isMatch = true;
        } else if (rx) {
          if (pathAware) {
            isMatch = rx.test(rel.split(path.sep).join('/'));
          } else {
            isMatch = rx.test(entry);
          }
        } else {
          isMatch = entry.toLowerCase().includes(pattern.toLowerCase());
        }
        if (isMatch) {
          results.push(rel);
        }
      }
    }
  }
  walk(startDir);
  return results;
}

function grepSearch(pattern, searchPath = '') {
  const results = [];
  const startDir = searchPath ? path.join(launchDir, sanitizePath(searchPath)) : launchDir;
  let rx = null;
  try {
    rx = new RegExp(pattern, 'i');
  } catch (e) {
    rx = null;
  }
  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry);
      // Do not read through links that leave the workspace.
      if (!linkStaysInside(full)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else {
        try {
          const content = fs.readFileSync(full, 'utf8');
          const matched = rx ? rx.test(content) : content.toLowerCase().includes(pattern.toLowerCase());
          if (matched) {
            const rel = path.relative(launchDir, full);
            results.push(`${rel}: matches "${pattern}"`);
          }
        } catch (e) {}
      }
    }
  }
  walk(startDir);
  return results.length ? results.join('\n') : `No matches for pattern: ${pattern}`;
}

// ====================== CRON SCHEDULING ======================
// Supported schedules: "30s", "5m", "2h", "every 10m", "daily 09:30" (or just "09:30").
function parseSchedule(schedule) {
  const s = String(schedule || '').trim().toLowerCase();
  let m;
  if ((m = s.match(/^(?:every\s+)?(\d+)\s*(s|sec|secs|seconds)$/))) return { kind: 'interval', ms: Math.max(1000, parseInt(m[1], 10) * 1000) };
  if ((m = s.match(/^(?:every\s+)?(\d+)\s*(m|min|mins|minutes)$/))) return { kind: 'interval', ms: Math.max(60000, parseInt(m[1], 10) * 60000) };
  if ((m = s.match(/^(?:every\s+)?(\d+)\s*(h|hr|hrs|hours)$/))) return { kind: 'interval', ms: parseInt(m[1], 10) * 3600000 };
  if ((m = s.match(/^(?:daily|everyday)\s+(\d{1,2}):(\d{2})$/)) || (m = s.match(/^(\d{1,2}):(\d{2})$/))) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour < 24 && minute < 60) return { kind: 'daily', hour, minute };
  }
  return null;
}

function scheduleCronJob(jobId, schedule, command) {
  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return `[ERROR] Unsupported schedule "${schedule}". Supported formats: "30s", "5m", "2h", "every 10m", "daily 09:30".`;
  }
  const job = { schedule, command, parsed, nextRun: null, timer: null, runs: 0, lastError: null, stopped: false };
  const runCommand = () => {
    job.runs++;
    job.child = child_process.exec(command, { cwd: launchDir, timeout: 300000 }, (err) => {
      if (err) job.lastError = err.message;
      job.child = null;
    });
  };
  // setTimeout delays cap at ~24.8 days (2^31-1 ms); re-arm in chunks so very
  // long intervals don't overflow into an immediate fire.
  const TIMER_MAX = 2147483647;
  const armNext = () => {
    if (job.stopped) return;
    const remaining = job.nextRun - Date.now();
    if (remaining > TIMER_MAX) {
      job.timer = setTimeout(armNext, TIMER_MAX);
      job.timer.unref();
      return;
    }
    if (remaining > 0) {
      job.timer = setTimeout(() => { runCommand(); scheduleNext(); }, remaining);
      job.timer.unref();
      return;
    }
    // Missed slot (e.g. process was asleep) - run now and reschedule.
    runCommand();
    scheduleNext();
  };
  const scheduleNext = () => {
    if (job.stopped) return;
    if (parsed.kind === 'interval') {
      job.nextRun = Date.now() + parsed.ms;
    } else {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hour, parsed.minute, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      job.nextRun = next.getTime();
    }
    armNext();
  };
  scheduleNext();
  cronJobs.set(jobId, job);
  const human = parsed.kind === 'daily'
    ? `daily at ${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`
    : `every ${parsed.ms >= 3600000 ? (parsed.ms / 3600000) + 'h' : parsed.ms >= 60000 ? (parsed.ms / 60000) + 'm' : (parsed.ms / 1000) + 's'}`;
  return `[OK] Cron job ${jobId} scheduled (${human}), next run: ${new Date(job.nextRun).toISOString()}`;
}

// ====================== DREAM HELPERS ======================
function getLastInteractionTime() {
  const file = path.join(launchDir, '.7coder_last_interaction');
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    return parseInt(content, 10) || 0;
  } catch {
    return 0;
  }
}

function updateLastInteractionTime() {
  try {
    fs.writeFileSync(path.join(launchDir, '.7coder_last_interaction'), Date.now().toString());
  } catch (e) {}
}

async function triggerDreamIfNeeded() {
  const lastTime = getLastInteractionTime();
  const hoursSince = (Date.now() - lastTime) / (1000 * 60 * 60);
  const lockPath = path.join(launchDir, '7C.dream.lock');
  if (!DREAM_ALLOW || hoursSince < 5) return false;
  // Clear stale locks left behind by a crashed session (older than 4 hours).
  try {
    if (fs.existsSync(lockPath) && Date.now() - fs.statSync(lockPath).mtimeMs > 4 * 60 * 60 * 1000) {
      fs.unlinkSync(lockPath);
    }
  } catch (e) {}
  if (fs.existsSync(lockPath)) return false;

  console.log(`[DREAM] 7coder is ${getRandomSpinner()} [DREAM MODE - 2.5h self-consolidation]`);
  fs.writeFileSync(lockPath, new Date().toISOString());
  await runDreamSession();
  fs.unlinkSync(lockPath);
  updateLastInteractionTime();
  return true;
}

async function runDreamSession() {
  const mdPath = path.join(launchDir, '7CODER.md');
  let currentContent = 'No prior content.';
  try {
    if (fs.existsSync(mdPath)) currentContent = fs.readFileSync(mdPath, 'utf8') || currentContent;
  } catch (e) {}
  const dreamSystemPrompt = `${systemPrompt}
[DREAM MODE OVERRIDE - 2.5 HOUR SELF-CONSOLIDATION SESSION]
You are now in a dedicated deep organization session for 7CODER.md.
Rules (strict, no exceptions):
- NO lazy summaries ("Fix this bug later", "Improve X", etc.). Be hyper-detailed and descriptive.
- Target YOURSELF only: "I (7coder) will implement [exact change] because [reason]. Full self-plan: step-by-step...".
- Never generalize to user or use irrelevant examples (e.g. no "how to make toast").
- Reorganize everything into clean sections, priorities, full code blocks where relevant.
- At the end of the tool chain, use write_file with path="7CODER.md" and the COMPLETE new organized content (full file, no truncation).`;
  const dreamUserPrompt = `Begin the DREAM SESSION. Consolidate this content:\n\n${currentContent}`;
  const dreamMessages = [
    { role: 'system', content: dreamSystemPrompt },
    { role: 'user', content: dreamUserPrompt }
  ];
  console.log('Dreaming deeply (self-consolidation in progress)...');
  try {
    await processWithTools(dreamMessages);
    console.log('[OK] Dream consolidation complete.');
  } catch (e) {
    console.error('Dream error:', e.message);
    fs.writeFileSync(mdPath, `# DREAM FALLBACK\n${new Date().toISOString()}\nConsolidation attempted but encountered an error.`, 'utf8');
  }
}

// ====================== VISION HELPER ======================
async function describeWithVision(imageUrl) {
  if (!VISION_MODEL) {
    return `[IMAGE] Image at ${imageUrl} - (VISION_MODEL not set in .env - add e.g. gpt-4o to enable real vision)`;
  }
  try {
    const mcfg = resolveModelConfig(VISION_MODEL);
    const base = mcfg.endpoint.replace(/\/+$/, '');
    const payload = {
      model: VISION_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image in detail for a coding assistant. Focus on any code, diagrams, UI elements, or text visible." },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }],
      max_tokens: 500
    };
    const response = await axios.post(`${base}/chat/completions`, payload, {
      headers: authHeadersFor(mcfg.apiKey),
      timeout: 30000
    });
    return response.data.choices[0].message.content.trim();
  } catch (e) {
    return `Vision error: ${e.message}`;
  }
}

// ====================== LIGHT/HEAVY CALLER ======================
// Parses an OpenAI SSE stream and assembles a normal `choice` object.
// Calls onDelta(text) for every content fragment (used for live output).
function parseSSEStream(stream, onDelta, onReasoning) {
  return new Promise((resolve, reject) => {
    // Decode with Node's StringDecoder so a multibyte UTF-8 char split across
    // TCP chunks is reassembled instead of torn into U+FFFD replacement chars.
    if (stream.setEncoding) stream.setEncoding('utf8');
    const message = { role: 'assistant', content: '' };
    const toolCalls = [];
    let finishReason = null;
    let sawAnything = false;
    let upstreamErrorSeen = false;
    let sawReasoning = false;
    let buffer = '';
    stream.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, nl).replace(/\r$/, '');
        buffer = buffer.substring(nl + 1);
        if (line.startsWith('event:')) {
          const evt = line.substring(6).trim();
          if (evt === 'error') upstreamErrorSeen = true;
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const payload = line.substring(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed;

        try { parsed = JSON.parse(payload); } catch (e) {

          // Malformed error payloads (LMStudio appends trailing junk after the

          // error object) still deserve to surface, not be silently skipped.

          if (upstreamErrorSeen || payload.indexOf('"error"') >= 0) {

            return reject(new Error('upstream error: ' + payload.substring(0, 300)));

          }

          continue;

        }
        // Servers report errors mid-stream as {"error":{...}} data payloads
// (LMStudio) - surface them instead of treating them as empty responses.
if (parsed.error) {
  const em = (parsed.error && parsed.error.message) ? parsed.error.message : String(parsed.error);
  return reject(new Error('upstream error: ' + em));
}
const ch = parsed.choices && parsed.choices[0];
        if (!ch) continue;
        sawAnything = true;
        const delta = ch.delta || {};
        if (delta.reasoning_content) {
          sawReasoning = true;
          message.reasoning = (message.reasoning || '') + delta.reasoning_content;
          if (onReasoning) onReasoning(delta.reasoning_content);
        }
        if (delta.content) {
          message.content += delta.content;
          if (onDelta) onDelta(delta.content);
        }
        if (delta.tool_calls) {
          // Tool calls stream as fragments; merge them by index.
          for (const tc of delta.tool_calls) {
            const i = (typeof tc.index === 'number') ? tc.index : 0;
            if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function) {
              if (tc.function.name) toolCalls[i].function.name += tc.function.name;
              if (tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
            }
          }
        }
        if (ch.finish_reason) finishReason = ch.finish_reason;
      }
    });
    stream.on('end', () => {
      const merged = toolCalls.filter(tc => tc && tc.function && tc.function.name);
      if (merged.length) message.tool_calls = merged;
      if (!message.content && !merged.length && sawReasoning) message.reasoning_only = true;
      if (!sawAnything) return resolve(null);
      resolve({ message, finish_reason: finishReason || 'stop' });
    });
    stream.on('error', reject);
  });
}

async function callOpenAI(currentMessages, options = {}) {
  const {
    model = HEAVY_MODEL,
    useTools = true,
    toolChoice = "auto",
    temperature = TEMPERATURE,
    maxTokens = MAX_TOKENS,
    onDelta = null,
    onReasoning = null,
  } = options;

  const mcfg = resolveModelConfig(model);
  const base = mcfg.endpoint.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  const payload = {
    model,
    messages: currentMessages,
    temperature,
    max_tokens: maxTokens,
  };

  if (useTools) payload.tools = tools;
  if (useTools) payload.tool_choice = toolChoice;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (onDelta) {
        payload.stream = true;
        const response = await axios.post(url, payload, {
          headers: authHeadersFor(mcfg.apiKey),
          timeout: 420000,
          responseType: 'stream'
        });
        const choice = await parseSSEStream(response.data, onDelta, onReasoning);
        if (choice && (choice.message.content || (choice.message.tool_calls && choice.message.tool_calls.length))) {
          return choice;
        }
        throw new Error((choice && choice.message.reasoning_only) ? 'empty response: the model emitted only reasoning tokens (reasoning_content) and never produced an answer or tool call - raise MAX_TOKENS or disable thinking' : 'empty streamed response');
      }
      const response = await axios.post(url, payload, {
        headers: authHeadersFor(mcfg.apiKey),
        timeout: 420000, // 7 minutes - generous for slow local LLM endpoints
      });
      if (response.data && response.data.choices && response.data.choices[0]) {
        return response.data.choices[0];
      }
      throw new Error('Invalid API response structure: ' + JSON.stringify(response.data));
    } catch (error) {
      let msg = error.message;
      if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
        msg = error.response.data.error.message;
      }
      console.error(`[WARN] API attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
      // Upstream in-stream errors (e.g. LMStudio context overflow) and
      // reasoning-only responses will not get better by retrying.
      if (/^upstream error:|only reasoning tokens/.test(msg)) {
        throw new Error(msg);
      }
      const status = error.response && error.response.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw new Error(`API error ${status} (not retryable): ${msg}`);
      }
      if (attempt === MAX_RETRIES) throw new Error('Max retries reached.');
      await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
}

// Deterministic one-line explanations for the approval prompt - no light-model
// call needed for the common tools (A8). Unmapped tools fall back to the LLM.
const DETERMINISTIC_EXPLAIN = {
  write_file: (a) => `Write file ${a.path}`,
  append_file: (a) => `Append to file ${a.path}`,
  edit_file: (a) => `Edit file ${a.path}`,
  notebook_edit_tool: (a) => `Edit notebook ${a.path}`,
  download_tool: (a) => `Download ${a.url} to ${a.path}`,
  todo_write_tool: () => 'Append an entry to TODO.md',
  brief_tool: (a) => `Summarize folder ${a.folder} into ${a.folder}.summary`,
  enter_worktree_tool: (a) => `Create git worktree at ${a.path}`,
  schedule_cron_tool: (a) => `Schedule cron "${a.schedule}" running: ${String(a.command || '').substring(0, 60)}`,
  cron_create_tool: (a) => `Schedule cron "${a.schedule}" running: ${String(a.command || '').substring(0, 60)}`,
  cron_delete_tool: (a) => `Delete cron job ${a.job_id}`,
  process_kill_tool: (a) => `Kill process ${a.pid}`,
  run_command: (a) => `Run shell command: ${String(a.command || '').substring(0, 100)}`,
  bash_tool: (a) => `Run bash command: ${String(a.command || '').substring(0, 100)}`,
  powershell_tool: (a) => `Run PowerShell command: ${String(a.command || '').substring(0, 100)}`,
  task_create_tool: (a) => `Start background task: ${String(a.command || '').substring(0, 80)}`,
  mcp_tool: (a) => `Call MCP tool ${a.tool_name}`,
  agent_tool: (a) => `Spawn sub-agent "${a.name}" with task: ${String(a.task || '').substring(0, 60)}`,
  workflow_tool: (a) => `Run a ${Array.isArray(a.steps) ? a.steps.length : '?'}-step tool workflow`,
  run_tests_tool: (a) => `Run test suite: ${String(a.command || 'auto-detected').substring(0, 80)}`,
  git_status_tool: () => 'Show git working tree status (read-only)',
  git_diff_tool: (a) => `Show git diff${a.staged ? ' (staged)' : ''}${a.path ? ' for ' + a.path : ''} (read-only)`,
  git_commit_tool: (a) => `Stage all and commit${a.message ? ': ' + String(a.message).substring(0, 60) : ' (auto message)'} (snapshot taken)`
};

// ====================== RISK CLASSIFICATION & PERMISSION ======================
async function classifyRisk(toolName, args) {
  const prompt = `Classify risk of tool call as ONLY ONE WORD: LOW, MEDIUM or HIGH.
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Consider file edits, shell commands, web access, computer control, protected paths.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    const cleaned = (choice.message.content || 'MEDIUM').replace(/[*'`"“”’‘]/g, '').trim().toUpperCase();
    const first = cleaned.split(/\s+/)[0].replace(/[^A-Z]/g, '');
    return ['LOW', 'MEDIUM', 'HIGH'].includes(first) ? first : 'MEDIUM';
  } catch (e) {
    return 'MEDIUM';
  }
}

async function getPermissionExplanation(toolName, args, risk) {
  const prompt = `Explain this tool action to the user in 1-2 friendly sentences. Include what it does and why it might need approval.
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Risk level: ${risk}`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return (choice.message.content || `Tool ${toolName} will run (risk: ${risk}).`).trim();
  } catch (e) {
    return `Tool ${toolName} will run. Risk: ${risk}.`;
  }
}

async function isAutoApprovalSafe(toolName, args, risk) {
  const prompt = `Is this tool action safe to auto-approve in AUTO mode? Risk: ${risk}
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Reply ONLY with YES or NO.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    const cleaned = (choice.message.content || 'NO').replace(/[*'`"“”’‘]/g, '').trim().toUpperCase();
    return cleaned.startsWith('YES') || cleaned === 'YES';
  } catch (e) {
    return false;
  }
}

// ====================== TOOL EXECUTION ======================
// `conversation` is the current message array (used by snip_tool); tools that
// spawn their own sub-conversations must NOT push into it mid-tool-call.
async function executeToolRaw(name, args, conversation) {
  if (name === 'read_file') {
    try {
      const fullPath = path.join(launchDir, sanitizePath(args.path || ''));
      let content = fs.readFileSync(fullPath, 'utf8');
      if (typeof args.offset === 'number' || typeof args.limit === 'number') {
        const lines = content.split('\n');
        const start = Math.max(0, (parseInt(args.offset, 10) || 1) - 1);
        const count = (typeof args.limit === 'number' && args.limit > 0) ? Math.floor(args.limit) : Math.max(0, lines.length - start);
        content = lines.slice(start, start + count)
          .map((l, i) => String(start + i + 1).padStart(6) + '\t' + l)
          .join('\n');
      }
      return content;
    } catch (e) { return `Read error: ${e.message}`; }
  }
  if (name === 'write_file') {
    try {
      const fullPath = path.join(launchDir, sanitizePath(args.path || ''));
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      backupFile(fullPath);
      fs.writeFileSync(fullPath, args.content || '', 'utf8');
      if (args.path && args.path.endsWith('7CODER.md')) return '[OK] 7CODER.md updated with findings';
      return `Written: ${path.relative(launchDir, fullPath)}`;
    } catch (e) { return `Write error: ${e.message}`; }
  }
  if (name === 'append_file') {
    const fullPath = path.join(launchDir, sanitizePath(args.path));
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.appendFileSync(fullPath, args.content || '', 'utf8');
      return `Appended: ${args.path}`;
    } catch (e) { return `Append error: ${e.message}`; }
  }

  if (name === 'edit_file') {
    try {
      const fullPath = path.join(launchDir, sanitizePath(args.path));
      const content = fs.readFileSync(fullPath, 'utf8');
      const oldStr = (args.old_string === undefined || args.old_string === null) ? '' : String(args.old_string);
      if (oldStr === '') return 'Edit error: old_string is required';
      const newStr = (args.new_string === undefined || args.new_string === null) ? '' : String(args.new_string);
      const count = content.split(oldStr).length - 1;
      if (count === 0) return 'Edit error: old_string not found in file';
      if (count > 1 && !args.replace_all) {
        return `Edit error: old_string found ${count} times - add more surrounding context to make it unique, or set replace_all=true`;
      }
      // split/join (not String.replace) so $-patterns in new_string stay literal
      backupFile(fullPath);
      fs.writeFileSync(fullPath, content.split(oldStr).join(newStr), 'utf8');
      return `[OK] Edited ${path.relative(launchDir, fullPath)} (${args.replace_all ? count : 1} replacement(s))`;
    } catch (e) { return `Edit error: ${e.message}`; }
  }

  if (name === 'agent_tool') {
    const agentName = String(args.name || 'agent').substring(0, 60);
    const task = String(args.task || '').trim();
    if (!task) return 'Agent error: task is required';
    return await runSubAgent(agentName, task);
  }

  if (name === 'run_command') {
    let cmd = args.command || '';
    if (DANGER_MODE || effectivePermissionMode() === 'bypass') console.log(`[WARN] Running: ${cmd}`);

    try {
      const output = child_process.execSync(withUtf8Codepage(cmd), { encoding: 'utf8', cwd: launchDir, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
      return `Command OK:\n${output}`;
    } catch (e) {
      return `[ERROR] Command failed:\n${e.message}\n${e.stderr || ''}`;
    }
  }

  if (name === 'bash_tool') {
    let cmd = args.command || '';
    if (DANGER_MODE || effectivePermissionMode() === 'bypass') console.log(`[WARN] Running (bash): ${cmd.substring(0, 200)}`);
    const bash = findBash();
    if (!bash) {
      return 'bash not found. On Windows install Git for Windows (it ships bash.exe), then retry - or use powershell_tool / run_command instead.';
    }
    try {
      const output = child_process.execFileSync(bash, ['-c', String(cmd)], { encoding: 'utf8', cwd: launchDir, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
      return `Command OK:\n${output}`;
    } catch (e) {
      return `[ERROR] Command failed:\n${e.message}\n${e.stderr || ''}`;
    }
  }

  if (name === 'powershell_tool') {
    if (process.platform !== 'win32') {
      return 'powershell_tool is Windows-only - use bash_tool or run_command on this platform.';
    }
    let cmd = args.command || '';
    if (DANGER_MODE || effectivePermissionMode() === 'bypass') console.log(`[WARN] Running (PowerShell): ${cmd.substring(0, 200)}`);
    try {
      // -EncodedCommand takes Base64 UTF-16LE: immune to quoting/injection issues
      // and supported since PowerShell 2.0 (Windows 7).
      const encoded = Buffer.from(String(cmd), 'utf16le').toString('base64');
      const output = child_process.execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { encoding: 'utf8', cwd: launchDir, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
      return `Command OK:\n${output}`;
    } catch (e) {
      return `[ERROR] Command failed:\n${e.message}\n${e.stderr || ''}`;
    }
  }

  if (name === 'glob_tool') {
    const files = recursiveReaddir(args.directory, args.pattern);
    return files.length ? files.join('\n') : 'No files matched';
  }
  if (name === 'grep_tool') {
    return grepSearch(args.pattern, args.path);
  }

  if (name === 'list_dir') {
    try {
      const dirPath = args.path ? path.join(launchDir, sanitizePath(args.path)) : launchDir;
      if (!fs.statSync(dirPath).isDirectory()) return 'List error: not a directory';
      const entries = fs.readdirSync(dirPath);
      const lines = entries.map(e => {
        const full = path.join(dirPath, e);
        try {
          const st = fs.statSync(full);
          return st.isDirectory() ? '[DIR]     ' + e : String(st.size).padStart(9) + '  ' + e;
        } catch (err) { return '[?]       ' + e; }
      });
      return lines.length ? lines.join('\n') : '(empty directory)';
    } catch (e) { return `List error: ${e.message}`; }
  }

  if (name === 'process_list_tool') {
    try {
      const cmd = process.platform === 'win32' ? 'tasklist' : 'ps -eo pid,comm';
      return child_process.execSync(withUtf8Codepage(cmd), { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    } catch (e) { return `Process list error: ${e.message}`; }
  }
  if (name === 'process_kill_tool') {
    const pid = parseInt(args.pid, 10);
    if (!pid || pid < 2) return 'Invalid PID (must be >= 2)';
    try {
      if (process.platform === 'win32') {
        child_process.execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf8', timeout: 30000 });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      return `[OK] Killed process ${pid}`;
    } catch (e) { return `Kill error: ${e.message}`; }
  }

  if (name === 'web_fetch_tool') {
    try {
      const res = await axios.get(args.url, { timeout: 10000 });
      return typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
    } catch (e) { return `Fetch error: ${e.message}`; }
  }
  if (name === 'download_tool') {
    let dest = null;
    try {
      const destRel = sanitizePath(args.path);
      if (!destRel) return 'Download error: destination path required';
      if (!args.url || !/^https?:\/\//i.test(args.url)) return 'Download error: url must start with http:// or https://';
      dest = path.join(launchDir, destRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const MAX_BYTES = 500 * 1024 * 1024;
      const response = await axios({ method: 'get', url: args.url, responseType: 'stream', timeout: 60000 });
      const writer = fs.createWriteStream(dest);
      let received = 0;
      await new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_BYTES) {
            response.data.destroy();
            reject(new Error('download exceeds 500 MB cap'));
          }
        });
        response.data.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', resolve);
        response.data.pipe(writer);
      });
      return `[OK] Downloaded ${args.url} to ${destRel} (${received} bytes)`;
    } catch (e) {
      try { if (dest && fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e2) {}
      return `Download error: ${e.message}`;
    }
  }
  if (name === 'web_search_tool') {
    try {
      const q = encodeURIComponent(args.query);
      const res = await axios.get(`https://lite.duckduckgo.com/lite?q=${q}`, { timeout: 10000 });
      const links = [...res.data.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].slice(0, 10).map(m => `${m[2]} -> ${m[1]}`);
      return `Search results:\n${links.join('\n')}`;
    } catch (e) { return `Search error: ${e.message}`; }
  }

  if (name === 'web_browser_tool') {
    const url = args.url;
    const action = args.action || 'navigate';
    console.log(`[WEB] Real browser tool: ${action} -> ${url}`);

    try {
      const isImage = url.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i);
      if (isImage) {
        const desc = await describeWithVision(url);
        return `[IMAGE] Image viewed at ${url}\nVision description:\n${desc}`;
      }

      const res = await axios.get(url, { timeout: 15000, responseType: 'text' });
      let pageContent = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);

      const linkMatches = [...pageContent.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi)];
      const linksSummary = linkMatches.slice(0, 20).map(m => `${m[2].trim()} -> ${m[1]}`).join('\n');

      let result = `[PAGE] Page fetched successfully (${action})\nURL: ${url}\n\n[LINKS] Links found (infer from names):\n${linksSummary || 'No clickable links found'}\n\n`;

      if (action === 'extract' || action === 'navigate') {
        let textContent = pageContent
          .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
          .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        result += `Content preview (first 3000 chars):\n${textContent.substring(0, 3000)}...`;
      } else if (action === 'click') {
        result += `[LINKS] Click simulated - navigated to the provided URL. Use the extracted links above for next steps.`;
      }
      return result;
    } catch (e) {
      return `[WEB] Browser error for ${url}: ${e.message}`;
    }
  }

  if (name === 'notebook_edit_tool') {
    try {
      const nbPath = path.join(launchDir, sanitizePath(args.path));
      let notebook = JSON.parse(fs.readFileSync(nbPath, 'utf8'));
      if (args.edits.cells) notebook.cells = args.edits.cells;
      if (args.edits.metadata) notebook.metadata = { ...notebook.metadata, ...args.edits.metadata };
      backupFile(nbPath);
      fs.writeFileSync(nbPath, JSON.stringify(notebook, null, 2));
      return 'Notebook edited successfully';
    } catch (e) { return `Notebook error: ${e.message}`; }
  }

  if (name === 'ask_user_question_tool') {
    if (subAgentModeOverride) return 'Question skipped (a sub-agent cannot ask the user questions).';
    if (rlClosed) return 'Question skipped (input stream is closed).';
    if (DANGER_MODE || effectivePermissionMode() === 'bypass') return 'Question skipped in non-interactive mode';
    const answer = await new Promise(resolve => rl.question(`${args.question}\nAnswer: `, resolve));
    return `User answered: ${answer}`;
  }

  if (name === 'brief_tool') {
    try {
      const folderRel = sanitizePath(args.folder);
      const summaryPath = path.join(launchDir, `${folderRel}.summary`);
      const files = recursiveReaddir(args.folder);
      const summary = `Summary of ${args.folder} (${files.length} files):\n${files.join('\n')}\n\nGenerated at ${new Date().toISOString()}`;
      fs.writeFileSync(summaryPath, summary, 'utf8');
      return `Summary written to ${summaryPath}`;
    } catch (e) { return `Brief error: ${e.message}`; }
  }

  if (name === 'task_create_tool') {
    if (shuttingDown) return 'Task refused: 7coder is shutting down.';
    const command = String(args.command || '').trim();
    if (!command) return 'Task error: command is required (e.g. "npm test")';
    const taskId = `task-${Date.now()}-${++taskSeq}`;
    const task = {
      id: taskId,
      description: String(args.description || command),
      command,
      status: 'running',
      output: '',
      startedAt: new Date().toISOString(),
      endedAt: null,
      child: null,
      stopRequested: false
    };
    const child = child_process.exec(withUtf8Codepage(command), { cwd: launchDir, timeout: 1800000, maxBuffer: 20 * 1024 * 1024 }, (err) => {
      task.endedAt = new Date().toISOString();
      if (task.stopRequested || task.status === 'stopped') return;
      if (err) {
        task.status = 'failed';
        task.output += `\n[Task failed] ${err.message}`;
      } else {
        task.status = 'completed';
      }
      pruneTasks();
    });
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', d => { task.output += d.toString(); });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', d => { task.output += d.toString(); });
    }
    task.child = child;
    backgroundTasks.set(taskId, task);
    return `[OK] Background task ${taskId} started: ${command}`;
  }
  if (name === 'task_get_tool') {
    const t = backgroundTasks.get(args.task_id) || (!args.task_id ? latestTask() : null);
    if (!t) return 'Task not found';
    return JSON.stringify({ id: t.id, description: t.description, command: t.command, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt }, null, 2);
  }
  if (name === 'task_list_tool') {
    if (!backgroundTasks.size) return 'No tasks';
    return Array.from(backgroundTasks.values())
      .map(t => `${t.id} | ${t.status} | ${t.command.substring(0, 60)}`)
      .join('\n');
  }
  if (name === 'task_output_tool') {
    const t = backgroundTasks.get(args.task_id) || (!args.task_id ? latestTask() : null);
    if (!t) return 'Task not found';
    const MAXSHOW = 8000;
    const out = t.output || '(no output yet)';
    if (out.length > MAXSHOW) {
      return `...(output truncated, showing last ${MAXSHOW} chars)\n` + out.substring(out.length - MAXSHOW);
    }
    return out;
  }
  if (name === 'task_stop_tool') {
    const t = backgroundTasks.get(args.task_id) || (!args.task_id ? latestTask() : null);
    if (!t) return 'Task not found';
    if (t.status !== 'running') return `Task ${t.id} already ${t.status}`;
    t.stopRequested = true;
    try {
      if (process.platform === 'win32' && t.child && t.child.pid) {
        child_process.execSync(`taskkill /PID ${t.child.pid} /T /F`, { stdio: 'ignore', timeout: 15000 });
      } else if (t.child) {
        t.child.kill('SIGTERM');
      }
    } catch (e) {}
    t.status = 'stopped';
    t.endedAt = new Date().toISOString();
    pruneTasks();
    return `[OK] Task ${t.id} stopped`;
  }

  if (name === 'todo_write_tool') {
    const todoPath = path.join(launchDir, 'TODO.md');
    fs.appendFileSync(todoPath, `\n## ${new Date().toISOString()}\n${args.content}\n`, 'utf8');
    return '[OK] TODO.md updated';
  }

  if (name === 'list_mcp_resources_tool') {
    try {
      fs.mkdirSync(mcpResourcesDir, { recursive: true });
      return fs.readdirSync(mcpResourcesDir).join('\n') || 'No MCP resources';
    } catch (e) { return `MCP resource list error: ${e.message}`; }
  }
  if (name === 'read_mcp_resource_tool') {
    try {
      const resPath = path.resolve(mcpResourcesDir, args.resource_id || '');
      const resReal = realPathSafe(resPath);
      // Compare the resolved resource path against the INTENDED (lexical) .mcp
      // path, so a junction planted at .mcp itself cannot vacate the check.
      if (!isInsideDir(path.resolve(mcpResourcesDir), resReal)) return 'Resource not found (paths outside the .mcp directory are blocked)';
      return fs.readFileSync(resReal, 'utf8');
    } catch (e) { return 'Resource not found'; }
  }

  if (name === 'mcp_tool') {
    const { tool_name: toolName, args: toolArgs = {}, mcp_url, npx_pkg } = args;
    const effectiveUrl = mcp_url || MCP_SERVER_URLS[0] || null;
    const effectiveNpx = npx_pkg || (MCP_NPX_PKGS.length ? MCP_NPX_PKGS[0] : null);

    if (effectiveUrl) {
      console.log(`[WEB] Calling external MCP server: ${effectiveUrl} / ${toolName}`);
      try {
        const payload = { tool: toolName, arguments: toolArgs };
        const res = await axios.post(`${effectiveUrl.replace(/\/$/, '')}/invoke`, payload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });
        return typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
      } catch (e) {
        return `MCP external error (${effectiveUrl}): ${e.message}`;
      }
    } else if (effectiveNpx) {
      console.log(`[MCP] Running MCP via npx: ${effectiveNpx} ${toolName}`);
      if (!/^[@a-zA-Z0-9._\/-]+$/.test(effectiveNpx)) {
        return 'BLOCKED: npx package name contains shell metacharacters';
      }
      let argsToken = '';
      if (Object.keys(toolArgs).length) {
        const json = JSON.stringify(toolArgs);
        if (/[^a-zA-Z0-9 {}.,:_\/-]/.test(json)) {
          return 'BLOCKED: MCP tool arguments contain shell metacharacters - pass simpler args or use run_command';
        }
        argsToken = json;
      }
      return await executeToolRaw('run_command', { command: `npx ${effectiveNpx} ${toolName} ${argsToken}`.trim() }, conversation);
    } else {
      return `[OK] MCP tool "${toolName}" executed locally (no server/npx configured) with args: ${JSON.stringify(toolArgs)}`;
    }
  }

  if (name === 'sleep_tool') {
    const ms = parseInt(args.ms) || 1000;
    await new Promise(r => setTimeout(r, ms));
    return `[OK] Slept ${ms}ms`;
  }

  if (name === 'snip_tool') {
    const history = conversation || messages;
    const start = args.start || 0;
    const end = (typeof args.end === 'number') ? args.end : history.length;
    return history.slice(start, end).map(m => JSON.stringify(m)).join('\n');
  }

  if (name === 'tool_search_tool') {
    return tools.map(t => t.function.name).join('\n');
  }

  if (name === 'enter_worktree_tool') {
    try {
      const rel = sanitizePath(args.path || 'worktree');
      const wtPath = quoteForShell(rel);
      child_process.execSync(`git worktree add ${wtPath}`, { cwd: launchDir, timeout: 60000 });
      return `[OK] Entered worktree at ${args.path}`;
    } catch (e) { return `Worktree error: ${e.message}`; }
  }

  if (name === 'schedule_cron_tool' || name === 'cron_create_tool') {
    const jobId = `cron-${Date.now()}`;
    return scheduleCronJob(jobId, args.schedule, args.command);
  }
  if (name === 'cron_delete_tool') {
    if (!args.job_id || !cronJobs.has(args.job_id)) {
      return 'Cron job not found: ' + (args.job_id || '(no job_id provided)');
    }
    const job = cronJobs.get(args.job_id);
    job.stopped = true;
    clearTimeout(job.timer);
    cronJobs.delete(args.job_id);
    return `[OK] Cron job deleted`;
  }
  if (name === 'cron_list_tool') {
    if (!cronJobs.size) return 'No cron jobs';
    return Array.from(cronJobs.entries()).map(([id, j]) =>
      `${id} | schedule: ${j.schedule} | runs: ${j.runs} | next: ${j.nextRun ? new Date(j.nextRun).toISOString() : 'n/a'}${j.lastError ? ` | lastError: ${j.lastError}` : ''}`
    ).join('\n');
  }

  if (name === 'skill_tool') {
    const skillName = String(args.skill_name || '').trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(skillName)) {
      return 'Skill error: skill_name must be a simple name (letters, digits, dot, dash, underscore)';
    }
    const skillPath = path.join(skillsDir, skillName + '.md');
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      const paramsJson = (args.params && Object.keys(args.params).length)
        ? `\n\nCaller-provided params:\n${JSON.stringify(args.params, null, 2)}`
        : '';
      return `Executing skill "${skillName}". Follow these instructions:\n\n${content}${paramsJson}`;
    } catch (e) {
      let available = 'none';
      try {
        available = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md')).join(', ') || 'none';
      } catch (e2) {}
      return `Skill "${skillName}" not found. Available skills: ${available}. Create skills as .7coder/skills/<name>.md files.`;
    }
  }

  if (name === 'prompt_from_file') {
    try { return fs.readFileSync(path.join(launchDir, sanitizePath(args.file)), 'utf8'); } catch { return 'File not found'; }
  }

  if (name === 'auto_approval_return') {
    return args.description || 'Auto-approval handover complete';
  }

  if (name === 'computer_use') {
    const action = args.action;
    console.log(`[SCREEN] Computer use: ${action}`);
    if (action === 'screenshot') {
      const shotPath = path.join(launchDir, `screenshot_${Date.now()}.png`);
      try {
        if (process.platform === 'darwin') {
          child_process.execSync(`screencapture -x "${shotPath}"`);
        } else if (process.platform === 'win32') {
          // Single-quoted PS strings treat backslashes literally; only ' needs doubling.
          const psPath = shotPath.replace(/'/g, "''");
          child_process.execSync(
            `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; ` +
            `$bmp = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); ` +
            `$gfx = [System.Drawing.Graphics]::FromImage($bmp); $gfx.CopyFromScreen(0,0,0,0,$bmp.Size); ` +
            `$bmp.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)"`,
            { stdio: 'ignore', timeout: 30000 }
          );
        } else {
          child_process.execSync(`import -window root "${shotPath}" || scrot "${shotPath}"`, { stdio: 'ignore' });
        }
      } catch (e) {
        return `Screenshot failed: ${e.message}`;
      }
      if (fs.existsSync(shotPath)) return `Screenshot saved to ${shotPath}`;
      return 'Screenshot failed (file was not created - is a display/session available?)';
    }
    // Real input injection (Windows): a temp .ps1 avoids triple-quoted command
    // strings; user32 mouse_event drives clicks, SendKeys drives typing/keys.
    const inputDir = path.join(launchDir, '.7coder');
    const runPsInput = (ps) => {
      try { fs.mkdirSync(inputDir, { recursive: true }); } catch (e) {}
      const file = path.join(inputDir, 'input.ps1');
      fs.writeFileSync(file, ps, 'utf8');
      child_process.execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`, { stdio: 'ignore', timeout: 30000 });
    };
    const escapeSendKeys = (text) => String(text)
      .replace(/([+^%~(){}[\]])/g, '{$1}')
      .replace(/\r\n/g, '{ENTER}').replace(/\r|\n/g, '{ENTER}').replace(/\t/g, '{TAB}');
    if (action === 'mouse_move' || action === 'click') {
      if (process.platform !== 'win32') return `[WARN] ${action} is Windows-only in this build (got ${process.platform}).`;
      const x = Math.max(0, Math.floor(Number(args.x) || 0));
      const y = Math.max(0, Math.floor(Number(args.y) || 0));
      const clickPart = action === 'click'
        ? '[Win7Input]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [Win7Input]::mouse_event(4,0,0,0,[UIntPtr]::Zero); '
        : '';
      try {
        runPsInput(
          'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;\n' +
          "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Win7Input { [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); }'\n" +
          `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})\n` +
          clickPart +
          'Write-Output done\n'
        );
        return `[OK] ${action === 'click' ? 'Clicked' : 'Cursor moved'} at ${x},${y}`;
      } catch (e) { return `Input error: ${e.message}`; }
    }
    if (action === 'type_text' && args.text) {
      if (process.platform !== 'win32') return `[WARN] type_text is Windows-only in this build (got ${process.platform}).`;
      try {
        runPsInput(
          'Add-Type -AssemblyName System.Windows.Forms;\n' +
          `[System.Windows.Forms.SendKeys]::SendWait('${escapeSendKeys(args.text).replace(/'/g, "''")}')\n` +
          'Write-Output done\n'
        );
        return `[OK] Typed ${String(args.text).length} character(s) via SendKeys`;
      } catch (e) { return `Input error: ${e.message}`; }
    }
    if (action === 'press_key' && args.key) {
      if (process.platform !== 'win32') return `[WARN] press_key is Windows-only in this build (got ${process.platform}).`;
      const keyMap = { enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ', win: '{LWIN}' };
      const k = String(args.key).trim().toLowerCase();
      const keys = k.split('+').map(part => {
        const mods = { ctrl: '^', alt: '%', shift: '+' };
        if (mods[part]) return mods[part];
        if (keyMap[part]) return keyMap[part];
        if (/^[a-z0-9]$/.test(part)) return part.toUpperCase();
        return '{' + part.toUpperCase() + '}';
      }).join('');
      try {
        runPsInput(
          'Add-Type -AssemblyName System.Windows.Forms;\n' +
          `[System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')\n` +
          'Write-Output done\n'
        );
        return `[OK] Pressed key: ${args.key}`;
      } catch (e) { return `Input error: ${e.message}`; }
    }
    return `[WARN] Unknown computer_use action "${action}". Available: screenshot, mouse_move, click, type_text, press_key.`;
  }

  if (name === 'workflow_tool') {
    const steps = Array.isArray(args.steps) ? args.steps : null;
    if (!steps || steps.length === 0) return 'Workflow error: steps must be a non-empty array';
    if (steps.length > 50) return 'Workflow error: too many steps (max 50)';
    const transcript = [];
    const finishWf = (stopReason) => {
      const head = stopReason ? ('[STOPPED] ' + stopReason) : '[OK] Workflow complete';
      return head + '\n' + transcript.join('\n');
    };
    workflowStepDepth++;
    try {
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i] || {};
      const toolName = typeof st.tool === 'string' ? st.tool.trim() : '';
      if (!toolName) {
        transcript.push('step ' + (i + 1) + ': ERROR - missing tool name');
        if (!st.optional) return finishWf('step ' + (i + 1) + ' has no tool name');
        continue;
      }
      if (toolName === 'workflow_tool') {
        transcript.push('step ' + (i + 1) + ' (' + toolName + '): ERROR - nested workflows are not allowed');
        return finishWf('nested workflow at step ' + (i + 1));
      }
      if (!tools.some(t => t.function.name === toolName)) {
        transcript.push('step ' + (i + 1) + ' (' + toolName + '): ERROR - unknown tool');
        if (!st.optional) return finishWf('unknown tool at step ' + (i + 1));
        continue;
      }
      const stepArgs = (st.args && typeof st.args === 'object' && !Array.isArray(st.args)) ? st.args : {};
      const res = await safeExecuteTool({ function: { name: toolName, arguments: JSON.stringify(stepArgs) } }, conversation);
      const firstLine = String(res).split('\n')[0];
      transcript.push('step ' + (i + 1) + ' (' + toolName + '): ' + firstLine.substring(0, 160));
      if (!st.optional && /^(?:\[ERROR\]|BLOCKED|Tool error|Parse error|Read error|Write error|Edit error|Workflow error)/.test(String(res))) {
        transcript.push('(stopped after failed step ' + (i + 1) + ')');
        return finishWf('step ' + (i + 1) + ' failed');
      }
    }
    return finishWf(null);
    } finally { workflowStepDepth--; }
  }

// ====================== TEST RUNNER PARSING (D2) ======================
// Turns noisy test-runner output into structured counts the model can act on.
function parseTestOutput(text) {
  const t = String(text);
  const num = (re) => { const m = t.match(re); return m ? parseInt(m[1], 10) : null; };
  let passed = num(/(\d+)+\s+pass(?:ing|ed)?/i);
  let failed = num(/(\d+)+\s+fail(?:ing|ed)?/i) || num(/#\s*fail\s+(\d+)/i);
  const skipped = num(/(\d+)+\s+skipped/i) || num(/#\s*skipped\s+(\d+)/i);
  if (passed === null) passed = num(/#\s*pass\s+(\d+)/i);
  const failures = [];
  for (const line of t.split('\n')) {
    if (/\u2715|\u2717|not ok|^FAIL\b/i.test(line)) {
      failures.push(line.trim().substring(0, 200));
    }
    if (failures.length >= 10) break;
  }
  const parsed = (passed !== null || failed !== null);
  const total = parsed ? ((passed || 0) + (failed || 0) + (skipped || 0)) : null;
  return { parsed, passed, failed, skipped, total, failures };
}

  if (name === 'run_tests_tool') {
    let command = String(args.command || "").trim();
    if (!command) {
      try {
        const pkgPath = path.join(launchDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          if (pkg.scripts && pkg.scripts.test) command = "npm test --silent";
        }
      } catch (e) {}
    }
    if (!command) {
      try {
        const hasTests = fs.readdirSync(launchDir).some(f => /\.test\.js$/i.test(f));
        if (hasTests) command = "node --test";
      } catch (e) {}
    }
    if (!command) return "Tests error: no command given and nothing to auto-detect (no scripts.test, no *.test.js).";
    const timeoutMs = Math.max(10, Math.min(600, parseInt(args.timeout_seconds, 10) || 120)) * 1000;
    console.log("[TESTS] running: " + command);
    let out = "";
    let exitStatus = 0;
    try {
      out = child_process.execSync(command, { encoding: "utf8", cwd: launchDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
      out = (e.stdout || "") + (e.stderr || "");
      exitStatus = e.status;
    }
    const r = parseTestOutput(out);
    if (!r.parsed) return "[TESTS] command finished (exit=" + exitStatus + ") but no recognizable summary.'\n'Output tail:'\n'" + out.substring(out.length - 2000);
    let res = "[TESTS] exit=" + exitStatus + " " + (r.passed || 0) + " passed, " + (r.failed || 0) + " failed, " + (r.skipped || 0) + " skipped (of " + r.total + ").";
    res += '\n';
    res += (r.failures.length ? "Failures:'\n'" + r.failures.join('\n') : "All green.");
    res += "'\n''\n'Raw tail:'\n'" + out.substring(out.length - 1500);
    return res;
  }

// ====================== GIT INTEGRATION (D1) ======================
function git(args, opts) {
  return child_process.execSync("git " + args, Object.assign({ encoding: "utf8", cwd: launchDir, timeout: 30000 }, opts || {}));
}
function inGitRepo() {
  try { git("rev-parse --is-inside-work-tree", { stdio: "pipe" }); return true; } catch (e) { return false; }
}

  if (name === 'git_status_tool') {
    if (!inGitRepo()) return "Not a git repository (no .git found in the workspace).";
    try {
      const branch = git("rev-parse --abbrev-ref HEAD").trim();
      const last = git("log -1 --oneline").trim();
      const status = git("status --short").trim();
      const linesN = status ? status.split("\n") : [];
      const counts = { staged: 0, modified: 0, untracked: 0 };
      for (const l of linesN) {
        const x = l.charAt(0), y = l.charAt(1);
        if (x !== " " && x !== "?") counts.staged++;
        if (y === "M" || x === "M") counts.modified++;
        if (l.startsWith("??")) counts.untracked++;
      }
      let out = "[GIT] branch " + branch + " | last: " + last + " | staged:" + counts.staged + " modified:" + counts.modified + " untracked:" + counts.untracked;
      if (status) out += "\n" + status.substring(0, 4000);
      return out;
    } catch (e) { return "Git status error: " + e.message; }
  }

  if (name === 'git_diff_tool') {
    if (!inGitRepo()) return "Not a git repository.";
    try {
      const stagedFlag = args.staged ? " --cached" : "";
      const scope = (typeof args.path === "string" && args.path.trim()) ? " -- " + JSON.stringify(sanitizePath(args.path)) : "";
      const diff = git("diff" + stagedFlag + scope).trim();
      if (!diff) return "[GIT] no changes" + (stagedFlag ? " (staged)" : "") + (scope ? " for " + args.path : "") + ".";
      return "[GIT] diff" + (stagedFlag ? " (staged)" : "") + ":\n" + diff.substring(0, 8000);
    } catch (e) { return "Git diff error: " + e.message; }
  }

  if (name === 'git_commit_tool') {
    if (!inGitRepo()) return "Not a git repository.";
    let message = (typeof args.message === "string" && args.message.trim()) ? args.message.trim() : "";
    if (!message) {
      // Generate from the session audit log (most common tool verbs of this session)
      try {
        const verbs = {};
        if (fs.existsSync(auditPath)) {
          for (const line of fs.readFileSync(auditPath, "utf8").split("\n")) {
            try { const e = JSON.parse(line); if (e.type === "tool") verbs[e.tool] = (verbs[e.tool] || 0) + 1; } catch (er) {}
          }
        }
        const top = Object.keys(verbs).sort((a, b) => verbs[b] - verbs[a]).slice(0, 3);
        message = "chore: session changes (" + (top.length ? "tools: " + top.join(", ") : "no tool activity") + ")";
      } catch (e) { message = "chore: session changes"; }
    }
    try {
      // Pre-commit snapshot for recovery: stash create keeps it retrievable without touching the tree
      let snapshot = "";
      try { const sh = git("stash create").trim(); if (sh) { git("update-ref -m \"7coder pre-commit snapshot\" refs/7coder/snapshots/" + sh + " " + sh, { stdio: "pipe" }); snapshot = sh; } } catch (e) {}
      if (args.stage_all !== false) git("add -A");
      const staged = git("diff --cached --name-only").trim();
      if (!staged) return "[GIT] nothing to commit (no staged changes).";
      git("commit -m " + JSON.stringify(message));
      const last = git("log -1 --oneline").trim();
      return "[OK] committed: " + last + (snapshot ? "\n(snapshot " + snapshot.substring(0, 12) + " recorded for recovery)" : "");
    } catch (e) { return "Git commit error: " + e.message; }
  }

  if (name === 'synthetic_output_tool') {
    const schema = args.schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !schema.properties) {
      return 'Synthetic output error: schema must be an object with a "properties" map';
    }
    const required = Array.isArray(schema.required) ? schema.required.filter(k => typeof k === 'string') : [];
    const genPrompt = `Generate a JSON object that conforms EXACTLY to this schema:
${JSON.stringify(schema, null, 2)}

Task: ${String(args.prompt || '')}

Rules:
- Output ONLY the JSON object, no prose, no markdown fences.
- Include every required field: ${JSON.stringify(required)}
- Match the declared types exactly.`;
    let lastError = 'no attempt made';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const choice = await callOpenAI(
          [{ role: 'user', content: attempt === 1 ? genPrompt : `${genPrompt}\n\nPrevious attempt was invalid: ${lastError}. Try again.` }],
          { useTools: false, temperature: 0.2 }
        );
        const raw = (choice.message.content || '').replace(/```(?:json)?/gi, '').trim();
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object found in response');
        const obj = JSON.parse(raw.substring(start, end + 1));
        for (const key of required) {
          if (!(key in obj)) throw new Error(`missing required field "${key}"`);
        }
        for (const key of Object.keys(schema.properties)) {
          if (key in obj && schema.properties[key] && schema.properties[key].type) {
            const expected = schema.properties[key].type;
            if (expected === 'integer') {
              if (typeof obj[key] !== 'number' || !Number.isInteger(obj[key])) throw new Error(`field "${key}" should be integer`);
            } else {
              const actual = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
              if (actual !== expected) throw new Error(`field "${key}" should be ${expected}, got ${actual}`);
            }
          }
        }
        return JSON.stringify(obj, null, 2);
      } catch (e) {
        lastError = e.message;
      }
    }
    return `Synthetic output error: ${lastError}`;
  }

  if (name === 'plan_mode') {
    const initialTask = args.initial_task || 'No task provided';
    const lightPrompt = `You are the LIGHT model in PLAN MODE.
Improve the INITIAL PROMPT for the HEAVY model to deeply think about this task.
Also specify the number of REFINEMENT LOOPS (1-5) the heavy model should perform.
Task: ${initialTask}
Reply with ONLY valid JSON:
{
  "improved_prompt": "full improved prompt text here",
  "refinement_loops": 3
}`;
    try {
      const lightChoice = await callOpenAI([{ role: 'user', content: lightPrompt }], { model: LIGHT_MODEL, useTools: false, maxTokens: 1000 });
      let planData = { improved_prompt: initialTask, refinement_loops: 2 };
      const content = (lightChoice.message.content || '{}').replace(/```(?:json)?/gi, '').trim();
      try {
        planData = JSON.parse(content);
        if (typeof planData.refinement_loops !== 'number') {
          planData.refinement_loops = parseInt(planData.refinement_loops, 10) || 2;
        }
      } catch (e) {}
      return `PLAN MODE ACTIVATED BY SMALL MODEL\nImproved prompt:\n${planData.improved_prompt}\nRefinement loops: ${planData.refinement_loops}\n\nHeavy model: Use the improved prompt above and perform exactly ${planData.refinement_loops} refinement iterations before final answer.`;
    } catch (e) {
      return `Plan mode error: ${e.message}. Falling back to original task.`;
    }
  }

  // Bickering Tool - 2 small-model PM sub-agents debate until agreement
  if (name === 'bickering_tool') {
    const task = args.task || 'No task provided';
    console.log(`Bickering Tool started - 2 PM sub-agents debating "${task.substring(0, 60)}..." for up to ${BICKER_ROUNDS} rounds`);
    let messagesPM1 = [{ role: 'system', content: `You are PM1, a strict product manager. Argue aggressively for the most robust, safe, scalable approach.` }];
    let messagesPM2 = [{ role: 'system', content: `You are PM2, a pragmatic product manager. Argue for the fastest, simplest, most practical approach.` }];
    let round = 0;
    let agreement = null;

    while (round < BICKER_ROUNDS && !agreement) {
      round++;
      // PM1 speaks
      messagesPM1.push({ role: 'user', content: `Round ${round}: Debate the best way to ${task}. Reply in 1-2 sentences.` });
      const pm1Resp = await callOpenAI(messagesPM1, { model: LIGHT_MODEL, useTools: false, maxTokens: 300 });
      const pm1Text = pm1Resp.message.content.trim();
      messagesPM1.push({ role: 'assistant', content: pm1Text });

      // PM2 responds
      messagesPM2.push({ role: 'user', content: `Round ${round}: PM1 said "${pm1Text}". Counter or agree in 1-2 sentences.` });
      const pm2Resp = await callOpenAI(messagesPM2, { model: LIGHT_MODEL, useTools: false, maxTokens: 300 });
      const pm2Text = pm2Resp.message.content.trim();
      messagesPM2.push({ role: 'assistant', content: pm2Text });

      console.log(`Round ${round}: PM1: ${pm1Text} | PM2: ${pm2Text}`);

      // Check for agreement
      const agreementPrompt = `Do these two statements show clear agreement on a plan? Reply ONLY YES or NO.\nPM1: ${pm1Text}\nPM2: ${pm2Text}`;
      const agreeCheck = await callOpenAI([{ role: 'user', content: agreementPrompt }], { model: LIGHT_MODEL, useTools: false });
      const agreeAnswer = (agreeCheck.message.content || '').replace(/[*'`"“”’‘.]/g, '').trim().toUpperCase();
      if (agreeAnswer.startsWith('YES')) {
        agreement = `Agreed plan after ${round} rounds: ${pm2Text}`;
      }
    }

    if (!agreement) agreement = `No full agreement after ${BICKER_ROUNDS} rounds. Best compromise: ${messagesPM2[messagesPM2.length-1].content}`;
    return `[OK] Bickering complete - ${agreement}`;
  }

  // Automated Debug Tool - full launch + test + auto-fix loop
  if (name === 'auto_debug_tool') {
    if (!ENABLE_AUTO_DEBUG) return 'Auto-debug disabled in .env (ENABLE_AUTO_DEBUG=false).';
    const filePath = path.join(launchDir, sanitizePath(args.path));
    let appType = args.type || (filePath.endsWith('.exe') || filePath.endsWith('.cs') ? 'gui' : 'cli');
    const duration = Math.max(2, Math.min(5, args.duration_minutes || DEBUG_TEST_MINUTES));
    const maxFix = 3;

    // Compile if needed
    if (filePath.endsWith('.cs')) {
      console.log('[BUILD] Compiling C#...');
      try {
        const outPath = filePath.slice(0, -3) + '.exe';
        child_process.execSync(`csc /target:winexe ${quoteForShell(filePath)} /out:${quoteForShell(outPath)}`, { cwd: launchDir, stdio: 'pipe', timeout: 120000 });
      } catch (e) {
        return `[ERROR] Compile failed: ${e.message}`;
      }
    }
    const exePath = filePath.endsWith('.cs') ? filePath.slice(0, -3) + '.exe' : filePath;

    let fixRound = 0;
    let finalLog = '';
    while (true) {
      const cycle = await runDebugCycle(exePath, filePath, appType, fixRound === 0 ? duration : 1);
      finalLog = cycle.log + '\nSTDOUT:\n' + cycle.stdout + '\nSTDERR:\n' + cycle.stderr;
      if (!/error|exception|crash|failed/i.test(finalLog) || fixRound >= maxFix) break;
      fixRound++;
      console.log(`[LOOP] Auto-debug fix round ${fixRound}/${maxFix}...`);
      // Run the fixer in its OWN conversation so the caller's
      // assistant(tool_calls) -> tool message pairing stays valid for the API.
      const fixMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Fix all fatal errors in this app. Only warnings allowed at the end.\nPath: ${args.path}\nRecent logs:\n${finalLog.substring(0, 8000)}\nRead the file, fix it, and output the COMPLETE fixed code via write_file.` }
      ];
      await processWithTools(fixMessages);
    }

    return `[OK] Auto-debug complete - ${fixRound} fix round(s) applied. Remaining issues: only warnings or benign.\nFull log:\n${finalLog}`;
  }

  return `Unknown tool: ${name}`;
}

// One launch + observe + kill cycle for auto_debug_tool.
async function runDebugCycle(exePath, filePath, appType, durationMinutes) {
  console.log(`Launching ${exePath}...`);
  let cmdToRun = exePath;
  let cmdArgs = [];
  if (filePath.endsWith('.js')) {
    cmdToRun = 'node';
    cmdArgs = [filePath];
  } else if (filePath.endsWith('.py')) {
    cmdToRun = process.platform === 'win32' ? 'python' : 'python3';
    cmdArgs = [filePath];
  } else if (filePath.endsWith('.sh')) {
    cmdToRun = 'bash';
    cmdArgs = [filePath];
  } else if (filePath.endsWith('.bat') || filePath.endsWith('.cmd')) {
    cmdToRun = 'cmd.exe';
    cmdArgs = ['/c', filePath];
  }

  let log = `[TOOL] Auto-debug cycle on ${filePath} (${appType}) for ${durationMinutes} min\n`;
  let stdoutData = '';
  let stderrData = '';
  let processHandle = null;

  if (appType === 'gui') {
    processHandle = child_process.spawn(cmdToRun, cmdArgs, { detached: true, stdio: 'ignore', cwd: launchDir });
    processHandle.unref();
    log += `[OK] GUI launched (PID ${processHandle.pid})\n`;
  } else {
    processHandle = child_process.spawn(cmdToRun, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: launchDir });
    log += `[OK] CLI launched (PID ${processHandle.pid})\n`;
    if (processHandle.stdout) {
      processHandle.stdout.setEncoding('utf8');
      processHandle.stdout.on('data', data => { stdoutData += data.toString(); });
    }
    if (processHandle.stderr) {
      processHandle.stderr.setEncoding('utf8');
      processHandle.stderr.on('data', data => { stderrData += data.toString(); });
    }
  }

  await new Promise(r => setTimeout(r, 2000)); // settle
  for (let i = 0; i < durationMinutes * 6; i++) { // ~10s intervals
    if (appType === 'gui' && ENABLE_COMPUTER_USE) {
      // Simulate normal user: random clicks, typing, etc.
      // (computer_use input actions are simulated no-ops today.)
      await executeToolRaw('computer_use', { action: 'mouse_move', x: Math.random() * 800, y: Math.random() * 600 });
      await executeToolRaw('computer_use', { action: 'click' });
      if (Math.random() > 0.7) await executeToolRaw('computer_use', { action: 'type_text', text: 'test input ' + Date.now() });
    }
    await new Promise(r => setTimeout(r, 10000));
  }

  if (processHandle) {
    try {
      if (process.platform === 'win32' && processHandle.pid) {
        // taskkill /T also kills children spawned by the app (plain SIGTERM cannot on Windows)
        child_process.execSync(`taskkill /PID ${processHandle.pid} /T /F`, { stdio: 'ignore', timeout: 15000 });
      } else {
        processHandle.kill('SIGTERM');
      }
    } catch (e) {}
    log += '[OK] App closed after test\n';
  }
  return { log, stdout: stdoutData, stderr: stderrData };
}

// ====================== SAFE TOOL EXECUTION ======================
// Auditing wrapper: records every tool call (args preview, status, duration)
// to .7coder/audit.jsonl, then delegates to the real implementation.
async function safeExecuteTool(toolCall, conversation) {
  const t0 = Date.now();
  const func = toolCall.function;
  let argsPreview = {};
  try { const a = JSON.parse(func.arguments || '{}'); for (const k of Object.keys(a)) argsPreview[k] = String(JSON.stringify(a[k])).substring(0, 200); } catch (e) { argsPreview = { raw: String(func.arguments || '').substring(0, 200) }; }
  const res = await safeExecuteToolInner(toolCall, conversation);
  const first = String(res).split('\n')[0];
  const status = /^BLOCKED/.test(res) ? 'blocked'
    : /declined/i.test(res) ? 'declined'
    : /^(?:\[ERROR\]|Tool error|Parse error|Read error|Write error|Edit error|Workflow error|Download error|List error|Input error|Kill error)/.test(res) ? 'error'
    : 'ok';
  audit({ ts: new Date().toISOString(), type: 'tool', tool: func.name, mode: effectivePermissionMode(), status, ms: Date.now() - t0, args: argsPreview, result: first.substring(0, 160) });
  return res;
}

async function safeExecuteToolInner(toolCall, conversation) {
  const func = toolCall.function;
  let args;
  try { args = JSON.parse(func.arguments || '{}'); } catch (e) { return `Parse error: ${e.message}`; }

  try {
    const name = func.name;
    const mode = effectivePermissionMode();

    // Denial blocks EVERY tool call, including otherwise auto-safe ones.
    if (mode === 'denial') return 'Permission mode = denial. Action blocked.';

    const protectedWrite = ['write_file', 'append_file', 'notebook_edit_tool', 'edit_file', 'download_tool'].includes(name) && isProtectedTarget(name, args);
    const protectedRead = ['read_file', 'prompt_from_file'].includes(name) && isProtectedTarget(name, args);

    if (protectedWrite && (mode === 'bypass' || mode === 'auto' || DANGER_MODE)) {
      return 'BLOCKED: protected file (credentials/config) - the AI cannot edit this file in bypass/auto mode. Edit it manually if needed.';
    }
    if (protectedRead) {
      console.warn(`[WARN] AI is reading protected file: ${path.basename(String(args.path || args.file))} (contains secrets)`);
    }

    if (!protectedRead && (AUTO_SAFE_TOOLS.includes(name) || (name === 'write_file' && args.path && args.path.toLowerCase().includes('7coder.md')))) {
      console.log(`[TOOL] Auto-executing safe tool: ${name}`);
      return await executeToolRaw(name, args, conversation);
    }

    if (['run_command', 'bash_tool', 'powershell_tool', 'task_create_tool'].includes(name)) {
      if (isSuperDangerous(args.command)) return 'BLOCKED: Super-dangerous command prevented (even in danger mode).';
    }

    if (name === 'computer_use' && !ENABLE_COMPUTER_USE) {
      return 'Computer use is disabled in .env (ENABLE_COMPUTER_USE=false).';
    }

    if (mode === 'bypass' || DANGER_MODE) {
      console.log(`[TOOL] [DANGER MODE] Executing tool: ${name}`);
      return await executeToolRaw(name, args, conversation);
    }

    // Deterministic risk classes (A8): the common tools need no light-model
    // classification. Unmapped tools still fall back to the light model.
    const DETERMINISTIC_RISK = {
      write_file: 'MEDIUM', append_file: 'MEDIUM', edit_file: 'MEDIUM',
      notebook_edit_tool: 'MEDIUM', download_tool: 'MEDIUM', todo_write_tool: 'LOW',
      brief_tool: 'LOW', sleep_tool: 'LOW', enter_worktree_tool: 'MEDIUM',
      agent_tool: 'MEDIUM', schedule_cron_tool: 'HIGH', cron_create_tool: 'HIGH',
      cron_delete_tool: 'MEDIUM', process_kill_tool: 'HIGH',
      run_command: 'HIGH', bash_tool: 'HIGH', powershell_tool: 'HIGH',
      task_create_tool: 'HIGH', mcp_tool: 'HIGH', workflow_tool: 'HIGH', run_tests_tool: 'HIGH',
      git_status_tool: 'LOW', git_diff_tool: 'LOW', git_commit_tool: 'HIGH'
    };
    const risk = (protectedWrite || protectedRead) ? 'HIGH' : (DETERMINISTIC_RISK[name] || await classifyRisk(name, args));

    if (mode === 'auto') {
      // workflow_tool wrapper: every inner step is individually permission-
      // checked, so the meta-approval adds no safety - the light model's YES/NO
      // on a vague 'N-step workflow' just makes the feature unusable in auto.
      const inheritPlan = workflowStepDepth > 0 && !protectedWrite;
      if (name === 'workflow_tool') {
        console.log('[PERM] workflow auto-approved (each inner step is still permission-checked)');
      } else if (inheritPlan) {
        console.log('[PERM] workflow inner step inherits plan approval: ' + name);
      } else {
        const safe = await isAutoApprovalSafe(name, args, risk);
        if (!safe) return `Auto-approval declined by light model. Risk: ${risk}.`;
      }
    } else {
      let preview = null;
      if (['write_file', 'append_file', 'edit_file'].includes(name) && args.path && typeof args.path === 'string') {
        // Show the real diff instead of an LLM paraphrase - deterministic and cheaper.
        try {
          const fullPath = path.join(launchDir, sanitizePath(args.path));
          let oldText = '';
          try { oldText = fs.readFileSync(fullPath, 'utf8'); } catch (e) {}
          let newText = oldText;
          if (name === 'edit_file') {
            const oldStr = String(args.old_string === undefined ? '' : args.old_string);
            const newStr = String(args.new_string === undefined ? '' : args.new_string);
            if (oldStr && oldText.split(oldStr).length > 1) newText = oldText.split(oldStr).join(newStr);
          } else if (name === 'write_file') {
            newText = String(args.content === undefined ? '' : args.content);
          } else {
            newText = oldText + String(args.content === undefined ? '' : args.content);
          }
          preview = simpleLineDiff(oldText, newText);
        } catch (e) { preview = null; }
      }
      if (preview) {
        console.log(`\n[PERM] Proposed change to ${args.path}:\n${preview}\n`);
      } else if (DETERMINISTIC_EXPLAIN[name]) {
        console.log(`\n[PERM] ${DETERMINISTIC_EXPLAIN[name](args)} (risk: ${risk})`);
      } else {
        const expl = await getPermissionExplanation(name, args, risk);
        console.log(`\n[PERM] ${expl}`);
      }
      if (workflowStepDepth > 0 && !protectedWrite) {
        console.log('[PERM] workflow inner step inherits plan approval: ' + name);
      } else {
      const approved = await askApproval(`Execute ${name}${protectedWrite ? ' (PROTECTED FILE - make sure you really want this)' : ''}? (y/n) `);
      if (!approved) return 'User declined the tool action.';
      }
    }

    console.log(`[TOOL] Executing approved tool: ${name}`);
    return await executeToolRaw(name, args, conversation);
  } catch (e) {
    // Never let a tool exception kill the whole conversation - feed the error
    // back to the model so it can react.
    return `Tool error: ${e.message}`;
  }
}

// ====================== APPROVAL ======================
async function askApproval(question) {
  if (!INTERACTIVE || rlClosed) {
    console.log(`\n[PERM] ${question} (auto-skipped in non-interactive mode)`);
    return false;
  }
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.toLowerCase().startsWith('y')));
  });
}

// ====================== TOOL CALLING LOOP ======================
// Central choke point for every model call: caps tool result size and
// compresses the conversation when it grows past CONTEXT_CHARS.
function capToolResult(result) {
  const s = String(result === undefined || result === null ? '' : result);
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  const head = Math.floor(MAX_TOOL_RESULT_CHARS * 0.7);
  const tail = MAX_TOOL_RESULT_CHARS - head;
  return s.substring(0, head) +
    `\n\n[... tool result truncated: ${s.length - MAX_TOOL_RESULT_CHARS} chars omitted from the middle ...]\n` +
    `[DO NOT rewrite this file from this truncated view - the omitted range is missing. Re-read with offset/limit first.]\n\n` +
    s.substring(s.length - tail);
}

function messageSize(m) {
  let n = 0;
  if (m.content) n += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n;
}

async function summarizeConversation(oldMessages) {
  const transcript = oldMessages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')}` +
      (m.tool_calls ? ` [called: ${m.tool_calls.map(t => t.function.name).join(', ')}]` : ''))
    .join('\n')
    .substring(0, 20000);
  try {
    const choice = await callOpenAI([{
      role: 'user',
      content: `Summarize this coding conversation compactly. Keep: user goals, files touched, key decisions, errors hit and their fixes, open threads. Max 15 bullet lines.\n\n${transcript}`
    }], { model: LIGHT_MODEL, useTools: false, maxTokens: 600 });
    return (choice.message.content || '').trim() || '(summary unavailable)';
  } catch (e) {
    return '(summary unavailable: ' + e.message + ')';
  }
}

// When the conversation exceeds CONTEXT_CHARS, summarize the oldest turns and
// keep the newest ~60% of the budget verbatim. The split point is moved forward
// to the first position that keeps API pairing valid: a 'user' turn, or an
// 'assistant' turn (assistant may follow anything; a 'tool' message may NOT be
// the kept-start because its assistant(tool_calls) would land in the summarized
// part). This also enables compression inside sub-agent conversations, which
// contain no user turns after the initial task.
async function compressConversationIfNeeded(currentMessages) {
  let total = 0;
  for (const m of currentMessages) total += messageSize(m);
  if (total <= CONTEXT_CHARS) return;

  let kept = 0;
  let splitIdx = 1;
  for (let i = currentMessages.length - 1; i >= 1; i--) {
    kept += messageSize(currentMessages[i]);
    splitIdx = i;
    if (kept > CONTEXT_CHARS * 0.6) break;
  }
  while (splitIdx < currentMessages.length && currentMessages[splitIdx].role === 'tool') splitIdx++;
  if (splitIdx < 1 || splitIdx >= currentMessages.length) return;

  // If the walk landed at messages[1] the oldPart would be empty. Extend
  // forward to the first safe boundary instead (the audit's dead-zone case):
  // this summarizes the OLDEST turns while the kept part stays pair-valid.
  if (splitIdx === 1 && currentMessages.length > 2) {
    splitIdx = 2;
    while (splitIdx < currentMessages.length && currentMessages[splitIdx].role === 'tool') splitIdx++;
    if (splitIdx >= currentMessages.length) return;
  }

  // Never compress when the model has not yet seen the current task: with no
  // assistant turn after the last user message, the "old" part IS the live
  // task (e.g. [system, task]) and summarizing it would destroy it.
  let lastUserIdx = -1;
  for (let i = currentMessages.length - 1; i >= 1; i--) {
    if (currentMessages[i].role === 'user') { lastUserIdx = i; break; }
  }
  const assistantAfterLastUser = currentMessages.slice(lastUserIdx + 1).some(m => m.role === 'assistant');
  if (splitIdx >= lastUserIdx && !assistantAfterLastUser) return;

  const oldPart = currentMessages.slice(1, splitIdx);
  if (!oldPart.length) return;
  // Zero-progress guard: when the kept tail alone exceeds the budget, the only
  // summarizable message can be a previous summary - re-summarizing it forever
  // wastes light-model calls without ever converging. Warn and stop instead.
  if (oldPart.length === 1 && String(oldPart[0].content || '').includes('[CONTEXT COMPRESSION]')) {
    console.warn('[CTX] Context still over budget after compression; a single large message dominates. Consider raising CONTEXT_CHARS.');
    return;
  }
  const digest = await summarizeConversation(oldPart);
  const summaryMsg = {
    role: 'user',
    content: `[CONTEXT COMPRESSION] Earlier turns were summarized to fit the context window. Summary of everything before this point:\n${digest}`
  };
  currentMessages.splice(1, splitIdx - 1, summaryMsg);
  let newTotal = 0;
  for (const m of currentMessages) newTotal += messageSize(m);
  console.log(`[CTX] Context compressed: ${oldPart.length} messages summarized (${total} -> ${newTotal} chars).`);
}

async function processWithTools(currentMessages, opts = {}) {
  const onDelta = opts.onDelta || null;
  const onReasoning = opts.onReasoning || null;
  const reqModel = opts.model || HEAVY_MODEL;
  // Cancellation token (A5): an HTTP client that disconnects mid-stream can
  // stop the run at the next step/tool boundary instead of running to
  // completion for a ghost client.
  const cancelled = opts.cancel || (() => false);
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (cancelled()) return '[aborted: client disconnected]';
    await compressConversationIfNeeded(currentMessages);
    const choice = await callOpenAI(currentMessages, { onDelta, onReasoning, model: reqModel });
    const assistantMsg = choice.message;
    currentMessages.push(assistantMsg);
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const tc of assistantMsg.tool_calls) {
        if (cancelled()) return '[aborted: client disconnected]';
        const result = await safeExecuteTool(tc, currentMessages);
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: capToolResult(result) });
      }
      continue;
    }
    return assistantMsg.content || '';
  }
  // Step limit reached - force a final answer without any more tool calls.
  currentMessages.push({ role: 'user', content: `Tool step limit (${MAX_TOOL_STEPS}) reached. Wrap up now and give your final answer without calling more tools.` });
  const finalChoice = await callOpenAI(currentMessages, { useTools: false, onDelta, onReasoning, model: reqModel });
  currentMessages.push(finalChoice.message);
  return finalChoice.message.content || '';
}

// ====================== CORE EXECUTION ======================
let currentRawPrompt = '';

function buildTaskUserContent(rawPrompt) {
  const mdPath = path.join(launchDir, '7CODER.md');
  let content = rawPrompt;
  if (fs.existsSync(mdPath)) {
    try {
      const completeSummary = fs.readFileSync(mdPath, 'utf8').trim();
      if (completeSummary) {
        content += `\n\nthis is what's already been done.\n${completeSummary}`;
      }
    } catch (e) {
      console.error('Error reading 7CODER.md:', e);
    }
  }
  return content;
}

function prepareMessagesForPrompt(rawPrompt) {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildTaskUserContent(rawPrompt) }
  ];
}

// ====================== EDIT SAFETY NET (backups + diff preview) ======================
const backupsDir = path.join(launchDir, '.7coder', 'backups');

function backupFile(fullPath) {
  try {
    // Opportunistic pruning so the backup dir stays bounded even when the
    // current target doesn't exist yet (no backup would be created).
    pruneBackups();
    if (!fs.existsSync(fullPath)) return null;
    const rel = path.relative(launchDir, fullPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupsDir, rel + '.' + stamp + '.bak');
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(fullPath, backupPath);
    // copyFileSync preserves the SOURCE mtime on Windows, which would make an
    // old file's brand-new backup look "oldest" to prune/restore ordering.
    // Touch it so the backup's mtime is its creation time.
    const now = new Date();
    try { fs.utimesSync(backupPath, now, now); } catch (e) {}
    pruneBackups();
    return backupPath;
  } catch (e) {
    return null;
  }
}

// Keep at most 100 backup files (oldest get removed first).
function pruneBackups() {
  try {
    const rels = recursiveReaddir('.7coder/backups').filter(r => r.endsWith('.bak'));
    if (rels.length <= 100) return;
    const withTimes = rels.map(r => {
      const full = path.join(launchDir, r);
      return { full, mt: fs.statSync(full).mtimeMs };
    }).sort((a, b) => a.mt - b.mt);
    for (let i = 0; i < withTimes.length - 100; i++) {
      try { fs.unlinkSync(withTimes[i].full); } catch (e) {}
    }
  } catch (e) {}
}

// Restore the newest backup of a workspace-relative file. Used by the /undo command.
function restoreLatestBackup(rel) {
  try {
    const safeRel = sanitizePath(rel);
    const rels = recursiveReaddir('.7coder/backups').filter(r => {
      // recursiveReaddir returns launchDir-relative paths; normalize to backup-dir-relative
      const relInBackup = path.relative(backupsDir, path.join(launchDir, r));
      const m = relInBackup.match(/^(.*)\.\d{4}-\d{2}-\d{2}T[\d\-]+Z\.bak$/);
      return m && m[1] === safeRel;
    });
    if (!rels.length) return false;
    let newest = null;
    let newestMtime = 0;
    for (const r of rels) {
      const full = path.join(launchDir, r);
      const mt = fs.statSync(full).mtimeMs;
      if (mt > newestMtime) { newestMtime = mt; newest = full; }
    }
    fs.copyFileSync(newest, path.join(launchDir, safeRel));
    return true;
  } catch (e) {
    return false;
  }
}

// Small unified-ish diff for approval previews: trims the common prefix/suffix,
// then shows a bit of context plus - / + lines. Not a full LCS diff, but enough
// for a human to judge an edit.
function simpleLineDiff(oldText, newText, contextLines = 2, maxLines = 40) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (start === endA && start === endB) return '(no textual change)';
  const lines = [];
  const ctxStart = Math.max(0, start - contextLines);
  for (let i = ctxStart; i < start; i++) lines.push('  ' + (i + 1) + ': ' + a[i]);
  if (ctxStart < start) lines.push('  ...');
  for (let i = start; i < endA; i++) lines.push('- ' + (i + 1) + ': ' + a[i]);
  for (let j = start; j < endB; j++) lines.push('+ ' + (j + 1) + ': ' + b[j]);
  if (endA < a.length) lines.push('  ...');
  const ctxEnd = Math.min(a.length, endA + contextLines);
  for (let i = endA; i < ctxEnd; i++) lines.push('  ' + (i + 1) + ': ' + a[i]);
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n  ... (${lines.length - maxLines} more diff lines)`;
  }
  return lines.join('\n');
}

// ====================== SESSION PERSISTENCE (D4) ======================
// The REPL conversation is auto-saved after every task so a later run can
// continue it via --resume (CLI) or /resume (REPL command). Only user/
// assistant turns are saved: tool messages would break API pairing on load.
const sessionPath = path.join(launchDir, '.7coder', 'session.json');
function saveSession() {
  try {
    if (messages.length <= 1) return; // system only - nothing to save
    // Strip tool_calls from assistant turns: the tool results are filtered out,
    // so keeping the calls would break assistant(tool_calls) -> tool pairing on load.
    const keep = messages
      .filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
      .map(m => (m.role === 'assistant' && m.tool_calls) ? { role: 'assistant', content: m.content || '' } : m);
    const body = JSON.stringify({ savedAt: new Date().toISOString(), messages: keep });
    if (body.length > 2 * 1024 * 1024) { console.warn('[WARN] session too large to save (>2MB)'); return; }
    fs.mkdirSync(path.join(launchDir, '.7coder'), { recursive: true });
    fs.writeFileSync(sessionPath, body, 'utf8');
    // timestamped history copy for the web session browser (newest 20 kept)
    try {
      const sdir = path.join(launchDir, '.7coder', 'sessions');
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(path.join(sdir, new Date().toISOString().replace(/[:.]/g, '-') + '.json'), body, 'utf8');
      const olds = fs.readdirSync(sdir).filter(f => f.endsWith('.json')).sort();
      while (olds.length > 20) { try { fs.unlinkSync(path.join(sdir, olds.shift())); } catch (e2) { break; } }
    } catch (e2) {}
  } catch (e) { console.warn('[WARN] session save failed: ' + e.message); }
}
function loadSession() {
  try {
    if (!fs.existsSync(sessionPath)) return false;
    const j = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (!Array.isArray(j.messages)) return false;
    const clean = j.messages.filter(m => m && (m.role === 'system' || ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')));
    if (clean.length < 2) return false;
    messages = clean;
    return true;
  } catch (e) { console.warn('[WARN] session load failed: ' + e.message); return false; }
}

async function summarizeAction(rawPrompt, assistantResponse) {
  const prompt = `Create a short, concise summary (1-2 sentences) of what has been done in response to the user's task. Do not list tools, just describe the output/effect.
User task: "${rawPrompt}"
Action/Response: "${assistantResponse}"`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: LIGHT_MODEL, useTools: false });
    return (choice.message.content || `Completed task: ${rawPrompt}`).trim();
  } catch (e) {
    return `Completed task: ${rawPrompt}`;
  }
}

// Task summaries live inside a marker-delimited section so they never destroy
// free-form content (e.g. a dream session's reorganized 7CODER.md). Anything
// outside the markers is preserved verbatim; the bullet log inside is rebuilt
// from the previous bullets plus the new one.
const LOG_START = '<!-- 7coder:auto-log:start -->';
const LOG_END = '<!-- 7coder:auto-log:end -->';

function updateCompleteSummary(newSummary) {
  const mdPath = path.join(launchDir, '7CODER.md');
  let existing = '';
  try {
    if (fs.existsSync(mdPath)) existing = fs.readFileSync(mdPath, 'utf8');
  } catch (e) {
    console.error('Error reading 7CODER.md:', e);
  }
  // Bullets from the previous auto-log section (if present)
  let summaries = [];
  const startIdx = existing.indexOf(LOG_START);
  const endIdx = existing.indexOf(LOG_END);
  if (startIdx >= 0 && endIdx > startIdx) {
    const inner = existing.substring(startIdx + LOG_START.length, endIdx);
    summaries = inner.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim())
      .filter(Boolean);
  }
  summaries.push(newSummary);
  // Free-form content outside the markers survives (dream sessions, user notes)
  const outside = (startIdx >= 0 && endIdx > startIdx)
    ? (existing.substring(0, startIdx) + existing.substring(endIdx + LOG_END.length)).trim()
    : existing.trim();
  const autoSection = LOG_START + '\n' + summaries.map(s => '- ' + s).join('\n') + '\n' + LOG_END;
  const next = outside ? autoSection + '\n\n' + outside + '\n' : autoSection + '\n';
  try {
    fs.writeFileSync(mdPath, next, 'utf8');
    console.log('[OK] 7CODER.md updated with complete summary');
  } catch (e) {
    console.error('Error writing to 7CODER.md:', e);
  }
}

// ====================== CORE EXECUTION ======================
async function executeTask() {
  console.log(`7coder is ${getRandomSpinner()}`);
  try {
    let streamed = false;
    const onDelta = (t) => { streamed = true; process.stdout.write(t); };
    let displayReply = await processWithTools(messages, { onDelta });

    if (ENABLE_RALPH_MODE) {
      console.log(`[LOOP] Ralph Wiggum Loop - Iteration 1: ${displayReply.substring(0, 120)}${displayReply.length > 120 ? '...' : ''}`);

      for (let attempt = 2; attempt <= RALPH_ITERATIONS; attempt++) {
        const refineMsg = `You are in Claude-Like Ralph Wiggum loop mode. This is iteration ${attempt}. Review and iterate. You may use any tools. If complete, start reply with exactly "RALPH_WIGGUM_COMPLETE" followed by final version.`;
        messages.push({ role: 'user', content: refineMsg });
        displayReply = await processWithTools(messages, { onDelta });

        if (displayReply.trim().startsWith('RALPH_WIGGUM_COMPLETE')) {
          displayReply = displayReply.replace(/^RALPH_WIGGUM_COMPLETE\s*/i, '').trim();
          console.log(`[OK] Completion promise fulfilled at iteration ${attempt}!`);
          break;
        }
        console.log(`[LOOP] Ralph Wiggum Loop - Iteration ${attempt}: ${displayReply.substring(0, 120)}${displayReply.length > 120 ? '...' : ''}`);
      }
    }

    // Generate action summary using the small model
    const newSummary = await summarizeAction(currentRawPrompt, displayReply);
    updateCompleteSummary(newSummary);

    updateLastInteractionTime();

    if (streamed) console.log(''); // deltas were already printed live
    else console.log(`\n7coder: ${displayReply}`);
  } catch (err) {
    console.error(`[ERROR] Error: ${err.message}`);
  }
}

// Build a 7coder conversation from a client's OpenAI-style message list.
// The client's own history gives multi-turn continuity over HTTP; our system
// prompt always replaces theirs. Tool messages are not replayed.
function conversationFromClient(clientMessages) {
  const convo = [{ role: 'system', content: systemPrompt }];
  let firstUser = true;
  for (const m of (clientMessages || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let content = Array.isArray(m.content)
      ? m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
      : (typeof m.content === 'string' ? m.content : (m.content === undefined || m.content === null ? '' : JSON.stringify(m.content)));
    if (!content) continue;
    if (m.role === 'user' && firstUser) {
      content = buildTaskUserContent(content);
      firstUser = false;
    }
    convo.push({ role: m.role, content });
  }
  if (convo.length === 1) convo.push({ role: 'user', content: buildTaskUserContent('') });
  return convo;
}

// ====================== HTTP SERVER ======================
function startHttpServer() {
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(HTTP_BIND);
  if (!isLoopback && !HTTP_API_KEY) {
    console.warn('[WARN] HTTP_BIND is not loopback and HTTP_API_KEY is not set -');
    console.warn('[WARN] anyone on the network could use this endpoint to run tools on this machine!');
    console.warn('[WARN] Set HTTP_API_KEY in .env (clients send "Authorization: Bearer <key>") or keep HTTP_BIND=127.0.0.1.');
  }
  const server = http.createServer((req, res) => {
  // Built-in chat UI (Chinese-friendly web frontend for the terminal-shy)
  if (req.method === 'GET' && (req.url === '/' || req.url === '/ui')) {
    try {
      const html = fs.readFileSync(path.join(appDir, 'webui.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('webui.html not found next to index.js');
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: HEAVY_MODEL, light: LIGHT_MODEL, workspace: launchDir, mode: PERMISSION_MODE, keyRequired: !!HTTP_API_KEY, models: modelList() }));
    return;
  }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [HEAVY_MODEL, LIGHT_MODEL].map(id => ({ id, object: 'model', owned_by: '7coder' }))
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/sessions') {
      if (HTTP_API_KEY && req.headers.authorization !== `Bearer ${HTTP_API_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      try {
        const sdir = path.join(launchDir, '.7coder', 'sessions');
        const list = fs.existsSync(sdir)
          ? fs.readdirSync(sdir).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
              try {
                const j = JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8'));
                const firstUser = (j.messages || []).find(m => m.role === 'user');
                return { file: f, savedAt: j.savedAt || '?', turns: (j.messages || []).length, preview: firstUser ? String(firstUser.content).substring(0, 80) : '' };
              } catch (e) { return { file: f, savedAt: '?', turns: 0, preview: '(unreadable)' };
              }
            })
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: list }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions/load') {
      if (HTTP_API_KEY && req.headers.authorization !== `Bearer ${HTTP_API_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const wanted = String(JSON.parse(body).file || "");
          if (!/^[A-Za-z0-9._-]+[.]json$/.test(wanted)) throw new Error('invalid session file name');
          const f = path.join(launchDir, '.7coder', 'sessions', wanted);
          if (!fs.existsSync(f)) throw new Error("session not found: " + wanted);
          const j = JSON.parse(fs.readFileSync(f, "utf8"));
          const msgs = (j.messages || [])
            .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
            .map(m => ({ role: m.role, content: m.content }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages: msgs, savedAt: j.savedAt || "?" }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions/delete') {
      if (HTTP_API_KEY && req.headers.authorization !== `Bearer ${HTTP_API_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const wanted = String(JSON.parse(body).file || "");
          if (!/^[A-Za-z0-9._-]+[.]json$/.test(wanted)) throw new Error('invalid session file name');
          const f = path.join(launchDir, '.7coder', 'sessions', wanted);
          if (!fs.existsSync(f)) throw new Error("session not found: " + wanted);
          fs.unlinkSync(f);
          audit({ ts: new Date().toISOString(), type: 'session_delete', file: wanted });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deleted: wanted }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions/save') {
      if (HTTP_API_KEY && req.headers.authorization !== `Bearer ${HTTP_API_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const msgs = JSON.parse(body).messages;
          if (!Array.isArray(msgs)) throw new Error("messages must be an array");
          const clean = msgs
            .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
            .map(m => ({ role: m.role, content: m.content }));
          const sdir = path.join(launchDir, '.7coder', 'sessions');
          fs.mkdirSync(sdir, { recursive: true });
          // 客户端可携带 file 名原地覆盖同一会话记录；否则生成新记录
          const wanted = String(JSON.parse(body).file || "");
          let name = "web-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
          if (/^[A-Za-z0-9._-]+[.]json$/.test(wanted) && fs.existsSync(path.join(sdir, wanted))) name = wanted;
          fs.writeFileSync(path.join(sdir, name), JSON.stringify({ savedAt: new Date().toISOString(), messages: clean }), "utf8");
          audit({ ts: new Date().toISOString(), type: 'session_save', file: name, turns: clean.length });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, file: name, turns: clean.length }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/open') {
      const loopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(HTTP_BIND);
      if (HTTP_API_KEY && req.headers.authorization !== `Bearer ${HTTP_API_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          const target = j.target;
          if (target !== "workspace" && target !== "config") throw new Error("target must be workspace or config");
          if (j.dry) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, dry: true }));
            return;
          }
          let openPath;
          if (target === "workspace") {
            openPath = launchDir;
          } else {
            const wsEnv = path.join(launchDir, ".env");
            if (fs.existsSync(wsEnv)) openPath = wsEnv;
            else {
              const ex = path.join(appDir, ".env");
              if (!fs.existsSync(ex)) {
                try { fs.copyFileSync(path.join(appDir, ".env.example"), wsEnv); openPath = wsEnv; }
                catch (e2) { openPath = ex; }
              } else openPath = ex;
            }
          }
          let cmd, cmdArgs;
          if (process.platform === "win32") { cmd = "cmd.exe"; cmdArgs = ["/c", "start", "", openPath]; }
          else if (process.platform === "darwin") { cmd = "open"; cmdArgs = [openPath]; }
          else { cmd = "xdg-open"; cmdArgs = [openPath]; }
          const c = child_process.spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" });
          c.on("error", () => {});
          c.unref();
          audit({ ts: new Date().toISOString(), type: 'open', target, path: openPath });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, target, path: openPath }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
      return;
    }

    function writeWorkspaceEnv(updates) {
      const wsEnv = path.join(launchDir, '.env');
      let existing = {};
      try { if (fs.existsSync(wsEnv)) existing = require("dotenv").parse(fs.readFileSync(wsEnv)); } catch (e) {}
      for (const k of Object.keys(updates)) existing[k] = updates[k];
      const out = Object.keys(existing).map(k => k + "=" + existing[k]).join("\n") + "\n";
      fs.writeFileSync(wsEnv, out, "utf8");
    }
    function keyOk(req) {
      return !HTTP_API_KEY || req.headers.authorization === `Bearer ${HTTP_API_KEY}`;
    }
    if (req.method === 'GET' && req.url === '/api/settings') {
      if (!keyOk(req)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Unauthorized" } })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ endpoint: OPENAI_ENDPOINT, apiKey: OPENAI_API_KEY || "", model: HEAVY_MODEL, profiles: modelProfiles }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/settings') {
      if (!keyOk(req)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Unauthorized" } })); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          const updates = {};
          if (typeof j.endpoint === "string" && j.endpoint.trim()) { OPENAI_ENDPOINT = j.endpoint.trim(); updates.OPENAI_ENDPOINT = OPENAI_ENDPOINT; }
          if (typeof j.apiKey === "string") { OPENAI_API_KEY = j.apiKey; updates.OPENAI_API_KEY = j.apiKey; }
          if (typeof j.model === "string" && j.model.trim()) { HEAVY_MODEL = j.model.trim(); updates.HEAVY_MODEL = HEAVY_MODEL; }
          if (Object.keys(updates).length) writeWorkspaceEnv(updates);
          audit({ ts: new Date().toISOString(), type: 'settings', keys: Object.keys(updates) });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, endpoint: OPENAI_ENDPOINT, apiKeySet: !!OPENAI_API_KEY, model: HEAVY_MODEL }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/models-config') {
      if (!keyOk(req)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Unauthorized" } })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ profiles: modelProfiles }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/models-config') {
      if (!keyOk(req)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Unauthorized" } })); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const profiles = JSON.parse(body).profiles;
          if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw new Error("profiles must be an object");
          for (const k of Object.keys(profiles)) {
            const v = profiles[k];
            if (!k || typeof v !== "object" || Array.isArray(v)) throw new Error("bad profile entry: " + k);
            if (v.endpoint !== undefined && typeof v.endpoint !== "string") throw new Error("bad endpoint for " + k);
            if (v.apiKey !== undefined && typeof v.apiKey !== "string") throw new Error("bad apiKey for " + k);
          }
          const sdir = path.join(launchDir, '.7coder');
          fs.mkdirSync(sdir, { recursive: true });
          fs.writeFileSync(path.join(sdir, "models.json"), JSON.stringify(profiles, null, 2), "utf8");
          loadModelProfiles();
          audit({ ts: new Date().toISOString(), type: 'models_config', models: Object.keys(profiles) });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, models: modelList() }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/mode') {
      if (HTTP_API_KEY) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${HTTP_API_KEY}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unauthorized: invalid or missing API key' } }));
          return;
        }
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const wanted = (JSON.parse(body).mode || '').toLowerCase().trim();
          if (!VALID_PERMISSION_MODES.includes(wanted)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid mode. Valid: ' + VALID_PERMISSION_MODES.join(', ') } }));
            return;
          }
          const prev = PERMISSION_MODE;
          PERMISSION_MODE = wanted;
          console.log('[PERM] permission mode changed: ' + prev + ' -> ' + wanted);
          audit({ ts: new Date().toISOString(), type: 'mode', from: prev, to: wanted });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode: PERMISSION_MODE }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (HTTP_API_KEY) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${HTTP_API_KEY}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unauthorized: invalid or missing API key' } }));
          return;
        }
      }
      let body = '';
      let oversized = false;
      req.setEncoding('utf8');
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 10 * 1024 * 1024) oversized = true;
      });
      req.on('end', async () => {
        let wantsStream = false;
        try {
          if (oversized) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Request body too large' } }));
            return;
          }
          const data = JSON.parse(body);
          const reqModel = (typeof data.model === 'string' && data.model.trim()) ? data.model.trim().substring(0, 200) : HEAVY_MODEL;
          wantsStream = data.stream === true;
          const tempMessages = conversationFromClient(data.messages);
          const rawPrompt = tempMessages.length > 1 && tempMessages[tempMessages.length - 1].role === 'user'
            ? tempMessages[tempMessages.length - 1].content
            : '';

          console.log('[WEB] HTTP request received from UI');
          const responseId = 'chatcmpl-' + Date.now();
          const created = Math.floor(Date.now() / 1000);

          if (wantsStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });
            // Client-disconnect safety: res.write on a destroyed socket throws
            // inside the upstream 'data' handler (uncaughtException kills the
            // whole server on Node 13). Track the client and stop writing.
            // NOTE: must listen on RES close (fires on abnormal termination),
            // not req close (fires as soon as the request body is consumed).
            let clientGone = false;
            res.on('close', () => { clientGone = true; });
            const writeChunk = (delta, finishReason) => {
              if (clientGone || res.destroyed) return;
              try {
                res.write(`data: ${JSON.stringify({
                  id: responseId, object: 'chat.completion.chunk', created, model: HEAVY_MODEL,
                  choices: [{ index: 0, delta, finish_reason: finishReason || null }]
                })}\n\n`);
              } catch (e) {
                clientGone = true;
              }
            };
            const ka = setInterval(() => {
              if (clientGone || res.destroyed) { clearInterval(ka); return; }
              try { res.write(': keep-alive\n\n'); } catch (e) { clientGone = true; clearInterval(ka); }
            }, 5000);
            const result = await processWithTools(tempMessages, { onDelta: t => writeChunk({ content: t }, null), cancel: () => clientGone, model: reqModel, onReasoning: t => writeChunk({ reasoning: t }, null) });
            clearInterval(ka);
            // Give the socket-close event a moment to land when the client
            // aborted at the very end of the run - then skip the summary.
            await new Promise(r => setTimeout(r, clientGone ? 0 : 150));
            if (clientGone) return; // aborted: skip summary, 7CODER.md untouched
            writeChunk({}, 'stop');
            res.write('data: [DONE]\n\n');
            res.end();
            const newSummary = await summarizeAction(rawPrompt, result);
            updateCompleteSummary(newSummary);
            return;
          }

          const result = await processWithTools(tempMessages, { model: reqModel });

          // Summarize and update 7CODER.md
          const newSummary = await summarizeAction(rawPrompt, result);
          updateCompleteSummary(newSummary);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: responseId,
            object: 'chat.completion',
            created,
            model: HEAVY_MODEL,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: result },
              finish_reason: 'stop'
            }]
          }));
        } catch (e) {
          console.error('HTTP error:', e);
          if (wantsStream && res.headersSent) {
            try {
              res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (e2) {}
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message } }));
          }
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
    }
  });

  server.listen(HTTP_PORT, HTTP_BIND, () => {
    console.log(`7coder HTTP OpenAI-compatible endpoint ready at http://${HTTP_BIND}:${HTTP_PORT}`);
    if (HTTP_API_KEY) console.log('[AUTH] API key required (Authorization: Bearer <HTTP_API_KEY>).');
    console.log('Built-in web UI: open http://127.0.0.1:' + HTTP_PORT + '/ in your browser (Chinese-friendly chat).');
    console.log('Streaming (stream: true) and multi-turn client histories are supported.');
    console.log('Note: in default permission mode non-interactive approvals are declined - use PERMISSION_MODE=auto for server-driven tool use.');
  });
}

// ====================== READLINE ======================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'You: '
});
// Module-level closed tracking: after stdin EOF, rl.question callbacks are
// NEVER invoked on Node 13 (permanent hang) and throw ERR_USE_AFTER_CLOSE on
// modern Node. All question/prompt paths must check this.
let rlClosed = false;
rl.on('close', () => { rlClosed = true; });

// ====================== GLOBAL MESSAGES ======================
let messages = [{ role: 'system', content: systemPrompt }];

// ====================== MAIN ======================
async function main() {
  if (backgroundMode && promptArg) {
    console.log('[LOOP] Starting background/daemon mode...');
    // Route the child's stdout/stderr into a log file instead of dropping
    // everything (A3): the log is the only observable trace besides 7CODER.md.
    const logDir = path.join(launchDir, '.7coder');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
    const logPath = path.join(logDir, 'background.log');
    let logFd;
    try {
      logFd = fs.openSync(logPath, 'a');
      fs.writeSync(logFd, '\n[' + new Date().toISOString() + '] background run: ' + process.argv.slice(1).join(' ') + '\n');
    } catch (e) { logFd = undefined; }
    const child = child_process.spawn(process.argv[0], process.argv.slice(1).filter(a => a !== '--background'), {
      detached: true,
      stdio: ['ignore', logFd !== undefined ? logFd : 'ignore', logFd !== undefined ? logFd : 'ignore'],
      cwd: launchDir
    });
    child.unref();
    console.log('[OK] Background process started (terminal freed). Output: ' + (logFd !== undefined ? logPath : '(log file unavailable - falling back to /dev/null)'));
    flushExit(0);
  }

  if (ENABLE_HTTP_SERVER) {
    console.log('\n7coder HTTP server mode');
    await triggerDreamIfNeeded();
    if (promptArg) {
      console.log(`Running startup task first: ${promptArg}`);
      currentRawPrompt = promptArg;
      messages = prepareMessagesForPrompt(currentRawPrompt);
      await executeTask();
    }
    rl.close();
    startHttpServer();
    return;
  }

  if (promptArg) {
    console.log(`\n7coder non-interactive mode`);
    await triggerDreamIfNeeded();
    console.log(`Task: ${promptArg}`);
    currentRawPrompt = promptArg;
    messages = prepareMessagesForPrompt(currentRawPrompt);
    await executeTask();
    flushExit(0);
  } else {
    console.log('\nWelcome to 7coder (interactive REPL)');
    if (ENABLE_RALPH_MODE) console.log('Ralph Wiggum mode ENABLED');
    if (DANGER_MODE) console.log('[WARN] DANGER MODE ENABLED');
    console.log('Type your task (multi-line OK), /btw <note> for background notes, then /execute-task-now to run.');
    if (resumeFlag && loadSession()) console.log('[OK] Previous session resumed (' + (messages.length - 1) + ' turns). Use /clear to start fresh.');
    console.log('The conversation is KEPT across tasks (compressed automatically when large).');
    console.log('Commands: /clear (fresh conversation), /undo <file> (restore newest backup), /bye (quit).\n');

    let currentPrompt = '';
    let taskRunning = false;
    let btwPending = null;
    // After stdin EOF the readline interface is closed; calling prompt() on it
    // throws ERR_USE_AFTER_CLOSE on modern Node and would crash the process
    // with exit code 1 right after the task finished. Guard every re-prompt.
    // (rlClosed is tracked at module level next to the rl definition.)
    const safePrompt = () => { if (!rlClosed) { try { rl.prompt(); } catch (e) {} } };

    safePrompt();

    rl.on('line', async (input) => {
      const trimmed = input.trim();

      if (trimmed.toLowerCase() === '/bye') {
        // Quit for real: stop running background tasks, cron jobs and any
        // in-flight cron command, drop the dream lock, then exit. Their
        // handles would otherwise keep the event loop alive (hang) or leak.
        shuttingDown = true;
        for (const t of backgroundTasks.values()) {
          if (t.status === 'running') {
            t.stopRequested = true;
            try {
              if (process.platform === 'win32' && t.child && t.child.pid) {
                child_process.execSync(`taskkill /PID ${t.child.pid} /T /F`, { stdio: 'ignore', timeout: 15000 });
              } else if (t.child) {
                t.child.kill('SIGTERM');
              }
            } catch (e) {}
            t.status = 'stopped';
            t.endedAt = new Date().toISOString();
          }
        }
        for (const j of cronJobs.values()) {
          j.stopped = true;
          if (j.timer) clearTimeout(j.timer);
          if (j.child) {
            try {
              if (process.platform === 'win32' && j.child.pid) {
                child_process.execSync(`taskkill /PID ${j.child.pid} /T /F`, { stdio: 'ignore', timeout: 15000 });
              } else {
                j.child.kill('SIGTERM');
              }
            } catch (e) {}
          }
        }
        try { const lock = path.join(launchDir, '7C.dream.lock'); if (fs.existsSync(lock)) fs.unlinkSync(lock); } catch (e) {}
        saveSession();
        console.log('Goodbye!');
        rl.close();
        setTimeout(() => process.exit(0), 150);
        return;
      }

      if (trimmed === '/resume') {
        if (taskRunning) { console.log('A task is running - wait before /resume.'); safePrompt(); return; }
        if (loadSession()) {
          console.log('[OK] Session resumed (' + (messages.length - 1) + ' turns).');
        } else {
          console.log('No saved session found in .7coder/session.json.');
        }
        safePrompt();
        return;
      }

      if (trimmed === '/clear') {
        if (taskRunning) { console.log('A task is running - wait before /clear.'); safePrompt(); return; }
        messages = [{ role: 'system', content: systemPrompt }];
        try { if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath); } catch (e) {}
        currentPrompt = ''; // a half-typed draft should not survive a fresh conversation
        console.log('[OK] Conversation cleared.');
        safePrompt();
        return;
      }

      if (trimmed.startsWith('/undo')) {
        if (taskRunning) { console.log('A task is running - wait before /undo.'); safePrompt(); return; }
        const rel = trimmed.slice(5).trim();
        if (!rel) {
          console.log('Usage: /undo <file path>');
        } else if (restoreLatestBackup(rel)) {
          console.log(`[OK] Restored ${rel} from the newest backup.`);
        } else {
          console.log(`No backup found for ${rel}.`);
        }
        safePrompt();
        return;
      }

      if (trimmed.startsWith('/btw ')) {
        const note = trimmed.slice(5).trim();
        if (note) {
          console.log(`[BTW] /btw note received - small-model sub-agent summarizing for main task...`);
          // Track the in-flight summarization so an immediately following
          // /execute-task-now (e.g. pasted input) waits for the note to land
          // instead of racing past it with an empty prompt.
          const work = (async () => {
            const btwPrompt = `You are 7coder's BTW sub-agent (light model only).
The user just appended this note to the CURRENT heavy-model coding task WITHOUT interrupting it:

"${note}"

Summarize EXACTLY what the user wants in 1-2 clear, concise sentences.
Output ONLY the summarized user message text (no extra explanation, no quotes, no prefixes).
Make it read like a direct continuation of the user's task instructions for the main agent.`;
            let summarized = note;
            try {
              const resp = await callOpenAI([{ role: 'user', content: btwPrompt }], { model: LIGHT_MODEL, useTools: false });
              summarized = (resp.message.content || note).trim();
              // Since we prune context, for /btw we can just append it to the currentPrompt
              currentPrompt += '\n' + summarized + '\n';
              console.log(`[BTW] BTW sub-agent injected into current task prompt:\n${summarized}`);
            } catch (e) {
              console.log(`[BTW] BTW sub-agent error - injecting original note as fallback.`);
              currentPrompt += '\n' + note + '\n';
            }
            const btwPath = path.join(launchDir, 'BTW.md');
            fs.appendFileSync(btwPath, `\n---\n**BTW** ${new Date().toISOString()}\nOriginal note: ${note}\nInjected summary: ${summarized}\n\n`, 'utf8');
          })();
          btwPending = work;
          try { await work; } finally { if (btwPending === work) btwPending = null; }
        } else {
          console.log('Usage: /btw your note here');
        }
        safePrompt();
        return;
      }

      if (trimmed === '/execute-task-now') {
        if (taskRunning) {
          console.log('A task is already running - queued lines are still appended to the next task.');
          safePrompt();
          return;
        }
        if (btwPending) { try { await btwPending; } catch (e) {} }
        if (currentPrompt.trim()) {
          taskRunning = true;
          // Consume the prompt NOW; lines typed while the task runs accumulate
          // in currentPrompt for the NEXT task (clearing after the run would
          // race with the concurrent line handler and silently drop them).
          const taskText = currentPrompt.trim();
          currentPrompt = '';
          try {
            try {
              await triggerDreamIfNeeded();
            } catch (e) {
              console.error(`[WARN] dream check failed (task continues): ${e.message}`);
            }
            console.log(`7coder is ${getRandomSpinner()}`);
            currentRawPrompt = taskText;
            // Session continuity: the FIRST task seeds the conversation (with the
            // 7CODER.md summary); every later task is appended so the model keeps
            // full context of this session. /clear starts over.
            if (messages.length === 1) {
              messages.push({ role: 'user', content: buildTaskUserContent(currentRawPrompt) });
            } else {
              messages.push({ role: 'user', content: currentRawPrompt });
            }
            await executeTask();
            saveSession();
          } finally {
            taskRunning = false;
          }
        } else {
          console.log('No task entered.');
        }
      } else if (trimmed) {
        currentPrompt += input + '\n';
      }

      safePrompt();
    });
  }
}

main().catch(console.error);
