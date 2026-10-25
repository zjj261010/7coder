#!/usr/bin/env node
const axios = require('axios');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');
const http = require('http');
const { pipeline, Transform } = require('stream');
const crypto = require('crypto');
const net = require('net');
const vm = require('vm');

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

REPL commands: /clear, /undo <file>, /btw <note>, /fork <N>, /execute-task-now, /bye
`);
  process.exit(0);
}

// Exit without truncating buffered stdout/stderr: on Windows, file/pipe stdout
// writes are async and process.exit() discards them (this bit the background
// log and streamed replies in one-shot mode).
function flushExit(code) {
  const pending = () => (process.stdout.writableLength || 0) + (process.stderr.writableLength || 0);
  const deadline = Date.now() + 2000; // never hang if a stream never drains
  // An explicit nonzero code wins; otherwise a process.exitCode set by a failed
  // task must survive the flush (success paths pass 0 and stay 0).
  const exitWith = code || process.exitCode || 0;
  const tryExit = () => { if (pending() === 0 || Date.now() > deadline) process.exit(exitWith); else setTimeout(tryExit, 50); };
  tryExit();
}

// ====================== SETUP ======================
const launchDir = process.cwd();
const appDir = require.main ? path.dirname(require.main.filename) : __dirname;
let workspaceLease = null;
// Only the launcher can supply this before .env is loaded. It authorizes a
// bounded wait for that exact parent's handoff, never bypasses OS exclusion.
const leaseHandoffText = process.env._7CODER_LEASE_HANDOFF || '';
delete process.env._7CODER_LEASE_HANDOFF;
let leaseHandoff = null;
try {
  const j = JSON.parse(leaseHandoffText);
  if (process.send && j && /^[a-f0-9]{48}$/.test(j.token) && Number.isInteger(j.pid)) leaseHandoff = j;
} catch (e) {}

function workspaceLeaseAddress(directory) {
  const real = fs.realpathSync(directory);
  const canonical = process.platform === 'win32' ? path.normalize(real).toLowerCase() : real;
  const key = crypto.createHash('sha256').update(canonical).digest('hex');
  // Windows libuv uses FIRST_PIPE_INSTANCE for the first bind; no persistent
  // lock/PID file can be stranded by taskkill or machine shutdown.
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\7coder-workspace-' + key :
    { host: '127.0.0.1', port: 20000 + parseInt(key.slice(0, 8), 16) % 40000, exclusive: true };
  return { canonical, key, endpoint };
}
function probeWorkspaceLease(address) {
  return new Promise(resolve => {
    const challenge = crypto.randomBytes(16).toString('hex');
    let socket, bytes = Buffer.alloc(0), settled = false;
    const finish = owner => { if (settled) return; settled = true; if (socket) socket.destroy(); resolve(owner); };
    try { socket = net.createConnection(address.endpoint); } catch (e) { finish(null); return; }
    socket.setTimeout(1000, () => finish(null));
    socket.on('error', () => finish(null)); socket.on('close', () => finish(null));
    socket.on('connect', () => socket.write(JSON.stringify({ kind: '7coder-lease-probe', key: address.key, challenge }) + '\n'));
    socket.on('data', chunk => {
      if (bytes.length + chunk.length > 4096) { finish(null); return; }
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) return;
      try {
        const j = JSON.parse(bytes.toString('utf8').split('\n')[0]);
        finish(j && j.kind === '7coder-workspace-lease' && j.key === address.key && j.challenge === challenge &&
          Number.isInteger(j.pid) && /^[a-f0-9]{48}$/.test(j.token) && typeof j.startedAt === 'string' ? j : null);
      } catch (e) { finish(null); }
    });
  });
}
async function acquireWorkspaceLease(directory, handoff) {
  const address = workspaceLeaseAddress(directory);
  const deadline = Date.now() + 6000;
  while (true) {
    const sockets = new Set();
    const identity = { kind: '7coder-workspace-lease', key: address.key, pid: process.pid,
      token: crypto.randomBytes(24).toString('hex'), startedAt: new Date().toISOString() };
    let acquired = false, released = false;
    const server = net.createServer(socket => {
      sockets.add(socket); socket.unref();
      let bytes = Buffer.alloc(0), answered = false;
      socket.setTimeout(1000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', chunk => {
        if (answered) return;
        if (bytes.length + chunk.length > 4096) { socket.destroy(); return; }
        bytes = Buffer.concat([bytes, chunk]);
        if (!bytes.includes(10)) return;
        answered = true;
        try {
          const j = JSON.parse(bytes.toString('utf8').split('\n')[0]);
          if (j.kind !== '7coder-lease-probe' || j.key !== address.key || !/^[a-f0-9]{32}$/.test(j.challenge)) { socket.destroy(); return; }
          socket.end(JSON.stringify(Object.assign({ challenge: j.challenge }, identity)) + '\n');
        } catch (e) { socket.destroy(); }
      });
    });
    server.maxConnections = 8;
    const failure = await new Promise(resolve => {
      server.on('error', e => {
        if (!acquired) resolve(e);
        else if (!released) { console.error('[ERROR] workspace lease failed: ' + e.message); flushExit(1); }
      });
      try {
        server.listen(address.endpoint, () => { acquired = true; resolve(null); });
      } catch (e) { resolve(e); }
    });
    if (!failure) {
      server.unref();
      return { address, identity, releaseForHandoff: () => new Promise((resolve, reject) => {
        if (released) { reject(new Error('Workspace lease was already handed off')); return; }
        released = true;
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }) };
    }
    // A failed bind owns no lease. It cannot unlink/kill anything associated
    // with the endpoint, even when the current owner cannot answer a probe.
    try { server.close(); } catch (e) {}
    if (!['EADDRINUSE', 'EACCES'].includes(failure.code)) throw failure;
    const owner = await probeWorkspaceLease(address);
    if (handoff && (!owner || (owner.token === handoff.token && owner.pid === handoff.pid)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const detail = owner ? 'Agent PID ' + owner.pid + ', run ' + owner.token.slice(0, 12) + ', since ' + owner.startedAt :
      'owner could not be verified (' + failure.code + ')';
    throw new Error((owner ? 'Workspace is already in use: ' : 'Workspace ownership unavailable: ') + address.canonical + '; ' + detail +
      '. Close that instance before starting another. No lock was removed and no process was killed.');
  }
}

// Config reads may restore files, so OS ownership must precede ALL workspace
// setup/recovery, not just main() or HTTP listen. --help stays outside the gate.
async function initializeAgent() {
workspaceLease = await acquireWorkspaceLease(launchDir, leaseHandoff);
try {
  loadEnvState(path.join(appDir, '.env'), false);
  // Per-project overrides (D7): a .env in the workspace wins over the
  // install-dir .env, so each project can pin its own models/endpoint/key.
  // The workspace .env is on the protected-files list - the AI cannot edit it.
  loadEnvState(path.join(launchDir, '.env'), true);
} catch (e) {
  console.error('[ERROR] configuration load failed: ' + e.message);
  process.exit(1);
}

let OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1';
const ENABLE_RALPH_MODE = process.env.ENABLE_RALPH_MODE === 'true' || process.env.ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE === 'true';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || process.env.MAX_ATTEMPT_RETRIES, 10) || 3;
// Ralph loop iterations are independent of API retries (A9); falls back to
// MAX_RETRIES for backward compatibility with existing .env files.
const RALPH_ITERATIONS = Math.max(1, parseInt(process.env.RALPH_ITERATIONS, 10) || MAX_RETRIES);
let HEAVY_MODEL = process.env.HEAVY_MODEL || 'gpt-4o-mini';
// OP5-4: no hardcoded light-model default any more (the old one named a
// discontinued model) - when LIGHT_MODEL is unset, light traffic rides on
// the selected execution model (HEAVY_MODEL when no per-request selection).
const LIGHT_MODEL = (process.env.LIGHT_MODEL || '').trim() || null;
const VISION_MODEL = process.env.VISION_MODEL || null;
// parseFloat('0')||fallback would silently rewrite a legitimate TEMPERATURE=0;
// only fall back when the value is missing or not a finite number.
const TEMPERATURE = Number.isFinite(parseFloat(process.env.TEMPERATURE)) ? parseFloat(process.env.TEMPERATURE) : 0.6;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 42000;
// AST-R1: the task-summary call is a background convenience, not the main
// event - it gets its own cheap model and a small token budget (fallbacks:
// the light model / 512 tokens).
const SUMMARY_MODEL = (process.env.SUMMARY_MODEL || '').trim() || null;
const SUMMARY_MAX_TOKENS = parseInt(process.env.SUMMARY_MAX_TOKENS, 10) || 512;
const VALID_PERMISSION_MODES = ['default', 'auto', 'bypass', 'denial'];
const rawPermissionMode = (permissionModeFlag || process.env.PERMISSION_MODE || (dangerMode ? 'bypass' : 'default')).toLowerCase().trim();
if (!VALID_PERMISSION_MODES.includes(rawPermissionMode)) {
  console.warn(`[WARN] Unknown PERMISSION_MODE "${rawPermissionMode}" - falling back to "default".`);
  console.warn('   (Note: .env values must not contain inline # comments - dotenv 8 keeps them as part of the value.)');
}
let PERMISSION_MODE = VALID_PERMISSION_MODES.includes(rawPermissionMode) ? rawPermissionMode : 'default';
const ENABLE_HTTP_SERVER = process.env.ENABLE_HTTP_SERVER === 'true' || serverMode;
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 7103;
const HTTP_BIND = process.env.HTTP_BIND || '127.0.0.1';
const HTTP_API_KEY = process.env.HTTP_API_KEY || null;
// Zero deliberately requests a final answer without entering a tool round.
// Reject partial/negative/non-integer values instead of silently using them.
const rawMaxToolSteps = (process.env.MAX_TOOL_STEPS || '').trim();
const parsedMaxToolSteps = Number(rawMaxToolSteps);
const validMaxToolSteps = /^\d+$/.test(rawMaxToolSteps) && Number.isSafeInteger(parsedMaxToolSteps);
const MAX_TOOL_STEPS = validMaxToolSteps ? parsedMaxToolSteps : 30;
if (rawMaxToolSteps && !validMaxToolSteps) {
  console.warn('[WARN] Invalid MAX_TOOL_STEPS; expected a non-negative safe integer. Using 30.');
}
// Guard against nonsense values: a negative cap would reduce every tool result
// to just the truncation marker.
const MAX_TOOL_RESULT_CHARS = Math.max(1000, parseInt(process.env.MAX_TOOL_RESULT_CHARS, 10) || 30000);
const MODEL_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const CONTEXT_CHARS = Math.max(500, parseInt(process.env.CONTEXT_CHARS, 10) || 120000);
const EXECUTION_TIMEOUT_MS = Math.max(1000, Math.min(86400000, parseInt(process.env.EXECUTION_TIMEOUT_MS, 10) || 1800000));
const ENABLE_COMPUTER_USE = process.env.ENABLE_COMPUTER_USE === 'true';
const DREAM_ALLOW = process.env.DREAM_ALLOW === 'true';
const MCP_SERVER_URLS = (process.env.MCP_SERVER_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const MCP_NPX_PKGS = (process.env.MCP_NPX_PKGS || '').split(',').map(s => s.trim()).filter(Boolean);
const ENABLE_AUTO_DEBUG = process.env.ENABLE_AUTO_DEBUG === 'true';
const DEBUG_TEST_MINUTES = parseInt(process.env.DEBUG_TEST_MINUTES, 10) || 3;
const BICKER_ROUNDS = parseInt(process.env.BICKER_ROUNDS, 10) || 5;
// GAP-10: web_search_tool provider. ''/'ddg' keeps the DuckDuckGo lite scrape;
// 'searxng' needs SEARCH_ENDPOINT; 'brave'/'bing' need SEARCH_API_KEY.
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || '').toLowerCase().trim();
const SEARCH_API_KEY = process.env.SEARCH_API_KEY || '';
const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT || '';
const APP_VERSION = require('./package.json').version;

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
  const next = {};
  const files = [path.join(appDir, 'models.json')];
  files.push(internalStatePath('.7coder', 'models.json'));
  for (const f of files) {
    const record = readStateRecord(f, parseModelState, sharedInstallState(f));
    if (!record) continue;
    for (const k of Object.keys(record.value)) { if (k) next[k.toLowerCase()] = record.value[k]; }
  }
  modelProfiles = next;
}
try { loadModelProfiles(); }
catch (e) { console.error('[ERROR] model configuration load failed: ' + e.message); process.exit(1); }
function resolveModelConfig(model) {
  const prof = modelProfiles[String(model || '').toLowerCase()];
  return {
    endpoint: (prof && prof.endpoint) || OPENAI_ENDPOINT,
    apiKey: (prof && typeof prof.apiKey === 'string') ? prof.apiKey : OPENAI_API_KEY
  };
}
// Capture the selected model and routes once per execution. Settings/profile
// changes affect new executions; every auxiliary call in this one stays put.
function createModelContext(main = HEAVY_MODEL) {
  const light = LIGHT_MODEL || main;
  const summary = SUMMARY_MODEL || light;
  const routes = Object.create(null);
  for (const name of [main, light, summary, VISION_MODEL].filter(Boolean)) {
    routes[String(name).toLowerCase()] = Object.freeze(resolveModelConfig(name));
  }
  return Object.freeze({ main, light, summary, routes: Object.freeze(routes) });
}
function modelList() {
  const seen = {};
  const names = [];
  for (const n of [HEAVY_MODEL, LIGHT_MODEL || HEAVY_MODEL, SUMMARY_MODEL || LIGHT_MODEL || HEAVY_MODEL].concat(Object.keys(modelProfiles))) {
    if (!seen[n.toLowerCase()]) { seen[n.toLowerCase()] = true; names.push(n); }
  }
  return names;
}
function authHeadersFor(key) {
  const h = { 'Content-Type': 'application/json' };
  if (key) h.Authorization = 'Bearer ' + key;
  return h;
}

// ====================== MCP STDIO TRANSPORT (GAP-1) ======================
// Real Model Context Protocol support: JSON-RPC 2.0 over the server process's
// stdin/stdout, one message per line (the MCP stdio framing - NOT LSP-style
// Content-Length headers). Servers are configured like models.json, two
// layers merged (workspace wins per server):
//   mcp.json next to index.js           { "servers": { "<name>": {...} } }
//   .7coder/mcp.json in the workspace   (same shape, or a bare map)
// Server entry: { "command": "npx", "args": ["-y", "@modelcontextprotocol/
// server-filesystem", "D:\\somewhere"], "env": {}, "cwd": "" }
let mcpServers = Object.create(null);
function loadMcpServers() {
  const next = Object.create(null);
  const files = [path.join(appDir, 'mcp.json')];
  files.push(internalStatePath('.7coder', 'mcp.json'));
  for (const f of files) {
    const j = readOptionalJsonConfig(f, 'MCP configuration');
    if (j === undefined) continue;
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('Invalid MCP configuration object: ' + f);
    const servers = Object.prototype.hasOwnProperty.call(j, 'servers') ? j.servers : j;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid MCP servers map: ' + f);
    const names = Object.keys(servers);
    if (names.length > 32) throw new Error('MCP configuration exceeds 32 servers: ' + f);
    for (const k of names) {
      const sv = servers[k];
      if (!k.trim() || !sv || typeof sv !== 'object' || Array.isArray(sv) || typeof sv.command !== 'string' || !sv.command.trim() ||
          (sv.args !== undefined && (!Array.isArray(sv.args) || sv.args.some(a => typeof a !== 'string'))) ||
          (sv.cwd !== undefined && typeof sv.cwd !== 'string') ||
          (sv.env !== undefined && (!sv.env || typeof sv.env !== 'object' || Array.isArray(sv.env)))) throw new Error('Invalid MCP server fields: ' + f);
      next[k] = sv;
    }
    if (Object.keys(next).length > 32) throw new Error('Merged MCP configuration exceeds 32 servers: ' + f);
  }
  mcpServers = next;
}
try { loadMcpServers(); }
catch (e) { console.error('[ERROR] MCP configuration load failed: ' + e.message); process.exit(1); }
const MCP_CALL_TIMEOUT = parseInt(process.env.MCP_CALL_TIMEOUT, 10) || 120000;
const MCP_MAX_FRAME_BYTES = 4 * 1024 * 1024;

// One lazily-created client per configured server, kept alive for the
// process lifetime and disposed at shutdown.
const mcpClients = Object.create(null);
function mcpContentToText(result) {
  const parts = [];
  for (const c of ((result && result.content) || [])) {
    if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else parts.push(JSON.stringify(c));
  }
  return parts.join('\n');
}
// A2-19: Windows CreateProcess does no PATHEXT resolution, so spawning a bare
// 'npx' fails with ENOENT even when npx.cmd is sitting on PATH (only *.exe
// files are found). resolveCommandOnWindows() answers "is this bare command
// name present on PATH as a .cmd/.bat/.exe?" (same PATH-scan shape findBash
// uses). When true, createMcpStdioClient spawns through cmd.exe (shell:true)
// with the ORIGINAL command - cmd.exe does its own PATH+PATHEXT lookup and
// that is the only reliable way to start .cmd shims like npx. The quoting
// hazards of shell:true are accepted by design: .7coder/mcp.json is
// user-authored config, the same trust boundary as the run_command tool.
// Non-Windows platforms and explicit paths are untouched (returns false).
function resolveCommandOnWindows(command) {
  if (process.platform !== 'win32') return false;
  const cmd = String(command || '').trim();
  if (!cmd || /[\\\/]/.test(cmd)) return false; // explicit path: CreateProcess handles it as-is
  const bare = cmd.toLowerCase();
  if (bare === 'node' || bare + '.exe' === path.basename(process.execPath).toLowerCase()) return false;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['.cmd', '.bat', '.exe']) {
      try { if (fs.existsSync(path.join(dir, cmd + ext))) return true; } catch (e) {}
    }
  }
  return false;
}
function createMcpStdioClient(name, cfg) {
  const child = child_process.spawn(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
    cwd: cfg.cwd || launchDir,
    env: Object.assign({}, process.env, cfg.env || {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: resolveCommandOnWindows(cfg.command)
  });
  const client = {
    child: child,
    name: name,
    nextId: 1,
    pending: new Map(), // id -> { resolve, reject, timer }
    queuedBytes: 0, // encoded writes whose callbacks have not completed
    toolsCache: null,
    toolsCacheBytes: 0,
    listingTools: false,
    stderrTail: '',
    stderrBytes: 0,
    stderrLogBytes: 0,
    stderrSuppressedChunks: 0,
    stderrLastLogAt: null,
    initialized: false,
    initPromise: null,
    dead: false,
    deadErr: ''
  };
  let buf = '';
  function die(err) {
    if (client.dead) return;
    client.dead = true;
    client.deadErr = String(err);
    client.initialized = false;
    client.toolsCache = null;
    client.toolsCacheBytes = 0;
    buf = '';
    client.queuedBytes = 0;
    for (const p of client.pending.values()) {
      clearTimeout(p.timer);
      p.detach();
      p.reject(new Error('MCP server "' + name + '" unavailable: ' + client.deadErr + '; result unknown for sent requests; check side effects before retrying.'));
    }
    client.pending.clear();
    if (mcpClients[name] === client) delete mcpClients[name];
    // Best effort for this direct child. Descendant ownership is T22-07;
    // killing this handle is not proof that a remote side effect stopped.
    try { child.stdin.destroy(); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
  function send(message) {
    if (client.dead) throw new Error('MCP server "' + name + '" is not running (' + client.deadErr + ')');
    const line = JSON.stringify(message) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MCP_MAX_FRAME_BYTES) throw new Error('MCP outgoing frame exceeds 4 MB; request not sent');
    if (client.queuedBytes + bytes > MCP_MAX_FRAME_BYTES) throw new Error('MCP outgoing queue exceeds 4 MB; request not sent');
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      die('stdin is closed');
      throw new Error(client.deadErr);
    }
    client.queuedBytes += bytes;
    let released = false;
    const release = () => { if (!released) { released = true; client.queuedBytes = Math.max(0, client.queuedBytes - bytes); } };
    try { child.stdin.write(line, error => { release(); if (error) die('stdin write: ' + error.message); }); }
    catch (e) { release(); die('stdin write: ' + e.message); throw e; }
  }
  client.dispose = function () { die('disposed'); };
  function tailUtf8(text, limit) {
    let end = String(text).slice(-limit);
    if (end.length && end.charCodeAt(0) >= 0xDC00 && end.charCodeAt(0) <= 0xDFFF) end = end.slice(1);
    const bytes = Buffer.from(end, 'utf8');
    let offset = Math.max(0, bytes.length - limit);
    while (offset < bytes.length && (bytes[offset] & 0xC0) === 0x80) offset++;
    return bytes.slice(offset).toString('utf8');
  }
  function logDiagnostic(text, force = false) {
    const now = Date.now();
    if (!force && client.stderrLastLogAt !== null && now >= client.stderrLastLogAt && now - client.stderrLastLogAt < 1000) return false;
    const prefix = '[MCP:' + String(name).slice(0, 80) + '] ';
    const suffix = ' [stderr received=' + client.stderrBytes + ', unforwarded chunks=' + client.stderrSuppressedChunks + ']';
    const fixed = Buffer.byteLength(prefix + suffix, 'utf8') + 1;
    const available = Math.min(4096, 64 * 1024 - client.stderrLogBytes) - fixed;
    if (available <= 0) return false;
    const line = prefix + tailUtf8(text, available) + suffix;
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    // Never add MCP diagnostics to an already backed-up parent stderr queue.
    if (process.stderr && (process.stderr.writableLength || 0) + bytes > 1024 * 1024) return false;
    try { console.warn(line); }
    catch (e) { return false; }
    client.stderrLogBytes += bytes;
    client.stderrLastLogAt = now;
    return true;
  }
  // Node 13 returns early on EMFILE/ENFILE before constructing stdio, then
  // emits the spawn error on nextTick. Bind before touching any pipe.
  child.on('error', e => { logDiagnostic('spawn: ' + e.message, true); die(e.message); });
  child.on('exit', code => die('exit code ' + code));
  child.on('close', code => die('close code ' + code));
  if (!child.stdin || !child.stdout || !child.stderr) {
    die('stdio unavailable during spawn');
    const unavailable = () => Promise.reject(new Error('MCP server "' + name + '" is not running (' + client.deadErr + ')'));
    client.request = unavailable;
    client.ensureInit = unavailable;
    client.listTools = unavailable;
    client.callTool = unavailable;
    return client;
  }
  child.stdin.on('error', e => die('stdin: ' + e.message));
  child.stdout.on('error', e => die('stdout: ' + e.message));
  child.stdout.on('end', () => die('stdout ended'));
  child.stdout.on('close', () => die('stdout closed'));
  child.stderr.on('error', e => die('stderr: ' + e.message));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    if (client.dead) return;
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.substring(0, nl).replace(/\r$/, '');
      buf = buf.substring(nl + 1);
      if (Buffer.byteLength(line, 'utf8') > MCP_MAX_FRAME_BYTES) { die('incoming frame exceeds 4 MB'); return; }
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
      if (msg.id !== undefined && client.pending.has(msg.id)) {
        const p = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.detach();
        if (msg.error) p.reject(new Error(typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (typeof msg.method === 'string' && msg.id !== undefined) {
        // server -> client request (roots/list etc). Answer what we can,
        // method-not-found for the rest; never leave the server hanging.
        const known = { 'roots/list': { roots: [] }, 'ping': {} };
        const out = Object.prototype.hasOwnProperty.call(known, msg.method)
          ? { jsonrpc: '2.0', id: msg.id, result: known[msg.method] }
          : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
        try { send(out); } catch (e2) { die(e2.message); }
      }
      // server notifications (logging etc): ignored
    }
    if (Buffer.byteLength(buf, 'utf8') > MCP_MAX_FRAME_BYTES) die('unterminated incoming frame exceeds 4 MB');
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => {
    if (client.dead) return; // keep draining, but retain no late output
    const text = String(d);
    client.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, client.stderrBytes + Buffer.byteLength(text, 'utf8'));
    client.stderrTail = tailUtf8(client.stderrTail + tailUtf8(text, 4096), 4096);
    if (!logDiagnostic(client.stderrTail)) client.stderrSuppressedChunks = Math.min(Number.MAX_SAFE_INTEGER, client.stderrSuppressedChunks + 1);
  });
  client.request = function (method, params, timeoutMs, cancelled) {
    return new Promise((resolve, reject) => {
      if (cancelled && cancelled()) return reject(executionCancelledError(cancelled));
      if (client.dead) return reject(new Error('MCP server "' + name + '" is not running (' + client.deadErr + ')'));
      if (client.pending.size >= 32) return reject(new Error('MCP pending request limit (32) reached; request not sent'));
      const id = client.nextId++;
      const timer = setTimeout(() => {
        die('MCP ' + method + ' timed out after ' + timeoutMs + 'ms; session retired, next call starts a new client');
      }, timeoutMs);
      const entry = { resolve, reject, timer, detach: () => {} };
      client.pending.set(id, entry);
      if (cancelled) entry.detach = watchExecution(cancelled, () => die('execution cancelled; session retired'));
      if (client.dead) return;
      try {
        checkExecution(cancelled);
        send({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
      } catch (e) {
        clearTimeout(timer);
        entry.detach();
        client.pending.delete(id);
        reject(e);
      }
    });
  };
  client.ensureInit = function (cancelled) {
    if (cancelled && cancelled()) return Promise.reject(executionCancelledError(cancelled));
    if (client.initialized) return Promise.resolve();
    if (client.initPromise) return client.initPromise;
    client.initPromise = client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: '7coder', version: APP_VERSION }
    }, 15000, cancelled).then(() => {
      checkExecution(cancelled);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      client.initialized = true;
    }).catch(e => {
      client.initPromise = null;
      if (cancelled && cancelled()) die('initialization cancelled; session retired');
      throw e;
    });
    return client.initPromise;
  };
  client.listTools = async function (force, cancelled) {
    checkExecution(cancelled);
    if (client.toolsCache && !force) return client.toolsCache;
    if (client.listingTools) throw new Error('MCP tool discovery already running; request not sent');
    client.listingTools = true;
    if (force) { client.toolsCache = null; client.toolsCacheBytes = 0; }
    try {
      await client.ensureInit(cancelled);
      const tools = [], names = new Set(), cursors = new Set();
      let cursor, bytes = 2;
      for (let page = 0; page < 8; page++) {
        checkExecution(cancelled);
        const res = await client.request('tools/list', cursor === undefined ? {} : { cursor }, 15000, cancelled);
        checkExecution(cancelled);
        if (client.dead) throw new Error('MCP server closed during tool discovery');
        if (!res || !Array.isArray(res.tools)) throw new Error('MCP tools/list must return a tools array');
        if (tools.length + res.tools.length > 256) throw new Error('MCP tool discovery exceeds 256 tools; no complete list cached');
        const added = Buffer.byteLength(JSON.stringify(res.tools), 'utf8') - 2 + (tools.length && res.tools.length ? 1 : 0);
        if (bytes + added > 1024 * 1024) throw new Error('MCP tool discovery exceeds 1MiB cache budget; no complete list cached');
        for (const tool of res.tools) {
          if (!tool || typeof tool !== 'object' || Array.isArray(tool) || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 256 || names.has(tool.name)) throw new Error('MCP tools/list has invalid or duplicate tool names');
          names.add(tool.name); tools.push(tool);
        }
        bytes += added;
        if (res.nextCursor === undefined || res.nextCursor === null || res.nextCursor === '') {
          client.toolsCache = tools; client.toolsCacheBytes = bytes;
          return client.toolsCache;
        }
        if (typeof res.nextCursor !== 'string' || res.nextCursor.length > 1024 || cursors.has(res.nextCursor)) throw new Error('MCP tool discovery has invalid or repeated cursor');
        cursors.add(res.nextCursor); cursor = res.nextCursor;
      }
      throw new Error('MCP tool discovery exceeds 8 pages; no complete list cached');
    } finally { client.listingTools = false; }
  };
  client.callTool = async function (toolName, toolArgs, cancelled) {
    await client.ensureInit(cancelled);
    checkExecution(cancelled);
    const res = await client.request('tools/call', { name: toolName, arguments: toolArgs || {} }, MCP_CALL_TIMEOUT, cancelled);
    checkExecution(cancelled);
    const text = mcpContentToText(res);
    if (res && res.isError) throw new Error(text || 'tool reported isError with no content');
    return text;
  };
  return client;
}
function getMcpClient(serverName, cancelled) {
  checkExecution(cancelled);
  if (!mcpServers[serverName]) return null;
  if (!mcpClients[serverName] || mcpClients[serverName].dead) {
    console.log('[MCP] starting stdio server "' + String(serverName).slice(0, 80) + '": ' + String(mcpServers[serverName].command).slice(0, 200));
    const previous = mcpClients[serverName];
    const next = createMcpStdioClient(serverName, mcpServers[serverName]);
    if (!next.dead) mcpClients[serverName] = next;
    else if (mcpClients[serverName] === previous) delete mcpClients[serverName];
    return next;
  }
  return mcpClients[serverName];
}
function disposeMcpClients() {
  for (const k of Object.keys(mcpClients)) {
    mcpClients[k].dispose();
  }
}
function mcpDiagnosticsSnapshot() {
  return Object.keys(mcpClients).slice(0, 32).map(name => {
    const c = mcpClients[name];
    return { name: String(name).slice(0, 80), pid: c.child && c.child.pid || null,
      initialized: !!c.initialized, pending: c.pending.size, queuedBytes: c.queuedBytes,
      tools: c.toolsCache ? c.toolsCache.length : null, toolsCacheBytes: c.toolsCacheBytes, discovering: !!c.listingTools,
      stderr: { receivedBytes: c.stderrBytes, tailBytes: Buffer.byteLength(c.stderrTail, 'utf8'),
        loggedBytes: c.stderrLogBytes, logBudgetRemaining: Math.max(0, 64 * 1024 - c.stderrLogBytes), suppressedChunks: c.stderrSuppressedChunks } };
  });
}

// Redact secrets from the audit log's args preview: a run_command like
// `curl -H "Authorization: Bearer sk-..."` would otherwise land verbatim in
// .7coder/audit.jsonl. Keys that look secret-bearing are fully masked; all
// other values get Bearer/sk- token patterns scrubbed.
function sanitizeAuditArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const k of Object.keys(args)) {
    if (/key|token|secret|password|authorization|apikey/i.test(k)) out[k] = '***';
    else out[k] = String(args[k]).replace(/Bearer\s+[A-Za-z0-9._~+\/=\-]+/gi, 'Bearer ***').replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***');
  }
  return out;
}

// A2-18: the same scrubbing for the audit log's result preview. Tool OUTPUT
// is data the tool happened to read - a compact models.json or any file with
// a token would otherwise land its first line verbatim in audit.jsonl
// (AST-04 fixed the args side only, the copy-on-read surface stayed open).
function sanitizeAuditLine(text) {
  return String(text)
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***');
}

function audit(entry) {
  if (!AUDIT_ENABLED) return false;
  const stats = audit.stats || (audit.stats = { written: 0, dropped: 0, compacted: 0, currentBytes: null, lastSuccess: null, lastError: null });
  let fd;
  try {
    const safeAuditPath = internalStatePath('.7coder', 'audit.jsonl');
    if (!auditDirReady) { fs.mkdirSync(path.dirname(safeAuditPath), { recursive: true }); auditDirReady = true; }
    if (entry.args) entry.args = sanitizeAuditArgs(entry.args);
    let json;
    try { json = serializeModelRequest(entry, null, 16 * 1024 - 1); }
    catch (e) {
      if (e.code !== 'MODEL_REQUEST_REJECTED') throw e;
      const compact = { ts: new Date().toISOString(), metadataOmitted: 'audit record exceeded byte/structure budget or was not plain JSON' };
      for (const key of ['type', 'tool', 'callId', 'status', 'model', 'mode']) if (entry[key] != null) compact[key] = runtimeText(entry[key], 100);
      for (const key of ['prompt', 'completion', 'total', 'durationMs']) if (Number.isFinite(entry[key])) compact[key] = entry[key];
      json = JSON.stringify(compact); stats.compacted = Math.min(Number.MAX_SAFE_INTEGER, stats.compacted + 1);
    }
    const bytes = Buffer.from(json + '\n', 'utf8'), limit = 5 * 1024 * 1024;
    const regular = file => {
      try { const st = fs.lstatSync(file); if (!st.isFile() || st.nlink > 1) throw new Error('Audit log must be an unaliased regular file: ' + file); return st; }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    };
    const before = regular(safeAuditPath);
    stats.currentBytes = before ? before.size : 0;
    if (before && before.size > limit) throw new Error('Existing audit log exceeds 5 MiB; move or repair it before retrying');
    if (before && before.size + bytes.length > limit) {
      const old = internalStatePath('.7coder', 'audit.old.jsonl'); regular(old);
      fs.renameSync(safeAuditPath, old); // failed rotation must never authorize append
    }
    fd = fs.openSync(safeAuditPath, 'a+');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1 || stat.size + bytes.length > limit) throw new Error('Audit append refused: file changed or exceeds 5 MiB');
    stats.currentBytes = stat.size;
    if (stat.size) {
      const last = Buffer.alloc(1);
      if (fs.readSync(fd, last, 0, 1, stat.size - 1) !== 1 || last[0] !== 10) throw new Error('Audit tail is incomplete; repair or move the log before retrying');
    }
    let written = 0;
    while (written < bytes.length) { const n = fs.writeSync(fd, bytes, written, bytes.length - written, null); if (!n) throw new Error('Audit write made no progress'); written += n; }
    fs.closeSync(fd); fd = undefined;
    stats.currentBytes += bytes.length; stats.written = Math.min(Number.MAX_SAFE_INTEGER, stats.written + 1);
    stats.lastSuccess = new Date().toISOString(); stats.lastError = null;
    return true;
  } catch (e) {
    stats.dropped = Math.min(Number.MAX_SAFE_INTEGER, stats.dropped + 1);
    stats.lastError = { ts: new Date().toISOString(), code: runtimeText(e.code, 40), message: runtimeText(e.message) };
    const now = Date.now();
    if (audit.warnAt === undefined || now < audit.warnAt || now - audit.warnAt >= 60000) { audit.warnAt = now; console.warn('[AUDIT] Log unavailable: ' + stats.lastError.code + ' ' + stats.lastError.message); }
    return false;
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
}
function auditSnapshot() {
  const out = Object.assign({ enabled: AUDIT_ENABLED, fileLimit: 5 * 1024 * 1024, recordLimit: 16 * 1024 }, audit.stats ||
    { written: 0, dropped: 0, compacted: 0, currentBytes: null, lastSuccess: null, lastError: null });
  if (out.lastError) out.lastError = Object.assign({}, out.lastError);
  return out;
}

// Bounded operating diagnostics: no request payload, model config or history.
// Error messages may contain input fragments, so scrub and limit each field.
const RUNTIME_LOG_LIMIT = 1024 * 1024;
const runtimeDiagnostics = { since: new Date().toISOString(), activeTasks: 0, activeTools: 0,
  completed: 0, failed: 0, lastSuccess: null, lastError: null, lastEvent: null, loggingError: null };
let runtimeLogWarnAt = null;
function runtimeText(value, limit = 500) {
  return String(value == null ? '' : value).slice(0, 8192)
    .replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1***').slice(0, limit);
}
function recordRuntimeEvent(scope, status, details = {}) {
  // Logging is best effort and must never change an operation's outcome.
  try {
    const event = { ts: new Date().toISOString(), scope: runtimeText(scope, 80), status: runtimeText(status, 40) };
    for (const key of ['message', 'code', 'syscall', 'path', 'signal', 'id']) {
      if (details[key] != null) event[key] = runtimeText(details[key], key === 'path' ? 1000 : 500);
    }
    for (const key of ['pid', 'exitCode']) if (Number.isFinite(details[key])) event[key] = details[key];
    runtimeDiagnostics.lastEvent = event;
    if (status === 'ok') { runtimeDiagnostics.completed++; runtimeDiagnostics.lastSuccess = event; }
    else { runtimeDiagnostics.failed++; runtimeDiagnostics.lastError = event; }
    // Successful tool calls already have audit records; avoid a second copy.
    if (scope === 'tool' && status === 'ok') return;
    const file = internalStatePath('.7coder', 'runtime.jsonl');
    const old = internalStatePath('.7coder', 'runtime.old.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify(event) + '\n';
    let size = 0;
    try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size + Buffer.byteLength(line, 'utf8') > RUNTIME_LOG_LIMIT) {
      // If rotation fails, skip this write. Appending after failed rotation
      // would turn a diagnostic aid into an unbounded disk consumer.
      try { fs.unlinkSync(old); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.renameSync(file, old);
    }
    fs.appendFileSync(file, line, 'utf8');
    runtimeDiagnostics.loggingError = null;
  } catch (error) {
    runtimeDiagnostics.loggingError = { ts: new Date().toISOString(), code: runtimeText(error.code, 40), message: runtimeText(error.message) };
    if (runtimeLogWarnAt === null || Date.now() - runtimeLogWarnAt >= 60000) {
      runtimeLogWarnAt = Date.now();
      console.warn('[DIAGNOSTIC] Runtime log unavailable: ' + runtimeDiagnostics.loggingError.code + ' ' + runtimeDiagnostics.loggingError.message);
    }
  }
}
function beginRuntimeOperation(scope) {
  const counter = scope === 'tool' ? 'activeTools' : 'activeTasks';
  runtimeDiagnostics[counter]++;
  let finished = false;
  return (status, details) => {
    if (finished) return;
    finished = true; runtimeDiagnostics[counter]--;
    recordRuntimeEvent(scope, status, details);
  };
}
function runtimeSnapshot() {
  return JSON.parse(JSON.stringify(runtimeDiagnostics));
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
let cronSeq = 0;
const TASK_MAX_ACTIVE = 4;
const TASK_OUTPUT_LIMIT = 8 * 1024 * 1024;
const TASK_OUTPUT_TAIL = 128 * 1024;
const CRON_MAX_JOBS = 32;
// Set when the REPL is quitting - blocks new background work (A10).
let shuttingDown = false;

// Sub-agent context: while a sub-agent runs, interactive y/n approvals are
// impossible to answer meaningfully, so 'default' mode is downgraded to 'auto'
// for its tool calls. Cleared again when the sub-agent finishes.
let subAgentModeOverride = null;
let agentDepth = 0;
let autoDebugActive = false;
// >0 while workflow_tool inner steps execute: they inherit the plan approval
// (soft per-step light-model checks are skipped; hard rails stay active).
let workflowStepDepth = 0;

// AST-03: the three permission globals above are module state, so two
// concurrent HTTP chat requests could observe each other's workflow/sub-agent
// depth (e.g. request B's write "inheriting" request A's plan approval).
// HTTP requests are therefore serialized through this gate; nested chains
// inside one request (workflow steps, sub-agents) never re-acquire it. The
// REPL path is single-task by design and needs no gate.
const CHAT_MAX_REQUESTS = 8;
const CHAT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const CHAT_QUEUE_WAIT_MS = 60000;
let requestGateBusy = false;
const requestGateQueue = [];
const chatAdmission = { count: 0, bytes: 0 };
function reserveChatRequest() {
  if (chatAdmission.count >= CHAT_MAX_REQUESTS) return null;
  chatAdmission.count++;
  let bytes = 0, released = false;
  return {
    addBytes(n) {
      if (released || chatAdmission.bytes + n > CHAT_MAX_BODY_BYTES) return false;
      bytes += n; chatAdmission.bytes += n; return true;
    },
    release() {
      if (released) return;
      released = true; chatAdmission.count--; chatAdmission.bytes -= bytes;
    }
  };
}
function pumpRequestGate() {
  if (requestGateBusy || !requestGateQueue.length) return;
  const entry = requestGateQueue.shift();
  clearTimeout(entry.timer); entry.detach();
  requestGateBusy = true;
  let released = false;
  entry.resolve(() => {
    if (released) return;
    released = true; requestGateBusy = false; pumpRequestGate();
  });
}
function requestGate(cancelled) {
  return new Promise((resolve, reject) => {
    try { checkExecution(cancelled); } catch (error) { reject(error); return; }
    const entry = { resolve, reject, detach: () => {}, timer: null };
    const remove = reason => {
      const index = requestGateQueue.indexOf(entry);
      if (index < 0) return;
      requestGateQueue.splice(index, 1); clearTimeout(entry.timer); entry.detach();
      reject(executionCancelledError(cancelled || { reason }));
    };
    requestGateQueue.push(entry);
    entry.detach = watchExecution(cancelled, () => remove('Queued execution cancelled.'));
    if (requestGateQueue.includes(entry)) {
      entry.timer = setTimeout(() => {
        if (cancelled && cancelled.cancel) cancelled.cancel('Chat queue wait exceeded 60 seconds.');
        remove('Chat queue wait exceeded 60 seconds.');
      }, CHAT_QUEUE_WAIT_MS);
      pumpRequestGate();
    }
  });
}

function effectivePermissionMode() {
  if (PERMISSION_MODE === 'denial') return 'denial';
  if (DANGER_MODE) return 'bypass';
  // The override marks an active sub-agent; derive its policy from the live
  // configured mode so a later denial/default change cannot retain old auto.
  return subAgentModeOverride !== null && PERMISSION_MODE === 'default' ? 'auto' : PERMISSION_MODE;
}

// Runs a sub-agent: a FRESH conversation with full tool access. Never touches
// the caller's message array (keeps assistant(tool_calls) -> tool pairing valid).
async function runSubAgent(agentName, task, cancelled, modelContext) {
  if (agentDepth > 0) {
    return makeToolResult('error', 'Nested sub-agents are not allowed (a sub-agent cannot spawn further sub-agents).');
  }
  if (cancelled && cancelled()) return makeToolResult('cancelled', `Sub-agent "${agentName}" cancelled.`);
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
    // A2-06: inherit the parent request's cancellation token so a client
    // disconnect also stops a running sub-agent's model calls and tools.
    const answer = await processWithTools(agentMessages, { cancel: cancelled, modelContext });
    // processWithTools returns text at cancellation boundaries; its return
    // alone does not mean success. The request token is authoritative.
    if (cancelled && cancelled()) return makeToolResult('cancelled', `Sub-agent "${agentName}" cancelled.`);
    console.log(`[AGENT] Sub-agent "${agentName}" finished`);
    return makeToolResult('ok', `Sub-agent "${agentName}" result:\n${answer || '(no output)'}`);
  } catch (e) {
    if (cancelled && cancelled()) return makeToolResult('cancelled', `Sub-agent "${agentName}" cancelled.`);
    return makeToolResult('error', `Sub-agent "${agentName}" failed: ${e.message}`);
  } finally {
    try { disposePersistentShell('agent-' + agentDepth); }
    finally { agentDepth--; subAgentModeOverride = prevOverride; }
  }
}

// Keep the task table bounded: drop oldest finished tasks beyond 50 entries.
function pruneTasks() {
  if (backgroundTasks.size <= 50) return;
  for (const [id, t] of backgroundTasks) {
    if (backgroundTasks.size <= 50) break;
    if (['completed', 'failed', 'stopped'].includes(t.status) && (!t.child || observeOwnedChild(t.child).closed)) backgroundTasks.delete(id);
  }
}

function latestTask() {
  let last = null;
  for (const t of backgroundTasks.values()) last = t;
  return last;
}

const DANGER_MODE = dangerMode;
const PERMISSION_SESSION = crypto.randomBytes(12).toString('hex');
const INTERACTIVE = !promptArg && !serverMode && !backgroundMode;

if (DANGER_MODE) {
  console.log('[WARN] DANGER MODE ENABLED - All CLI commands will run WITHOUT approval (within reason)!');
}

// ====================== TOOL DEFINITIONS ======================
const tools = [
  { type: "function", function: { name: "read_file", description: "Read a regular file as line-numbered UTF-8. Optional offset (1-based) and limit select lines. Reads use 64KiB chunks, at most 16MiB scanned, and check a 5s/caller budget between IO operations. Output is bounded by the configured result cap and a 128KiB character ceiling; incomplete views are marked and must not be used for whole-file rewrites. Only scanned bytes are encoding-validated; unscanned tails remain unknown. Initial binary files return [BINARY]; empty files return (empty file).", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "append_file", description: "Append content to a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Replace an exact unique substring in a file (surgical edit, much safer than rewriting whole files). old_string must occur exactly once, or set replace_all=true.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] } } },
  { type: "function", function: { name: "agent_tool", description: "Run a sub-agent: a fresh AI conversation with full tool access that works through the task and returns its final answer. Use for self-contained research or multi-step work.", parameters: { type: "object", properties: { name: { type: "string" }, task: { type: "string" } }, required: ["name", "task"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command via the system default shell (cmd.exe on Windows, /bin/sh elsewhere).", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "bash_tool", description: "Run a command in a REAL bash shell; default is a fresh stateless shell per call. persistent=true is disabled in HTTP server mode. CLI/REPL persistent shells retain cwd/env within the current conversation, sub-agent or workflow; sub-agent/workflow shells close when that scope ends.", parameters: { type: "object", properties: { command: { type: "string" }, persistent: { type: "boolean" }, timeout_ms: { type: "number", description: "persistent mode only: 1000-300000, default 120000" } }, required: ["command"] } } },
  { type: "function", function: { name: "powershell_tool", description: "Run a command in REAL Windows PowerShell (uses PS2-compatible APIs, UTF-16LE Base64 input and UTF-8 text output). Best for Windows administration tasks.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "glob_tool", description: "File search (glob). Plain patterns like *.js match the basename at any depth. Patterns naming a path are directory-aware: * stays within one directory, ** spans directories (e.g. src/*.js, src/**/*.js, **/*.test.js). Budget: node_modules/.git/dist/.cache are skipped; at most 1000 matches, 4000 visited entries and depth 12. Truncation/incomplete markers distinguish partial scans from no matches.", parameters: { type: "object", properties: { pattern: { type: "string" }, directory: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep_tool", description: "Search contents of a file or directory. Budget: node_modules/.git/dist/.cache, files over 2MB and binary files are skipped; at most 5000 text files, 20000 visited entries and depth 12. Matching stops with an error after 100ms per file; traversal checks a 5s/caller deadline between operations. Truncation/incomplete markers identify partial scans; invalid input paths are errors.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "list_dir", description: "List up to 200 directory entries (name, type, size); incomplete results are marked. Use narrower directories/glob patterns for omitted paths.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "download_tool", description: "Download a URL to a local file inside the workspace (streamed, 500 MB cap).", parameters: { type: "object", properties: { url: { type: "string" }, path: { type: "string" } }, required: ["url", "path"] } } },
  { type: "function", function: { name: "process_list_tool", description: "List running processes (tasklist on Windows, ps on Unix).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "process_kill_tool", description: "Kill a process by PID. On Windows uses taskkill /T /F (kills the whole child tree).", parameters: { type: "object", properties: { pid: { type: "number" } }, required: ["pid"] } } },
  { type: "function", function: { name: "web_fetch_tool", description: "Simple GET request to any URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "web_search_tool", description: "Search DuckDuckGo for links.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_browser_tool", description: "Real browser: navigate (GET page), click links (follow), extract content + links (infers from link names), view images with optional VISION_MODEL.", parameters: { type: "object", properties: { url: { type: "string" }, action: { type: "string", enum: ["navigate", "click", "extract"] } }, required: ["url"] } } },
  { type: "function", function: { name: "notebook_edit_tool", description: "Edit Jupyter notebook (JSON structure).", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "object" } }, required: ["path", "edits"] } } },
  { type: "function", function: { name: "ask_user_question_tool", description: "Prompt user for input.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } },
  { type: "function", function: { name: "brief_tool", description: "Upload/summarize files to folder.summary.", parameters: { type: "object", properties: { folder: { type: "string" } }, required: ["folder"] } } },
  { type: "function", function: { name: "todo_write_tool", description: "Structured task list persisted in .7coder/todos.json. action=add (title required) appends a pending item; action=update (id required) changes title and/or status (pending|doing|done); action=list returns all items with status. Legacy calls carrying only a content string are treated as add.", parameters: { type: "object", properties: { action: { type: "string", enum: ["add", "update", "list"] }, title: { type: "string" }, id: { type: "string" }, status: { type: "string", enum: ["pending", "doing", "done"] }, content: { type: "string" } } } } },
  { type: "function", function: { name: "memory_tool", description: "Durable long-term memory notes in .7coder/memory/<topic>.md, recalled automatically at task start when keywords match the prompt. action=save (topic+content, upserts), action=read (topic), action=list, action=delete. Save project conventions, user preferences, hard-won facts - not transient state.", parameters: { type: "object", properties: { action: { type: "string", enum: ["save", "read", "list", "delete"] }, topic: { type: "string", description: "[a-z0-9][a-z0-9_-] max 40 chars" }, content: { type: "string" } }, required: ["action"] } } },
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
  { type: "function", function: { name: "mcp_tool", description: "Call a Model Context Protocol tool. Prefer server: names from mcp_list_tools_tool (real MCP stdio servers configured in .7coder/mcp.json). Legacy custom-HTTP/npx bridges via mcp_url/npx_pkg still work.", parameters: { type: "object", properties: { tool_name: { type: "string" }, args: { type: "object" }, server: { type: "string" }, mcp_url: { type: "string" }, npx_pkg: { type: "string" } }, required: ["tool_name"] } } },
  { type: "function", function: { name: "mcp_list_tools_tool", description: "List configured MCP stdio servers and their tools (with arg schemas). Read-only discovery; use before mcp_tool.", parameters: { type: "object", properties: { } } } },
  { type: "function", function: { name: "prompt_from_file", description: "Use prompt from TODO.md or similar.", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } } },
  { type: "function", function: { name: "skill_tool", description: "Invoke a user-defined skill: reads .7coder/skills/<skill_name>.md and returns its instructions to follow. Pass params for the skill to use.", parameters: { type: "object", properties: { skill_name: { type: "string" }, params: { type: "object" } }, required: ["skill_name"] } } },
  { type: "function", function: { name: "synthetic_output_tool", description: "Generate validated structured output: provide a JSON schema (object with properties/required) and a prompt; returns JSON that is parsed and type-checked (one retry on invalid).", parameters: { type: "object", properties: { schema: { type: "object" }, prompt: { type: "string" } }, required: ["schema", "prompt"] } } },
  { type: "function", function: { name: "workflow_tool", description: "Run a sequence of tool calls from a JSON plan: steps=[{tool, args, optional}]. Steps execute in order through the normal permission system; a failing step stops the workflow unless optional=true. Max 50 steps; nested workflows are rejected.", parameters: { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" }, optional: { type: "boolean" } }, required: ["tool"] } }, description: { type: "string" } }, required: ["steps"] } } },
  { type: "function", function: { name: "run_tests_tool", description: "Run tests and parse pass/fail counts (jest/mocha/karma, node:test, generic). When command is omitted, detects npm scripts.test or uses the Agent runtime's built-in test runner if supported. Node 13 requires an explicit command for loose *.test.js files; it has no --test flag.", parameters: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "number" } } } } },
  { type: "function", function: { name: "diagnostics_tool", description: "Run project-local static diagnostics and list problems. Uses typescript (tsc --noEmit, whole project) if installed in node_modules, else eslint (--format json). Runs project-local toolchain binaries (tsc/eslint) - these execute project-defined JavaScript, so approval is required.", parameters: { type: "object", properties: { path: { type: "string", description: "Optional target for eslint (file/folder); ignored by tsc which always checks the whole project" } } } } },
  { type: "function", function: { name: "git_status_tool", description: "Show the working tree status (branch, staged/untracked/modified files) and last commit. Safe/read-only.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "git_diff_tool", description: "Show unstaged (or staged with staged=true) diff for a file or the whole tree. Safe/read-only.", parameters: { type: "object", properties: { path: { type: "string" }, staged: { type: "boolean" } } } } },
  { type: "function", function: { name: "git_commit_tool", description: "Stage all changes and create a git commit. If message is omitted, one is generated from the session audit log. A pre-commit snapshot (git stash create) is recorded so /undo-style recovery is possible; nothing is pushed.", parameters: { type: "object", properties: { message: { type: "string" }, stage_all: { type: "boolean" } } } } },
  { type: "function", function: { name: "auto_approval_return", description: "Lightweight model hands over to heavy model for auto-approval description.", parameters: { type: "object", properties: { description: { type: "string" } } } } },
  { type: "function", function: { name: "computer_use", description: "Real screen control: screenshot (real capture), mouse_move/click (real cursor + click), type_text/press_key (real SendKeys). Windows-only for input actions; requires ENABLE_COMPUTER_USE=true.", parameters: { type: "object", properties: { action: { type: "string", enum: ["screenshot", "mouse_move", "click", "type_text", "press_key"] }, x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, key: { type: "string" } }, required: ["action"] } } },
  { type: "function", function: { name: "plan_mode", description: "Plan mode: light model improves prompt + specifies refinement loops for heavy model deep thinking. Use ONLY for complex tasks.", parameters: { type: "object", properties: { initial_task: { type: "string" } }, required: ["initial_task"] } } },
  { type: "function", function: { name: "auto_debug_tool", description: "Launch app/script, observe output and exit status for 2-5 min and attempt bounded repairs. GUI observation is passive: no automatic clicks or typing, and GUI functionality is not validated. Nested auto-debug is refused.", parameters: { type: "object", properties: { path: { type: "string" }, type: { type: "string", enum: ["gui", "cli", "script"] }, duration_minutes: { type: "number" } }, required: ["path"] } } },
  { type: "function", function: { name: "bickering_tool", description: "Two small-model PM sub-agents bicker/debate the current task until they reach agreement.", parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } } }
];

// ====================== TOOL METADATA (OPT-12) ======================
// One declaration per tool owns explicit permission and concurrency decisions.
// Resource/execution annotations DESCRIBE effects; they never imply approval.
// Memory writes and configured MCP discovery keep their auto-safe exceptions.
// null risk/explain preserves model fallback (sleep has LOW risk, LLM explain).
// Cancellation: boundary = loop boundaries; active-command = child cancellation;
// inherited = child steps inherit token; partial = persistent shell is partial.
function toolMetadata(overrides) {
  return Object.freeze(Object.assign({ risk: null, explain: null, autoSafe: false,
    parallelRead: false, trackChanges: false }, overrides, {
      resources: Object.freeze(Object.assign({}, overrides.resources))
    }));
}
const TOOL_METADATA = Object.freeze(Object.assign(Object.create(null), {
  read_file: toolMetadata({
    autoSafe: true, parallelRead: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'read' }
  }),
  write_file: toolMetadata({
    explain: (a) => `Write file ${a.path}`, risk: "MEDIUM", trackChanges: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'write' }
  }),
  append_file: toolMetadata({
    explain: (a) => `Append to file ${a.path}`, risk: "MEDIUM", trackChanges: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'write' }
  }),
  edit_file: toolMetadata({
    explain: (a) => `Edit file ${a.path}`, risk: "MEDIUM", trackChanges: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'write' }
  }),
  agent_tool: toolMetadata({
    explain: (a) => `Spawn sub-agent "${a.name}" with task: ${String(a.task || '').substring(0, 60)}`, risk: "MEDIUM",
    execution: "composite", cancellation: "inherited",
    resources: { workspace: 'readwrite', process: 'execute', network: 'readwrite', state: 'readwrite' }
  }),
  run_command: toolMetadata({
    explain: (a) => `Run shell command: ${String(a.command || '').substring(0, 100)}`, risk: "HIGH",
    execution: "command", cancellation: "active-command",
    resources: { workspace: 'readwrite', process: 'execute' }
  }),
  bash_tool: toolMetadata({
    explain: (a) => `Run bash command: ${String(a.command || '').substring(0, 100)}`, risk: "HIGH",
    execution: "command", cancellation: "partial",
    resources: { workspace: 'readwrite', process: 'execute', shell: 'readwrite' }
  }),
  powershell_tool: toolMetadata({
    explain: (a) => `Run PowerShell command: ${String(a.command || '').substring(0, 100)}`, risk: "HIGH",
    execution: "command", cancellation: "active-command",
    resources: { workspace: 'readwrite', process: 'execute' }
  }),
  glob_tool: toolMetadata({
    autoSafe: true, parallelRead: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'read' }
  }),
  grep_tool: toolMetadata({
    autoSafe: true, parallelRead: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'read' }
  }),
  list_dir: toolMetadata({
    autoSafe: true, parallelRead: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'read' }
  }),
  download_tool: toolMetadata({
    explain: (a) => `Download ${a.url} to ${a.path}`, risk: "MEDIUM", trackChanges: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'write', network: 'read' }
  }),
  process_list_tool: toolMetadata({
    autoSafe: true, parallelRead: true,
    execution: "command", cancellation: "active-command",
    resources: { process: 'read' }
  }),
  process_kill_tool: toolMetadata({
    explain: (a) => `Kill process ${a.pid}`, risk: "HIGH",
    execution: "command", cancellation: "boundary",
    resources: { process: 'write' }
  }),
  web_fetch_tool: toolMetadata({
    execution: "builtin", cancellation: "boundary",
    resources: { network: 'read' }
  }),
  web_search_tool: toolMetadata({
    execution: "builtin", cancellation: "boundary",
    resources: { network: 'read' }
  }),
  web_browser_tool: toolMetadata({
    execution: "model", cancellation: "boundary",
    resources: { network: 'read', model: 'execute' }
  }),
  notebook_edit_tool: toolMetadata({
    explain: (a) => `Edit notebook ${a.path}`, risk: "MEDIUM", trackChanges: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'write' }
  }),
  ask_user_question_tool: toolMetadata({
    execution: "builtin", cancellation: "boundary",
    resources: { conversation: 'readwrite' }
  }),
  brief_tool: toolMetadata({
    explain: (a) => `Summarize folder ${a.folder} into ${a.folder}.summary`, risk: "LOW",
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'read', state: 'write' }
  }),
  todo_write_tool: toolMetadata({
    explain: (a) => `Update structured task list (.7coder/todos.json): ${a.action === 'list' ? 'list' : (a.action || 'add')}${a.id ? ' ' + a.id : ''}${a.title ? ' "' + String(a.title).substring(0, 40) + '"' : ''}`, risk: "LOW",
    execution: "builtin", cancellation: "boundary",
    resources: { state: 'readwrite', workspace: 'write' }
  }),
  memory_tool: toolMetadata({
    explain: (a) => `${a.action === 'save' ? 'Save memory note' : a.action === 'delete' ? 'Delete memory note' : 'Read memory notes'}${a.topic ? ' ' + a.topic : 's (.7coder/memory)'}`, risk: "LOW", autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { memory: 'readwrite' }
  }),
  read_mcp_resource_tool: toolMetadata({
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'read' }
  }),
  sleep_tool: toolMetadata({
    risk: "LOW", parallelRead: true,
    execution: "builtin", cancellation: "boundary",
    resources: { clock: 'read' }
  }),
  snip_tool: toolMetadata({
    autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { conversation: 'read' }
  }),
  tool_search_tool: toolMetadata({
    autoSafe: true, parallelRead: true,
    execution: "builtin", cancellation: "boundary",
    resources: { configuration: 'read' }
  }),
  list_mcp_resources_tool: toolMetadata({
    autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'readwrite' }
  }),
  enter_worktree_tool: toolMetadata({
    explain: (a) => `Create git worktree at ${a.path}`, risk: "MEDIUM",
    execution: "command", cancellation: "boundary",
    resources: { git: 'write', workspace: 'write' }
  }),
  schedule_cron_tool: toolMetadata({
    explain: (a) => `Schedule cron "${a.schedule}" running: ${String(a.command || '').substring(0, 60)}`, risk: "HIGH",
    execution: "command", cancellation: "boundary",
    resources: { process: 'execute', state: 'write' }
  }),
  cron_create_tool: toolMetadata({
    explain: (a) => `Schedule cron "${a.schedule}" running: ${String(a.command || '').substring(0, 60)}`, risk: "HIGH",
    execution: "command", cancellation: "boundary",
    resources: { process: 'execute', state: 'write' }
  }),
  cron_delete_tool: toolMetadata({
    explain: (a) => `Delete cron job ${a.job_id}`, risk: "MEDIUM",
    execution: "builtin", cancellation: "boundary",
    resources: { state: 'write' }
  }),
  cron_list_tool: toolMetadata({
    autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { state: 'read' }
  }),
  task_create_tool: toolMetadata({
    explain: (a) => `Start background task: ${String(a.command || '').substring(0, 80)}`, risk: "HIGH",
    execution: "command", cancellation: "boundary",
    resources: { workspace: 'readwrite', process: 'execute', state: 'write' }
  }),
  task_get_tool: toolMetadata({
    autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { state: 'read' }
  }),
  task_list_tool: toolMetadata({
    autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { state: 'read' }
  }),
  task_output_tool: toolMetadata({
    autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { state: 'read' }
  }),
  task_stop_tool: toolMetadata({
    execution: "command", cancellation: "boundary",
    resources: { process: 'write', state: 'write' }
  }),
  mcp_tool: toolMetadata({
    explain: (a) => `Call MCP tool ${a.tool_name}`, risk: "HIGH", trackChanges: true,
    execution: "configured", cancellation: "boundary",
    resources: { workspace: 'readwrite', process: 'execute', network: 'readwrite' }
  }),
  mcp_list_tools_tool: toolMetadata({
    autoSafe: true,
    execution: "configured", cancellation: "boundary",
    resources: { configuration: 'read', process: 'execute' }
  }),
  prompt_from_file: toolMetadata({
    autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'read' }
  }),
  skill_tool: toolMetadata({
    autoSafe: true,
    execution: "builtin", cancellation: "boundary",
    resources: { workspace: 'read' }
  }),
  synthetic_output_tool: toolMetadata({
    autoSafe: true,
    execution: "model", cancellation: "boundary",
    resources: { model: 'execute' }
  }),
  workflow_tool: toolMetadata({
    explain: (a) => `Run a ${Array.isArray(a.steps) ? a.steps.length : '?'}-step tool workflow`, risk: "HIGH",
    execution: "composite", cancellation: "inherited",
    resources: { workspace: 'readwrite', state: 'readwrite', process: 'execute', network: 'readwrite' }
  }),
  run_tests_tool: toolMetadata({
    explain: (a) => `Run test suite: ${String(a.command || 'auto-detected').substring(0, 80)}`, risk: "HIGH",
    execution: "command", cancellation: "active-command",
    resources: { workspace: 'readwrite', process: 'execute' }
  }),
  diagnostics_tool: toolMetadata({
    explain: (a) => `Run project-local static diagnostics (tsc/eslint from node_modules)${a.path ? ' on ' + a.path : ''} (executes project-defined JS - approval required)`, risk: "MEDIUM",
    execution: "project", cancellation: "active-command",
    resources: { workspace: 'readwrite', process: 'execute' }
  }),
  git_status_tool: toolMetadata({
    explain: () => 'Show git working tree status (read-only)', risk: "LOW", autoSafe: true, parallelRead: true,
    execution: "command", cancellation: "boundary",
    resources: { git: 'read', workspace: 'read' }
  }),
  git_diff_tool: toolMetadata({
    explain: (a) => `Show git diff${a.staged ? ' (staged)' : ''}${a.path ? ' for ' + a.path : ''} (read-only)`, risk: "LOW", autoSafe: true, parallelRead: true,
    execution: "command", cancellation: "boundary",
    resources: { git: 'read', workspace: 'read' }
  }),
  git_commit_tool: toolMetadata({
    explain: (a) => `Stage all and commit${a.message ? ': ' + String(a.message).substring(0, 60) : ' (auto message)'} (snapshot taken)`, risk: "HIGH", trackChanges: true,
    execution: "command", cancellation: "boundary",
    resources: { git: 'write', workspace: 'readwrite' }
  }),
  auto_approval_return: toolMetadata({
    execution: "builtin", cancellation: "boundary",
    resources: { conversation: 'read' }
  }),
  computer_use: toolMetadata({
    execution: "command", cancellation: "boundary",
    resources: { desktop: 'readwrite', state: 'write' }
  }),
  plan_mode: toolMetadata({
    execution: "model", cancellation: "boundary",
    resources: { model: 'execute' }
  }),
  auto_debug_tool: toolMetadata({
    execution: "composite", cancellation: "boundary",
    resources: { workspace: 'readwrite', desktop: 'readwrite', process: 'execute', model: 'execute' }
  }),
  bickering_tool: toolMetadata({
    autoSafe: true,
    execution: "model", cancellation: "boundary",
    resources: { model: 'execute' }
  }),
}));
const UNKNOWN_TOOL_METADATA = toolMetadata({ execution: 'unknown', cancellation: 'boundary', resources: {} });
function getToolMetadata(name) {
  return Object.prototype.hasOwnProperty.call(TOOL_METADATA, name) ? TOOL_METADATA[name] : UNKNOWN_TOOL_METADATA;
}
function validateToolMetadata(declarations, registry) {
  const names = declarations.map(t => t.function.name);
  const entries = Object.keys(registry);
  if (new Set(names).size !== names.length || names.length !== entries.length ||
      names.some(n => !Object.prototype.hasOwnProperty.call(registry, n)) || entries.some(n => !names.includes(n))) {
    throw new Error('Tool metadata must match the tool declarations exactly');
  }
  const executions = ['builtin', 'command', 'project', 'configured', 'model', 'composite'];
  const cancellations = ['boundary', 'active-command', 'inherited', 'partial'];
  const resources = ['workspace', 'process', 'network', 'state', 'shell', 'model',
    'conversation', 'memory', 'clock', 'configuration', 'git', 'desktop'];
  for (const name of names) {
    const m = registry[name];
    if (!m || !(m.risk === null || ['LOW', 'MEDIUM', 'HIGH'].includes(m.risk)) ||
        !(m.explain === null || typeof m.explain === 'function') ||
        ['autoSafe', 'parallelRead', 'trackChanges'].some(k => typeof m[k] !== 'boolean') ||
        !executions.includes(m.execution) || !cancellations.includes(m.cancellation) ||
        !m.resources || !Object.keys(m.resources).length || Object.keys(m.resources).some(k =>
          !resources.includes(k) || !['read', 'write', 'readwrite', 'execute'].includes(m.resources[k])) ||
        (m.parallelRead && (m.trackChanges || Object.values(m.resources).some(v => v !== 'read')))) {
      throw new Error('Invalid tool metadata: ' + name);
    }
  }
}
validateToolMetadata(tools, TOOL_METADATA);
const READ_ONLY_TOOLS = new Set(Object.keys(TOOL_METADATA).filter(n => TOOL_METADATA[n].parallelRead));

// ====================== SYSTEM PROMPT ======================
// GAP-3c: one-shot workspace sketch injected below the base prompt so the
// model sees the directory shape without spending a list_dir call. Computed
// once at process start (cached in the systemPrompt const); directories get a
// `dir/ (N files)` line, top-level files are listed by name, max 2 levels
// deep, capped at ~150 lines with a truncation note.
function buildRepoMap() {
  const SKIP = new Set(['.7coder', '.git', 'node_modules', 'dist', '.cache']);
  const MAX_DEPTH = 2;   // path depth: root files + one nested level (sub/file.txt)
  const MAX_LINES = 150;
  const lines = [];
  let truncated = false;
  let remaining = 2000;
  const deadlineAt = Date.now() + 5000, incomplete = new Set();
  function entriesFor(dir) {
    if (remaining <= 1) { incomplete.add('total visit limit 2000'); return []; }
    try {
      const result = readDirectoryEntriesBounded(dir, { maxEntries: Math.min(400, remaining - 1), deadlineAt });
      remaining -= result.visited;
      if (result.incomplete) incomplete.add(result.incomplete);
      return result.entries;
    } catch (e) { incomplete.add('unreadable directory (' + (e.code || 'IO error') + ')'); return []; }
  }
  function countFiles(dir) {
    const before = incomplete.size, entries = entriesFor(dir);
    const count = entries.filter(e => !e.isDirectory() && !SKIP.has(e.name)).length;
    return (incomplete.size !== before || incomplete.size > 0 ? 'at least ' : '') + count;
  }
  function walk(dir, rel, depth) {
    if (depth >= MAX_DEPTH || truncated) return;
    const entries = entriesFor(dir);
    const dirs = [];
    const files = [];
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      if (ent.isDirectory()) dirs.push(ent.name);
      else if (ent.isFile()) files.push(ent.name);
    }
    dirs.sort(); files.sort();
    for (const d of dirs) {
      if (lines.length >= MAX_LINES) { truncated = true; return; }
      const childRel = rel ? rel + '/' + d : d;
      lines.push(childRel + '/ (' + countFiles(path.join(dir, d)) + ' files)');
      walk(path.join(dir, d), childRel, depth + 1);
    }
    for (const f of files) {
      if (lines.length >= MAX_LINES) { truncated = true; return; }
      lines.push(rel ? rel + '/' + f : f);
    }
  }
  walk(launchDir, '', 0);
  let out = lines.join('\n');
  if (!out) out = '(empty workspace)';
  else if (truncated) out += '\n(workspace file map truncated at ' + MAX_LINES + ' lines)';
  if (incomplete.size) out = '(workspace file map incomplete: ' + Array.from(incomplete).join('; ') + ')\n' + out;
  return out;
}
const SYSTEM_PROMPT_BASE = `You are 7coder, a helpful, honest, and harmless AI coding assistant - a clean-room full replacement for Claude Code.
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

// GAP-3c: append the workspace file map once at startup - every conversation
// (CLI, HTTP, sub-agents) builds on this same composed prompt.
const systemPrompt = SYSTEM_PROMPT_BASE + '\n\n## Workspace file map\n' + buildRepoMap();

// ====================== HELPER FUNCTIONS (Node 13 + Windows 7 safe) ======================
// Case-insensitive on Windows so drive-letter/path case differences can't defeat the check.
function isInsideDir(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const normBase = process.platform === 'win32' ? base.toLowerCase() : base;
  const normTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const relative = path.relative(normBase, normTarget);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function readDirectoryEntriesBounded(directory, options = {}) {
  const maxEntries = options.maxEntries || 200, maxBytes = options.maxBytes || 64 * 1024;
  const deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : Date.now() + 5000;
  const entries = []; let handle, visited = 0, bytes = 0, incomplete = '';
  const check = () => { checkExecution(options.cancelled); return Date.now() < deadlineAt; };
  if (!check()) return { entries, visited, bytes, incomplete: 'directory scan deadline exceeded' };
  try {
    handle = fs.opendirSync(directory);
    while (true) {
      if (!check()) { incomplete = 'directory scan deadline exceeded'; break; }
      const entry = handle.readSync();
      if (!entry) break;
      visited++;
      if (entries.length >= maxEntries) { incomplete = 'entry limit ' + maxEntries; break; }
      const size = Buffer.byteLength(entry.name, 'utf8');
      if (size > maxBytes - bytes) { incomplete = 'directory name byte limit ' + maxBytes; break; }
      bytes += size; entries.push(entry);
    }
  } finally { if (handle) handle.closeSync(); }
  return { entries, visited, bytes, incomplete };
}
function openScanDirectory(directory, budgeted) {
  if (!budgeted) {
    const entries = fs.readdirSync(directory); let index = 0;
    return { next: () => index < entries.length ? entries[index++] : null, close() {} };
  }
  const handle = fs.opendirSync(directory);
  return { next() { const entry = handle.readSync(); return entry ? entry.name : null; }, close: () => handle.closeSync() };
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

// var is intentional: startup config loading can call internalStatePath before
// the helper section is evaluated; let would trigger a temporal-dead-zone error.
var launchDirRealCache = null;
function getLaunchDirReal() {
  if (launchDirRealCache == null) launchDirRealCache = realPathSafe(launchDir);
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

// OPT-14: all product-owned state paths pass through one real-path gate. The
// lexical path is returned for normal IO so missing leaf files can be created,
// while every existing prefix and the resolved target must remain inside the
// intended state directory and workspace. This closes junction/symlink aliases
// for built-in state without changing ordinary user-file path handling.
function internalStatePath(rootRelative, childRelative) {
  const rootLex = path.resolve(launchDir, rootRelative);
  const targetLex = childRelative === undefined ? rootLex : path.resolve(rootLex, childRelative);
  const workspace = getLaunchDirReal();
  const rootReal = realPathSafe(rootLex);
  const targetReal = realPathSafe(targetLex);
  if (!isInsideDir(workspace, rootReal)) throw new Error('Security: internal state root resolves outside workspace');
  if (!isInsideDir(rootReal, targetReal)) throw new Error('Security: internal state path resolves outside its state root');
  return targetLex;
}

function managedWorkspacePath(relativePath) {
  const lexical = path.resolve(launchDir, relativePath);
  const real = realPathSafe(lexical);
  if (!isInsideDir(getLaunchDirReal(), real)) throw new Error('Security: managed workspace path resolves outside workspace');
  return lexical;
}

// T22-13: product-owned state. Sibling files stay on the same volume; never
// unlink the destination to emulate replace on Windows. No claim of directory
// durability on power loss, and no cross-process read/modify/write lock (T22-14).
function fileByteLimitError(label, maxBytes) {
  return Object.assign(new Error(label + ' exceeds ' + maxBytes + '-byte limit; reduce the file before retrying (existing data retained).'), { code: 'EFILETOOLARGE' });
}
// Keep this helper hoisted: startup config is read before the state section runs.
// Both the opened descriptor and the actual bytes are bounded, including growth
// after fstat. Never use readFileSync here, even after a successful size check.
function readFileBytesBounded(file, maxBytes, label = 'File') {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error(label + ' must be a regular file');
    if (before.size > maxBytes) throw fileByteLimitError(label, maxBytes);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (!count) break;
      total += count;
      if (total > maxBytes) throw fileByteLimitError(label, maxBytes);
      chunks.push(chunk.slice(0, count));
    }
    const after = fs.fstatSync(fd), named = fs.statSync(file);
    const same = stat => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => stat[k] === before[k]);
    if (!same(after) || !same(named) || total !== before.size) throw new Error(label + ' changed during read; retry before using it');
    return Buffer.concat(chunks, total);
  } finally { fs.closeSync(fd); }
}
function stateFileByteLimit() { return 8 * 1024 * 1024; }
function readStateBytes(file, maxBytes = stateFileByteLimit()) { return readFileBytesBounded(file, Math.min(stateFileByteLimit(), maxBytes), 'State file ' + file); }
function readOptionalJsonConfig(file, label) {
  let bytes;
  try { bytes = readFileBytesBounded(file, 1024 * 1024, label + ' ' + file); }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  try { return parseStateJson(decodeUtf8Text(bytes)); }
  catch (e) { throw new Error(label + ' ' + file + ': ' + e.message); }
}
function guardStateFile(file, owner = file) {
  file = path.resolve(file); owner = path.resolve(owner);
  if (path.dirname(file) !== path.dirname(owner)) throw new Error('Security: state companion escaped its parent');
  const installConfig = [path.join(appDir, '.env'), path.join(appDir, 'models.json')].includes(owner);
  const allowedRoot = installConfig ? realPathSafe(appDir) : getLaunchDirReal();
  if (!isInsideDir(allowedRoot, realPathSafe(owner)) ||
      !isInsideDir(realPathSafe(path.dirname(owner)), realPathSafe(file))) {
    throw new Error('Security: state file resolves outside its allowed root');
  }
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Security: state file must be a regular file, not a link/directory');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return file;
}
function replaceStateBytes(file, bytes, owner = file) {
  file = guardStateFile(file, owner);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = file + '.7coder-tmp-' + process.pid + '-' + crypto.randomBytes(12).toString('hex');
  let fd = null, owned = false;
  try {
    guardStateFile(staging, owner);
    fd = fs.openSync(staging, 'wx', 0o600); owned = true;
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    guardStateFile(file, owner);
    fs.renameSync(staging, file);
    owned = false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { console.warn('[STATE] close failed for ' + staging + ': ' + e.code); } }
    if (owned) {
      try { fs.unlinkSync(staging); }
      catch (e) { if (e.code !== 'ENOENT') console.warn('[STATE] incomplete staging retained: ' + staging + ' (' + e.code + ')'); }
    }
  }
}
function parseStateText(text) { return text; }
function isManagedNote(file) {
  const rel = path.relative(launchDir, file).split(path.sep).join('/').toLowerCase();
  return rel === '7coder.md' || rel === 'todo.md' || rel === '.7coder/btw.md' ||
    /^\.7coder\/memory\/[a-z0-9][a-z0-9_-]{0,39}\.md$/.test(rel);
}
function managedStateParser(file) {
  const rel = path.relative(launchDir, file).split(path.sep).join('/').toLowerCase();
  if (rel === '.7coder/todos.json') return parseTodoState;
  if (rel === '.7coder/models.json') return parseModelState;
  if (rel === '.7coder/btw-migration.json') return parseBtwMigrationState;
  if (rel === '.7coder/session.json' || /^\.7coder\/sessions\/[a-z0-9._-]+\.json$/.test(rel)) return parseSessionState;
  if (rel === '.env' || isManagedNote(file)) return parseStateText;
  return null;
}
function parseStateJson(text) {
  // Do not echo a JSON parser's input excerpt: models.json can contain keys.
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error('invalid JSON'); }
}
function parseModelState(text) {
  const j = parseStateJson(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('invalid model profiles');
  for (const k of Object.keys(j)) {
    const p = j[k];
    if (!p || typeof p !== 'object' || Array.isArray(p) ||
        (p.endpoint !== undefined && typeof p.endpoint !== 'string') ||
        (p.apiKey !== undefined && typeof p.apiKey !== 'string')) throw new Error('invalid model profile fields');
  }
  return j;
}
function parseTodoState(text) {
  const j = parseStateJson(text);
  if (!j || !Array.isArray(j.items) || j.items.some(it => !it || typeof it !== 'object' ||
      typeof it.id !== 'string' || typeof it.title !== 'string' || !['pending', 'doing', 'done'].includes(it.status))) {
    throw new Error('invalid todo store');
  }
  return j;
}
const SESSION_MAX_BYTES = 2 * 1024 * 1024;
function sessionMessageRecord(message) {
  const out = { role: message.role, content: message.content };
  if (message.turnId !== undefined) {
    if (typeof message.turnId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(message.turnId)) throw new Error('invalid session turnId');
    out.turnId = message.turnId;
  }
  if (message.status !== undefined) {
    if (!['running', 'ok', 'failed', 'cancelled'].includes(message.status)) throw new Error('invalid session turn status');
    out.status = message.status;
  }
  if (message.error !== undefined) out.error = String(message.error).slice(0, 1000);
  return out;
}
function parseSessionState(text) {
  const j = parseStateJson(text);
  if (!j || !Array.isArray(j.messages) || j.messages.some(m => !m ||
      !['system', 'user', 'assistant', 'tool'].includes(m.role) ||
      !(m.content === null || typeof m.content === 'string' || Array.isArray(m.content)))) {
    throw new Error('invalid session store');
  }
  return j;
}
function quarantineState(file, bytes, owner = file, maxBytes = stateFileByteLimit()) {
  const evidence = guardStateFile(file + '.7coder-corrupt-' + crypto.createHash('sha256').update(bytes).digest('hex'), owner);
  let existing;
  try { existing = readStateBytes(evidence, Math.min(bytes.length, maxBytes)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing) {
    if (!existing.equals(bytes)) throw new Error('state corruption evidence collision: ' + evidence);
  } else replaceStateBytes(evidence, bytes, owner);
  console.warn('[STATE] invalid state preserved: ' + evidence);
}
function sharedInstallState(file) {
  if (![path.join(appDir, '.env'), path.join(appDir, 'models.json')].includes(path.resolve(file))) return false;
  const normalize = p => process.platform === 'win32' ? path.normalize(p).toLowerCase() : p;
  return normalize(fs.realpathSync(appDir)) !== normalize(getLaunchDirReal());
}
function readStateRecord(file, parse = parseStateText, readOnly = false, maxBytes = stateFileByteLimit()) {
  file = guardStateFile(file);
  let bytes, invalid = false;
  try { bytes = readStateBytes(file, maxBytes); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (bytes !== undefined) {
    try { return { bytes, value: parse(decodeUtf8Text(bytes)) }; }
    catch (e) {
      invalid = true;
      if (readOnly) console.warn('[STATE] invalid shared install config retained in place: ' + file);
      else quarantineState(file, bytes, file, maxBytes);
    }
  }
  const previous = guardStateFile(file + '.7coder-prev', file);
  let saved;
  try { saved = readStateBytes(previous, maxBytes); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (!invalid) return null;
    throw new Error('Invalid state has no valid previous version; repair before retrying: ' + file);
  }
  let value;
  try { value = parse(decodeUtf8Text(saved)); }
  catch (e) {
    if (!readOnly) quarantineState(previous, saved, file, maxBytes);
    throw new Error('Previous state is also invalid; repair before retrying: ' + file);
  }
  // Restore without copying the corrupt primary over the valid previous copy.
  if (!readOnly) replaceStateBytes(file, saved);
  console.warn('[STATE] ' + (readOnly ? 'using validated previous shared config without modifying installation: ' : 'restored ') + file +
    ' from ' + previous + (invalid ? '; invalid bytes retained' : '; primary was missing'));
  return { bytes: saved, value };
}
function writeStateFile(file, text, parse = parseStateText, expectedCurrent = undefined) {
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > stateFileByteLimit()) throw fileByteLimitError('Proposed state', stateFileByteLimit());
  const bytes = Buffer.from(normalizeUtf8Input(text), 'utf8');
  parse(decodeUtf8Text(bytes)); // validate proposed data before changing anything
  const current = readStateRecord(file, parse);
  if (expectedCurrent !== undefined && (expectedCurrent === null ? current !== null :
      !current || !Buffer.isBuffer(expectedCurrent) || !current.bytes.equals(expectedCurrent))) throw new Error('State changed before commit: ' + file);
  if (current && current.bytes.equals(bytes)) return;
  if (current) replaceStateBytes(file + '.7coder-prev', current.bytes, file);
  replaceStateBytes(file, bytes);
}
function deleteStateFile(file) {
  file = guardStateFile(file);
  const previous = guardStateFile(file + '.7coder-prev', file);
  // Prevent an explicit delete from being silently undone by missing-primary
  // recovery. If backup deletion fails, leave the primary in place.
  let removedPrevious = false;
  try { fs.unlinkSync(previous); removedPrevious = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT' || !removedPrevious) throw e; }
}
function loadEnvState(file, override) {
  const record = readStateRecord(file, parseStateText, sharedInstallState(file));
  if (!record) return;
  const parsed = require('dotenv').parse(record.value);
  for (const key of Object.keys(parsed)) {
    if (override || process.env[key] === undefined) process.env[key] = parsed[key];
  }
  if (override && Object.keys(parsed).length) console.log('[OK] workspace .env loaded (' + Object.keys(parsed).length + ' overrides)');
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
  'id_rsa', 'id_ed25519', 'credentials.json',
  'models.json' // AST-04: .7coder/models.json stores provider apiKeys
];

function isProtectedTarget(name, args) {
  if (!['read_file', 'prompt_from_file', 'write_file', 'append_file', 'notebook_edit_tool', 'edit_file', 'download_tool'].includes(name)) return false;
  const p = args && (args.path || args.file);
  if (!p || typeof p !== 'string') return false;
  // Backups/evidence/staging of credentials retain the original protection.
  const originalPath = p.replace(/(?:\.7coder-(?:prev|tmp-\d+-[a-f0-9]+|corrupt-[a-f0-9]{64}))+$/i, '');
  if (PROTECTED_FILES.includes(path.basename(originalPath).toLowerCase())) return true;
  // GAP-11: user-extended protection - protected_extra patterns match the
  // sanitized workspace-relative path OR the bare file name.
  if (permRules.protectedExtra.length) {
    let rel = '';
    try { rel = path.relative(launchDir, path.join(launchDir, sanitizePath(originalPath))).split(path.sep).join('/'); } catch (e) { rel = String(originalPath).split(path.sep).join('/'); }
    const base = path.basename(originalPath);
    for (const r of permRules.protectedExtra) {
      if (r.argRe.test(rel) || r.argRe.test(base)) return true;
    }
  }
  return false;
}

// ====================== USER PERMISSION RULES (GAP-11) ======================
// .7coder/permissions.json in the workspace (plus permissions.json next to
// index.js; both layers concat, workspace first). Shape:
//   { "protected_extra": ["secretzone/**", "*.key"],
//     "deny":  ["read_file(blocked.txt)", "run_command(*format*)"],
//     "allow": ["write_file(scratch/**)", "run_command(*npm test*)"] }
// Rule syntax "tool:pattern" where tool is an exact tool name or '*'; '*'
// in the pattern matches anything. File tools match the sanitized relative
// path, command tools match the command text, everything else the JSON args.
// SEMANTICS (security-first ordering, user rules can only TIGHTEN):
//   - deny blocks in EVERY mode (even bypass) - it is the user's own fence.
//   - allow only skips the approval layer; it can never bypass protected
//     files, the super-dangerous command block, or denial mode.
//   - the built-in PROTECTED_FILES rails remain first and unbeatable.
const permRules = { allow: [], deny: [], protectedExtra: [] };
function compilePermissionWildcard(pattern) {
  const literals = pattern.split('*').filter(part => part.length);
  if (literals.length > 128) throw new Error('Permission wildcard exceeds 128 literal segments; simplify the rule');
  const pieces = literals.map(part => ({ length: part.length, re: new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') }));
  const hasStar = pattern.includes('*');
  const minimum = pieces.reduce((n, part) => n + part.length, 0);
  const head = pattern.charAt(0) !== '*' ? pieces.shift() : null;
  const tail = hasStar && pattern.charAt(pattern.length - 1) !== '*' ? pieces.pop() : null;
  const at = (piece, text, start) => { piece.re.lastIndex = 0; return piece.re.test(text.slice(start, start + piece.length)); };
  return { test(value) {
    const text = String(value);
    if (text.length < minimum) return false;
    if (!hasStar) return text.length === pattern.length && (!head || at(head, text, 0));
    let from = 0, end = text.length;
    if (head) { if (!at(head, text, 0)) return false; from = head.length; }
    if (tail) { end -= tail.length; if (!at(tail, text, end)) return false; }
    // Each search regex is an escaped fixed literal. Earliest nonoverlapping
    // matches leave the most space for later pieces; no wildcard backtracking.
    for (const piece of pieces) {
      piece.re.lastIndex = from;
      const match = piece.re.exec(text);
      if (!match || match.index + piece.length > end) return false;
      from = match.index + piece.length;
    }
    return from <= end;
  } };
}
function compilePermRule(raw, bucket) {
  const s = String(raw);
  // rule syntax: "tool(pattern)" - tool is an exact name or '*', pattern is
  // a wildcard text ('*' spans anything). A bare tool name with no parens
  // means "this tool, any args".
  let tool = '';
  let pat = '*';
  const m = s.match(/^([A-Za-z_0-9*]+)\(([\s\S]*)\)$/);
  if (m) { tool = m[1]; pat = m[2]; }
  else if (/^[A-Za-z_0-9*]+$/.test(s)) { tool = s; }
  else return null;
  if (!pat) return null;
  let toolRe;
  if (tool === '*') toolRe = /^[a-z_0-9]+$/i;
  else if (/^[a-z_0-9]+$/i.test(tool)) toolRe = new RegExp('^' + tool + '$', 'i');
  else return null;
  // wildcard text pattern: '*' spans anything (including separators), the
  // rest is literal, case-insensitive, full-match against the arg text.
  const argRe = compilePermissionWildcard(pat);
  return { raw: s, bucket: bucket, toolRe: toolRe, argRe: argRe };
}
function loadPermRules() {
  const next = { allow: [], deny: [], protectedExtra: [] };
  let count = 0;
  const seen = {};
  const files = [path.join(appDir, 'permissions.json')];
  files.push(internalStatePath('.7coder', 'permissions.json'));
  for (const f of files) {
    const j = readOptionalJsonConfig(f, 'Permission configuration');
    if (j === undefined) continue;
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('Invalid permission configuration object: ' + f);
    for (const bucket of ['deny', 'allow', 'protected_extra']) {
      const list = j[bucket];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new Error('Permission field ' + bucket + ' must be an array: ' + f);
      const target = bucket === 'protected_extra' ? next.protectedExtra : next[bucket];
      for (let i = 0; i < list.length; i++) {
        const raw = list[i];
        if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) throw new Error('Invalid permission rule size/type in ' + bucket + ' index ' + i + ': ' + f);
        // A2-02: the dedup key MUST include the bucket - a bare-string key
        // let an install-level allow swallow a workspace deny of the SAME
        // rule text (the deny was read second and silently dropped).
        const seenKey = bucket + '|' + String(raw);
        if (seen[seenKey]) continue;
        seen[seenKey] = true;
        if (++count > 1000) throw new Error('Merged permission configuration exceeds 1000 rules: ' + f);
        let c = null;
        if (bucket === 'protected_extra') {
          // pure path pattern - no tool prefix. Matches the relative path
          // OR the bare file name, and we normalize both sides to forward
          // slashes so patterns are platform-independent.
          const pat = String(raw).trim();
          if (pat) {
            const argRe = compilePermissionWildcard(pat);
            c = { raw: pat, bucket: 'protected_extra', toolRe: /^[a-z_0-9]+$/i, argRe: argRe };
          }
        } else {
          c = compilePermRule(raw, bucket);
        }
        if (c) target.push(c);
        else throw new Error('Invalid permission rule in ' + bucket + ' index ' + i + ': ' + f);
      }
    }
  }
  permRules.allow = next.allow; permRules.deny = next.deny; permRules.protectedExtra = next.protectedExtra;
  if (permRules.allow.length || permRules.deny.length || permRules.protectedExtra.length) {
    console.log('[PERM] user permission rules loaded: ' + permRules.deny.length + ' deny, ' + permRules.allow.length + ' allow, ' + permRules.protectedExtra.length + ' protected-extra (deny holds in every mode; allow never overrides the hard rails)');
  }
}
try { loadPermRules(); }
catch (e) { console.error('[ERROR] permission configuration load failed: ' + e.message); process.exit(1); }
function permRuleArgText(name, args) {
  // Normalized to forward slashes on BOTH sides so patterns written as
  // "forbidden/**" match on Windows paths too.
  if (['run_command', 'bash_tool', 'powershell_tool', 'task_create_tool', 'schedule_cron_tool', 'cron_create_tool'].includes(name)) {
    return String((args && args.command) || '');
  }
  if (args && typeof args.path === 'string') {
    try { return path.relative(launchDir, path.join(launchDir, sanitizePath(args.path))).split(path.sep).join('/'); } catch (e) { return String(args.path).split(path.sep).join('/'); }
  }
  if (args && typeof args.url === 'string') return String(args.url);
  return JSON.stringify(args || {});
}
function matchPermRule(bucket, name, args) {
  let text;
  for (const r of permRules[bucket]) {
    if (r.toolRe.test(name)) {
      if (text === undefined) text = permRuleArgText(name, args);
      if (r.argRe.test(text)) return r;
    }
  }
  return null;
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
  // Git for Windows is frequently installed on a non-C drive (e.g.
  // D:\Program Files\Git) and a minimal/stripped PATH would also defeat the
  // 'where bash' fallback below - so probe the standard Git layout on every
  // present drive letter, and every PATH entry, before giving up.
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
    if (!fs.existsSync(letter + ':\\')) continue;
    candidates.push(letter + ':\\Program Files\\Git\\bin\\bash.exe');
    candidates.push(letter + ':\\Program Files\\Git\\usr\\bin\\bash.exe');
    candidates.push(letter + ':\\Git\\bin\\bash.exe');
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'bash.exe'));
  }
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

// Git's bin/bash.exe may be a compat launcher which owns a second
// usr/bin/bash.exe. Managed persistent/stateless/debug launches must hold
// the actual interpreter. Unknown non-Git layouts retain their original path.
function persistentBashExecutable(bash) {
  if (process.platform !== 'win32' || !/[\\/]bin[\\/]bash\.exe$/i.test(bash) || /[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(bash)) return bash;
  const direct = path.resolve(path.dirname(bash), '..', 'usr', 'bin', 'bash.exe');
  return fs.existsSync(direct) ? direct : bash;
}
function persistentBashEnvironment(bash) {
  const env = Object.assign({}, process.env, { TERM: 'dumb', PS1: '' });
  if (process.platform !== 'win32' || !/[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(bash)) return env;
  const root = path.resolve(path.dirname(bash), '..', '..');
  const prefix = [path.dirname(bash), path.join(root, 'cmd')];
  for (const system of ['MINGW64', 'MINGW32', 'UCRT64']) {
    const bin = path.join(root, system.toLowerCase(), 'bin');
    if (fs.existsSync(bin)) { prefix.push(bin); if (!env.MSYSTEM) env.MSYSTEM = system; break; }
  }
  let inherited = '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') { inherited = env[key]; delete env[key]; }
  env.PATH = prefix.filter(p => fs.existsSync(p)).concat(inherited ? [inherited] : []).join(path.delimiter);
  return env;
}

function isSuperDangerous(cmd) {
  if (!cmd) return false;
  const lower = cmd.toLowerCase();
  // NOTE: substring matching - keep patterns specific. Do NOT add patterns like
  // "> /dev" here: it false-positives on the ubiquitous "> /dev/null" redirect.
  const dangerousPatterns = [
    'rm -rf /', 'format c:', 'dd if=', 'mkfs', 'del /f /q c:\\',
    'rd /s /q c:\\',
    // PowerShell equivalents
    'remove-item -recurse -force', 'format-volume', 'stop-computer',
    'clear-disk', 'initialize-disk'
  ];
  return dangerousPatterns.some(p => lower.includes(p));
}

// Request UTF-8 from programs that honor the console codepage. This is not
// a general transcoder: cmd's own redirected errors and some native tools
// can still keep an OEM/ANSI encoder. No PATH lookup is needed for chcp.
function withUtf8Codepage(cmd) {
  return process.platform === 'win32' ? '"%SystemRoot%\\System32\\chcp.com" 65001>nul & ' + cmd : cmd;
}
function findOptionalExecutable(command) {
  const env = process.env || {};
  const rawPath = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const entry of String(rawPath ? env[rawPath] : '').split(path.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of extensions) {
      const file = path.resolve(launchDir, dir, command + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch (e) {}
    }
  }
  return null;
}

function findCSharpCompiler() {
  const onPath = findOptionalExecutable('csc');
  if (onPath) return onPath;
  if (process.platform !== 'win32') return null;
  const env = process.env || {}, root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  if (!root) return null;
  for (const folder of ['Framework64/v4.0.30319', 'Framework/v4.0.30319', 'Framework/v3.5', 'Framework/v2.0.50727']) {
    const file = path.join(root, 'Microsoft.NET', folder, 'csc.exe');
    try { if (fs.statSync(file).isFile()) return file; } catch (e) {}
  }
  return null;
}

function powerShellExecutable() {
  const env = process.env || {};
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  return root ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}
function powerShellSpec(command) {
  // PS2/.NET2 constructors and Console APIs only. UTF-16LE Base64 protects
  // input text; OutputEncoding alone controls pipelines to native commands,
  // so set Console.OutputEncoding as well for the captured host output.
  const prefix = '$OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::OutputEncoding = $OutputEncoding;\r\n';
  // Script-block invocation otherwise masks a final nonterminating error
  // in Windows PowerShell. Preserve -Command's 0/1 default exit semantics;
  // explicit exit N still leaves before this footer and retains N.
  const encoded = Buffer.from(String(command) + '\r\nif (-not $?) { exit 1 }\r\n', 'utf16le').toString('base64');
  // Windows PowerShell's EncodedCommand can initialize a CLIXML stderr
  // serializer before this prefix and keep the old ANSI encoding. Use a
  // fixed ASCII bootstrap instead: only Base64 data is interpolated, and
  // execFile supplies argv directly (no cmd.exe or command quoting).
  return { file: powerShellExecutable(), args: ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command',
    prefix + "& ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encoded + "'))))"] };
}

// AST-09: async child-process runner. The model-facing command tools must
// never block the event loop - under the old exec*Sync calls one long command
// froze HTTP health checks, approvals and cancellation for its whole 5-minute
// timeout. Semantics preserved from the sync versions: cwd=launchDir, 300s
// timeout, 10MB maxBuffer, utf8. `kill` lets a cancelled request stop the OS
// process instead of orphaning it.
function runCommandAsync(spec, opts) {
  let child = null;
  const promise = new Promise(resolve => {
    const base = Object.assign({ encoding: 'utf8', cwd: launchDir, timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, opts || {});
    const done = (error, stdout, stderr) => resolve({
      error, stdout: stdout || '', stderr: stderr || '',
      // Numeric callback codes describe an observed process exit. Kills,
      // signals and spawn/buffer errors do not establish a command exit code.
      exitCode: !error ? 0 : (!error.killed && !error.signal && Number.isInteger(error.code) ? error.code : null)
    });
    try {
      child = spec.args
        ? child_process.execFile(spec.file, spec.args, base, done)
        : child_process.exec(spec.cmd, base, done);
    } catch (e) { resolve({ error: e, stdout: '', stderr: '', exitCode: null }); }
  });
  return { promise, kill: () => { try { if (child) child.kill(); } catch (e) {} } };
}
// Observe cancellation and kill the direct child, but keep awaiting the
// command callback. Process-tree termination remains a separate guarantee.
async function awaitCommandCancellable(runner, cancelled) {
  if (!cancelled) return { r: await runner.promise, aborted: false };
  const detach = watchExecution(cancelled, () => { try { runner.kill(); } catch (e) {} });
  try {
    const r = await runner.promise;
    return { r, aborted: cancelled() };
  } finally { detach(); }
}

// ====================== PERSISTENT SHELL (GAP-2) ======================
// A long-lived bash child per conversation context so cwd/env survive across
// bash_tool calls (the model can `cd` and `export` like a human). Session key:
// main conversation = 'main'; sub-agents and workflow chains get their own
// shells. Output framing: each command is followed by a unique end-marker
// echo; we collect output until the marker line appears, then wait a short
// quiet window for trailing writes. Timeout kills the COMMAND via a fresh
// kill -... in the same shell... but a hung interactive program would eat the
// marker itself - so commands are wrapped in a subshell with `timeout`-like
// enforcement done on OUR side: if the marker never arrives within the limit,
// the whole shell is killed and restarted (state resets; the result says so).
const persistentShells = new Map(); // key -> shell
const SHELL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
function shellSessionKey() {
  // agentDepth/workflowStepDepth are the process globals guarded by the
  // request gate (AST-03); they distinguish sub-agent/workflow contexts.
  if (agentDepth > 0) return 'agent-' + agentDepth;
  if (workflowStepDepth > 0) return 'wf-' + workflowStepDepth;
  return 'main';
}
function createPersistentShell(key, cancelled) {
  const discovered = findBash();
  checkExecution(cancelled);
  if (!discovered) return null;
  const bash = persistentBashExecutable(discovered);
  // NOTE: NOT '-i' - an interactive bash on a pipe (non-TTY) stdin hangs on
  // this platform. A plain non-interactive bash reading commands from the
  // pipe keeps its session state (cwd/env) across writes just the same.
  const child = child_process.spawn(bash, ['--norc', '--noprofile'], {
    cwd: launchDir,
    env: persistentBashEnvironment(bash),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const shell = { key: key, child: child, dead: false, seq: 0, active: null, deadErr: '' };
  function die(reason, code) {
    if (shell.dead) return;
    shell.dead = true;
    shell.deadErr = String(reason);
    if (persistentShells.get(key) === shell) persistentShells.delete(key);
    if (shell.active) shell.active.finish({
      out: '[SHELL] ' + reason + '; result unknown. Check side effects before retrying. Session retired; next call starts a fresh shell (cwd/env reset).\n' + shell.active.out,
      code: code === undefined ? -1 : code, restarted: true
    });
    try { child.stdin.destroy(); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
  function collect(d) {
    const active = shell.active;
    if (shell.dead || !active) return; // background/idle output is not retained
    const bytes = Buffer.byteLength(d, 'utf8');
    if (active.bytes + bytes > SHELL_MAX_OUTPUT_BYTES) { die('output exceeds 8 MB'); return; }
    active.bytes += bytes;
    active.out += d;
    if (active.code === null) {
      const probe = active.tail + d;
      const match = probe.match(new RegExp(active.marker + ' (-?\\d+)(?:\\r?\\n)'));
      active.tail = probe.slice(-(active.marker.length + 40));
      if (match) active.code = parseInt(match[1], 10);
    }
    if (active.code !== null && !active.quiet) {
      active.quiet = setTimeout(() => active.finish({
        out: active.out.replace(new RegExp('\\n?' + active.marker + ' -?\\d+\\r?\\n'), ''),
        code: active.code, restarted: false
      }), 300);
    }
  }
  child.on('error', e => { console.warn('[SHELL] spawn: ' + e.message); die('spawn: ' + e.message); });
  child.on('exit', code => die('shell exited with code ' + code));
  child.on('close', code => die('shell closed with code ' + code));
  shell.dispose = function () { die('disposed'); };
  if (!child.stdin || !child.stdout || !child.stderr) {
    die('stdio unavailable during spawn');
    shell.run = () => Promise.resolve({ out: '[SHELL] ' + shell.deadErr, code: -1, restarted: false });
    return shell;
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.stdin.on('error', e => die('stdin: ' + e.message));
  child.stdout.on('error', e => die('stdout: ' + e.message));
  child.stderr.on('error', e => die('stderr: ' + e.message));
  child.stdout.on('end', () => die('stdout ended'));
  child.stdout.on('close', () => die('stdout closed'));
  shell.run = function (cmd, timeoutMs, cancelled) {
    if (cancelled && cancelled()) return Promise.resolve({ out: '[SHELL] execution cancelled; command not sent.', code: -1, restarted: false });
    if (shell.dead) return Promise.resolve({ out: '[SHELL] session is unavailable: ' + shell.deadErr, code: -1, restarted: false });
    if (shell.active) return Promise.resolve({ out: '[SHELL] session is busy; command not sent.', code: -1, restarted: false });
    const marker = '7CODER-SHELL-END-' + (++shell.seq) + '-' + Date.now();
    // stdin line discipline: trailing newline required, marker echoes the
    // command's exit status so failures are visible. No `set -e`: each call
    // behaves like a fresh command line, only cwd/env persist.
    const wrapped = cmd.replace(/\r?\n$/, '') + '\nprintf "\\n' + marker + ' %s\\n" "$?"\n';
    return new Promise(resolve => {
      let done = false;
      const active = { marker, out: '', tail: '', bytes: 0, code: null, quiet: null, timer: null, finish: null, detach: () => {} };
      active.finish = result => {
        if (done) return;
        done = true;
        if (active.quiet) clearTimeout(active.quiet);
        clearTimeout(active.timer);
        active.detach();
        if (shell.active === active) shell.active = null;
        resolve(result);
      };
      shell.active = active;
      active.timer = setTimeout(() => die('timeout after ' + timeoutMs + 'ms', 124), timeoutMs);
      if (cancelled) active.detach = watchExecution(cancelled, () => die('execution cancelled'));
      if (done) return;
      try {
        checkExecution(cancelled);
        if (child.stdin.destroyed || child.stdin.writableEnded) { die('stdin is closed'); return; }
        child.stdin.write(wrapped, error => { if (error) die('stdin write: ' + error.message); });
      } catch (e) {
        die('stdin write: ' + e.message);
      }
    });
  };
  return shell;
}
function getPersistentShell(key, cancelled) {
  checkExecution(cancelled);
  let sh = persistentShells.get(key);
  if (!sh || sh.dead) {
    const previous = sh;
    sh = createPersistentShell(key, cancelled);
    if (!sh) return null;
    if (!sh.dead) persistentShells.set(key, sh);
    else if (persistentShells.get(key) === previous) persistentShells.delete(key);
  }
  return sh;
}
function disposePersistentShell(key) {
  const shell = persistentShells.get(key);
  if (!shell) return;
  try { shell.dispose(); }
  catch (error) { console.warn('[SHELL] Dispose failed for ' + key + ': ' + error.message); }
  finally { if (persistentShells.get(key) === shell) persistentShells.delete(key); }
}
function disposePersistentShells() {
  for (const key of Array.from(persistentShells.keys())) disposePersistentShell(key);
}

// Converts a glob pattern to an anchored case-insensitive regex with standard
// semantics: `**` spans directory separators, `*` and `?` stay within one
// segment, everything else is escaped literally. Backslashes in the pattern
// are treated as separators (Windows users type `src\*.js`).
function globToRegex(pattern) {
  const norm = String(pattern).split('\\').join('/');
  if (norm.length > 4096) throw new Error('glob pattern exceeds 4096 characters; narrow the pattern');
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

// P2-3: heavy directories that model-side scans never descend into when the
// budget is on. Internal callers (pruneBackups) pass no opts and keep the
// verbatim unbounded walk.
const SCAN_SKIP_DIRS = ['node_modules', '.git', 'dist', '.cache'];

// P2-3: budget knobs are opt-in via opts; every knob defaults to "off", so a
// no-opts call reproduces the legacy walk exactly (no skips, no caps) -
// pruneBackups (.7coder/backups pruning) depends on that verbatim.
//   skipHeavy  - never descend into SCAN_SKIP_DIRS
//   maxDepth   - recursion depth cap (start dir = depth 0)
//   maxEntries - at most N matches / 4N visited directory entries; match,
//                visit, depth and IO limits are surfaced as explicit markers
//   deadlineAt / cancelled - check caller control between IO; opts also cap
//                traversal at 5s. Each glob regex test has at most 100ms.
function recursiveReaddir(dir = '', pattern = '', opts = null) {
  const skipHeavy = !!opts && !!opts.skipHeavy;
  const maxDepth = opts ? (Number.isFinite(opts.maxDepth) ? Math.max(0, Math.min(12, Math.floor(opts.maxDepth))) : 12) : Infinity;
  const maxEntries = opts ? (Number.isFinite(opts.maxEntries) ? Math.max(0, Math.min(1000, Math.floor(opts.maxEntries))) : 1000) : Infinity;
  // A2-20: budgeted walks also cap how many entries they VISIT (maxEntries
  // alone counted matches - a no-match walk could still scan the whole tree)
  // and keep a real-path visited set so junction cycles cannot loop the walk.
  const maxVisited = opts ? maxEntries * 4 : Infinity;
  const budgeted = !!opts;
  const scanDeadline = budgeted ? Math.min(Date.now() + 5000, Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : Infinity) : Infinity;
  const visited = new Set();
  let visitedCount = 0;
  const results = [];
  const incomplete = new Set();
  const startDir = dir ? path.join(launchDir, sanitizePath(dir)) : launchDir;
  let rx = null;
  if (pattern) rx = globToRegex(pattern);
  const matchContext = rx ? vm.createContext({ rx, value: '' }) : null;
  const matchScript = rx ? new vm.Script('rx.test(value)') : null;
  const checkScan = () => {
    if (opts && opts.cancelled && opts.cancelled()) throw executionCancelledError(opts.cancelled);
    if (Date.now() >= scanDeadline) { incomplete.add('time budget exhausted'); return false; }
    return true;
  };
  // Path-aware semantics only for patterns that NAME a path (contain a
  // separator or **). Plain patterns like *.js keep matching basenames at any
  // depth - the pre-existing behavior and the most common search intent.
  const pathAware = pattern && (pattern.indexOf('/') >= 0 || pattern.indexOf('\\') >= 0 || pattern.indexOf('**') >= 0);
  function walk(current, depth) {
    if (!checkScan()) return;
    if (results.length >= maxEntries) return;
    if (budgeted) {
      let realCur;
      try { realCur = fs.realpathSync(current); } catch (e) { incomplete.add('unreadable path (' + e.code + ')'); return; }
      if (visited.has(realCur)) return;
      visited.add(realCur);
    }
    let reader;
    if (!checkScan()) return;
    try { reader = openScanDirectory(current, budgeted); } catch (e) { if (budgeted) incomplete.add('unreadable directory (' + e.code + ')'); return; }
    const next = () => { if (!checkScan()) return null; try { return reader.next(); } catch (e) { if (budgeted) incomplete.add('unreadable directory (' + e.code + ')'); return null; } };
    try { for (let entry = next(); entry !== null; entry = next()) {
      if (!checkScan()) return;
      if (results.length >= maxEntries) return;
      if (budgeted && visitedCount >= maxVisited) { incomplete.add('visit limit ' + maxVisited); return; }
      visitedCount++;
      const full = path.join(current, entry);
      // Do not traverse/read through links that leave the workspace.
      if (!linkStaysInside(full)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { if (budgeted) incomplete.add('unreadable entry (' + e.code + ')'); continue; }
      if (stat.isDirectory()) {
        if (skipHeavy && SCAN_SKIP_DIRS.indexOf(entry) >= 0) continue;
        if (depth >= maxDepth) { incomplete.add('depth limit ' + maxDepth); continue; }
        walk(full, depth + 1);
        if (visitedCount >= maxVisited && incomplete.has('visit limit ' + maxVisited)) return;
      } else {
        const rel = path.relative(launchDir, full);
        let isMatch = false;
        if (!pattern) {
          isMatch = true;
        } else if (rx) {
          if (!checkScan()) return;
          matchContext.value = pathAware ? rel.split(path.sep).join('/') : entry;
          const budget = Math.max(1, Math.min(100, Math.floor(scanDeadline - Date.now())));
          try { isMatch = matchScript.runInContext(matchContext, { timeout: budget }); }
          catch (e) {
            throw new Error('glob matching failed at ' + rel + (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? ' (' + budget + 'ms matching budget exceeded)' : ' (' + e.message + ')'));
          } finally { matchContext.value = ''; }
        }
        if (isMatch) {
          results.push(rel);
          if (results.length >= maxEntries) return;
        }
      }
    } } finally { try { reader.close(); } catch (e) { if (budgeted) incomplete.add('directory close failed (' + e.code + ')'); } }
  }
  walk(startDir, 0);
  if (results.length >= maxEntries) results.push('[truncated at ' + maxEntries + ' entries]');
  else if (incomplete.size) results.push('[scan incomplete: ' + Array.from(incomplete).join('; ') + ']');
  return results;
}

// P2-3: grep budgets: traversal limits are opt-in via opts. No opts keeps the legacy
// whole-file match semantics, but every match execution is limited to 100ms.
// When an opts object is passed the following additional caps apply:
//   skipHeavy          - skip SCAN_SKIP_DIRS, files > 2MB and binary content
//                        (first 4096 bytes containing NUL)
//   maxFiles           - stop after N files actually scanned (default 5000),
//                        appending '[truncated after N files scanned]'
//   maxMatchesPerFile  - cap the matching lines counted per file at N
//                        (default 50), adding '... (more matches in this file)'
//   maxVisited / maxDepth - cap all directory entries (including skipped or
//                        unreadable files), default 4*maxFiles / 12
//   deadlineAt         - optional caller deadline; scan also stops after 5s
function grepSearch(pattern, searchPath = '', opts = null) {
  checkExecution(opts && opts.cancelled);
  const budgeted = !!opts;
  const skipHeavy = budgeted && !!opts.skipHeavy;
  const limit = (key, fallback, ceiling) => Number.isFinite(opts[key]) ? Math.max(0, Math.min(ceiling, Math.floor(opts[key]))) : fallback;
  const maxFiles = budgeted ? limit('maxFiles', 5000, 5000) : Infinity;
  const perFileCap = budgeted ? limit('maxMatchesPerFile', 50, 50) : Infinity;
  const maxVisited = budgeted ? limit('maxVisited', maxFiles * 4, 20000) : Infinity;
  const maxDepth = budgeted ? limit('maxDepth', 12, 12) : Infinity;
  const results = [];
  const incomplete = new Set();
  const scanDeadline = budgeted ? Math.min(Date.now() + 5000, Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : Infinity) : Infinity;
  let matchError = null;
  const startDir = searchPath ? path.join(launchDir, sanitizePath(searchPath)) : launchDir;
  // A2-20: an evil pattern (a quantified group that itself contains a
  // quantifier - (a+)+, (\d+)+, ([a-z]+)*) turns line matching into a
  // catastrophic-backtracking CPU bomb on the main thread. Reject the
  // classic shapes outright; cap pattern length too. Best-effort lint, not
  // a sandbox (deeply nested groups can still slip past).
  if (String(pattern).length > 200) return 'Tool error: grep pattern too long (max 200 chars)';
  if (/\([^()]*[+*][^()]*\)[+*]/.test(String(pattern))) {
    return 'Tool error: grep pattern contains nested quantifiers (catastrophic backtracking risk) - simplify it';
  }
  let rx = null;
  try {
    rx = new RegExp(pattern, 'i');
  } catch (e) {
    rx = null;
  }
  // The lint above cannot prove an arbitrary regex is linear: (a|aa)+$
  // passes it and can block Node's event loop. Keep the code constant and
  // pass only regex/string data into a Node13-supported timed VM execution.
  const matchContext = vm.createContext({ rx, needle: String(pattern).toLowerCase(), content: '', budgeted, perFileCap });
  const matchScript = new vm.Script(String.raw`
    var lines = budgeted ? content.split(/\r?\n/) : [content];
    var count = 0;
    for (var i = 0; i < lines.length; i++) {
      if (count > perFileCap) break;
      if (rx ? rx.test(lines[i]) : lines[i].toLowerCase().includes(needle)) count++;
    }
    count;
  `);
  let scanned = 0;
  let visitedCount = 0;
  const visited = new Set(); // A2-20: junction cycles must not loop the walk
  function scanFile(full, stat, explicit) {
    checkExecution(opts && opts.cancelled);
    if (Date.now() >= scanDeadline) { incomplete.add('time budget exhausted'); return; }
    if (skipHeavy && stat.size > 2 * 1024 * 1024) {
      if (explicit) incomplete.add('file exceeds 2MiB limit');
      return;
    }
    try {
      const buf = budgeted ? readFileBytesBounded(full, skipHeavy ? 2 * 1024 * 1024 : 8 * 1024 * 1024, 'Grep input') : fs.readFileSync(full);
      checkExecution(opts && opts.cancelled);
      if (skipHeavy) {
        const probe = Math.min(buf.length, 4096);
        for (let i = 0; i < probe; i++) {
          if (buf[i] === 0) { if (explicit) incomplete.add('binary file skipped'); return; }
        }
      }
      const content = buf.toString('utf8');
      matchContext.content = content;
      let matchedLines;
      const matchBudget = Math.max(1, Math.min(100, scanDeadline - Date.now()));
      try { matchedLines = matchScript.runInContext(matchContext, { timeout: matchBudget }); }
      catch (error) {
        matchError = 'Tool error: grep matching failed at ' + path.relative(launchDir, full) +
          (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? ' (' + matchBudget + 'ms matching budget exceeded)' : ' (' + error.message + ')') +
          '; scan stopped. Simplify the pattern or search a smaller file.';
        return;
      } finally { matchContext.content = ''; }
      if (!budgeted) {
        if (matchedLines) results.push(`${path.relative(launchDir, full)}: matches "${pattern}"`);
        return;
      }
      scanned++;
      if (matchedLines > 0) {
        results.push(`${path.relative(launchDir, full)}: matches "${pattern}"`);
        if (matchedLines > perFileCap) results.push('... (more matches in this file)');
      }
    } catch (e) { checkExecution(opts && opts.cancelled); incomplete.add('unreadable file (' + (e.code || String(e.message).slice(0, 200)) + ')'); }
  }
  function walk(current, depth) {
    if (matchError) return;
    if (Date.now() >= scanDeadline) { incomplete.add('time budget exhausted'); return; }
    if (scanned >= maxFiles) return;
    let realCur;
    try { realCur = fs.realpathSync(current); } catch (e) { incomplete.add('unreadable path (' + e.code + ')'); return; }
    if (visited.has(realCur)) return;
    visited.add(realCur);
    let reader;
    try { reader = openScanDirectory(current, budgeted); } catch (e) { incomplete.add('unreadable directory (' + e.code + ')'); return; }
    const next = () => { checkExecution(opts && opts.cancelled); if (Date.now() >= scanDeadline) { incomplete.add('time budget exhausted'); return null; } try { return reader.next(); } catch (e) { incomplete.add('unreadable directory (' + e.code + ')'); return null; } };
    try { for (let entry = next(); entry !== null; entry = next()) {
      if (matchError) return;
      if (Date.now() >= scanDeadline) { incomplete.add('time budget exhausted'); return; }
      if (scanned >= maxFiles) return;
      if (visitedCount >= maxVisited) { incomplete.add('visit limit ' + maxVisited); return; }
      visitedCount++;
      const full = path.join(current, entry);
      // Do not read through links that leave the workspace.
      if (!linkStaysInside(full)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { incomplete.add('unreadable entry (' + e.code + ')'); continue; }
      if (stat.isDirectory()) {
        if (skipHeavy && SCAN_SKIP_DIRS.indexOf(entry) >= 0) continue;
        if (depth >= maxDepth) { incomplete.add('depth limit ' + maxDepth); continue; }
        walk(full, depth + 1);
        if (visitedCount >= maxVisited && incomplete.has('visit limit ' + maxVisited)) return;
      } else {
        scanFile(full, stat, false);
      }
    } } finally { try { reader.close(); } catch (e) { incomplete.add('directory close failed (' + e.code + ')'); } }
  }
  let startStat;
  try {
    if (!linkStaysInside(startDir)) return 'Tool error: grep path leaves the workspace';
    startStat = fs.statSync(startDir);
  } catch (e) { return 'Tool error: cannot open grep path: ' + searchPath + ' (' + e.code + ')'; }
  if (startStat.isDirectory()) walk(startDir, 0);
  else if (startStat.isFile()) scanFile(startDir, startStat, true);
  else return 'Tool error: grep path must be a regular file or directory';
  if (matchError) return matchError;
  if (budgeted && scanned >= maxFiles) results.push(`[truncated after ${maxFiles} files scanned]`);
  if (incomplete.size) results.push('[scan incomplete: ' + Array.from(incomplete).join('; ') + ']');
  return results.length ? results.join('\n') : `No matches for pattern: ${pattern}`;
}

// Keep the handle until close (exit alone does not close inherited pipes).
// Win32 taskkill remains best effort, only while the direct child is known
// live. Its PID-reuse race requires native Job Object ownership to eliminate.
const ownedChildStates = new WeakMap();
function observeOwnedChild(child, scope = 'child', id = '') {
  let state = ownedChildStates.get(child);
  if (state) return state;
  state = { exited: child.exitCode != null || child.signalCode != null, closed: false, error: null, waiters: new Set(), stopping: null };
  ownedChildStates.set(child, state);
  const closed = (code, signal) => {
    if (state.closed) return;
    state.closed = true;
    recordRuntimeEvent(scope, code === 0 && !state.error ? 'ok' : 'error', { id, pid: child.pid, exitCode: code, signal,
      code: state.error && state.error.code, path: state.error && state.error.path, syscall: state.error && state.error.syscall,
      message: state.error ? state.error.message : 'Direct child closed; descendant state is unverified.' });
    for (const notify of Array.from(state.waiters)) notify();
    state.waiters.clear();
  };
  child.once('exit', () => { state.exited = true; });
  child.once('close', closed);
  child.on('error', error => {
    state.error = error;
    recordRuntimeEvent(scope, 'error', { id, pid: child.pid, message: error.message, code: error.code, path: error.path, syscall: error.syscall });
    // Node 13 EMFILE/ENFILE may omit stdio and close. No child was created.
    if (!child.pid) closed();
  });
  return state;
}

function stopOwnedChild(child, timeoutMs = 5000) {
  if (!child) return Promise.resolve({ closed: true, message: 'No active direct child.' });
  const state = observeOwnedChild(child);
  if (state.closed) return Promise.resolve({ closed: true, message: 'Direct child already closed.' });
  if (state.stopping) return state.stopping;
  let settle, timer, killError = '';
  const promise = new Promise(resolve => { settle = resolve; });
  state.stopping = promise;
  const finish = () => {
    clearTimeout(timer);
    state.waiters.delete(finish);
    state.stopping = null;
    settle({ closed: state.closed, message: state.closed ? 'Direct child closed; descendant state is unverified.' :
      'Direct child close unconfirmed; result unknown. ' + (killError || 'Close deadline exceeded.') });
  };
  state.waiters.add(finish);
  timer = setTimeout(finish, timeoutMs);
  if (!state.exited && child.exitCode == null && child.signalCode == null && !child.killed) {
    try {
      if (process.platform === 'win32' && child.pid) {
        child_process.execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: Math.max(1, timeoutMs - 500), maxBuffer: 65536 }, error => {
            if (error) killError = 'Tree stop attempt failed: ' + error.message;
          });
      } else if (!child.kill('SIGTERM')) killError = 'Stop request was refused.';
    }
    catch (error) { killError = error.message; }
  }
  return promise;
}

async function stopBackgroundTask(task) {
  task.stopRequested = true;
  task.status = 'stopping';
  const result = await stopOwnedChild(task.child);
  task.status = result.closed ? (task.outputExceeded ? 'failed' : 'stopped') : 'stop-unknown';
  task.endedAt = result.closed ? new Date().toISOString() : null;
  task.stopMessage = result.message;
  pruneTasks();
  return result;
}

async function stopCronJob(job) {
  job.stopped = true;
  if (job.timer) clearTimeout(job.timer);
  job.timer = null;
  const result = await stopOwnedChild(job.child);
  if (!result.closed) job.lastError = result.message;
  return result;
}

function appendTaskOutput(task, text) {
  const tail = Buffer.from(String(text), 'utf8');
  const prior = Buffer.from(task.output, 'utf8');
  let combined;
  if (tail.length >= TASK_OUTPUT_TAIL) combined = tail;
  else combined = Buffer.concat([prior, tail]);
  let offset = Math.max(0, combined.length - TASK_OUTPUT_TAIL);
  if (offset) {
    task.outputTruncated = true;
    // Start on a complete UTF-8 character, never a continuation byte.
    while (offset < combined.length && (combined[offset] & 0xc0) === 0x80) offset++;
  }
  if (tail.length >= TASK_OUTPUT_TAIL && prior.length) task.outputTruncated = true;
  task.output = combined.slice(offset).toString('utf8');
}

function captureTaskOutput(task, text) {
  if (task.outputExceeded) return; // keep draining streams without retaining
  task.outputBytes = Math.min(TASK_OUTPUT_LIMIT + 1, task.outputBytes + Buffer.byteLength(text, 'utf8'));
  appendTaskOutput(task, text);
  if (task.outputBytes > TASK_OUTPUT_LIMIT) {
    task.outputExceeded = true;
    appendTaskOutput(task, '\n[Task failed] Combined stdout/stderr exceeded 8 MB; stop requested, check side effects.\n');
    stopBackgroundTask(task).catch(error => console.warn('[TASK] Output-limit stop: ' + error.message));
  }
}

// ====================== CRON SCHEDULING ======================
// Supported schedules: "30s", "5m", "2h", "every 10m", "daily 09:30" (or just "09:30").
function parseSchedule(schedule) {
  const s = String(schedule || '').trim().toLowerCase();
  let m;
  if ((m = s.match(/^(?:every\s+)?(\d+)\s*(s|sec|secs|seconds)$/))) return { kind: 'interval', ms: Math.max(1000, parseInt(m[1], 10) * 1000) };
  if ((m = s.match(/^(?:every\s+)?(\d+)\s*(m|min|mins|minutes)$/))) return { kind: 'interval', ms: Math.max(60000, parseInt(m[1], 10) * 60000) };
  if ((m = s.match(/^(?:every\s+)?(\d+)\s*(h|hr|hrs|hours)$/))) { const h = parseInt(m[1], 10); if (h <= 0) return null; return { kind: 'interval', ms: h * 3600000 }; }
  if ((m = s.match(/^(?:daily|everyday)\s+(\d{1,2}):(\d{2})$/)) || (m = s.match(/^(\d{1,2}):(\d{2})$/))) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour < 24 && minute < 60) return { kind: 'daily', hour, minute };
  }
  return null;
}

function scheduleCronJob(jobId, schedule, command) {
  if (shuttingDown) return '[ERROR] Cron refused: 7coder is shutting down.';
  if (cronJobs.has(jobId)) return '[ERROR] Cron id already exists: ' + jobId;
  if (cronJobs.size >= CRON_MAX_JOBS) return '[ERROR] Cron limit reached (' + CRON_MAX_JOBS + '); delete a job first.';
  if (typeof command !== 'string' || !command.trim() || command.length > 32768) return '[ERROR] Cron requires a nonempty command up to 32768 characters.';
  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return `[ERROR] Unsupported schedule "${schedule}". Supported formats: "30s", "5m", "2h", "every 10m", "daily 09:30".`;
  }
  const job = { schedule, command, parsed, nextRun: null, timer: null, runs: 0, lastError: null, stopped: false, running: false, child: null };
  const runCommand = () => {
    // NEW-2: skip missed ticks while this job is still executing. Other jobs
    // keep their own slots; do not queue a burst of catch-up commands.
    if (shuttingDown || job.stopped || job.running) return;
    job.runs++;
    // OP2-2: re-check at FIRE time too - the job was vetted when created,
    // but isSuperDangerous patterns or the command string must not run just
    // because they passed an older, narrower gate (config drift defense).
    if (isSuperDangerous(command)) {
      job.lastError = 'BLOCKED at fire time: super-dangerous command.';
      return;
    }
    job.running = true;
    try {
      job.child = child_process.exec(withUtf8Codepage(command), { cwd: launchDir, timeout: 300000 }, (err) => {
        if (err) job.lastError = err.message;
      });
      const child = job.child;
      const state = observeOwnedChild(child, 'cron-child', jobId);
      const release = () => {
        if (job.child !== child) return;
        job.child = null;
        job.running = false;
      };
      if (state.closed) release();
      else state.waiters.add(release);
    } catch (err) {
      job.lastError = err.message;
      job.child = null;
      job.running = false;
    }
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
// P2-1: bookkeeping files moved from the workspace root into .7coder/ (one
// place for all 7coder state). Read paths fall back to the legacy root
// location once; migrateWorkspaceRootFiles() renames legacy files at startup.
function getLastInteractionTime() {
  const locations = [() => internalStatePath('.7coder', 'last_interaction'), () => managedWorkspacePath('.7coder_last_interaction')];
  for (const location of locations) {
    try {
      const content = decodeUtf8Text(readFileBytesBounded(location(), 1024, 'Last interaction time')).trim();
      const time = Number(content);
      if (!/^\d+$/.test(content) || !Number.isSafeInteger(time)) throw new Error('invalid last interaction timestamp');
      return time;
    } catch (e) {
      if (e.code === 'ENOENT') continue; // only absence may fall back to legacy
      console.warn('[WARN] automatic dream deferred; last interaction unavailable: ' + e.message);
      return Date.now();
    }
  }
  return 0; // both layouts absent: no prior interaction
}

function updateLastInteractionTime() {
  try {
    const dir = internalStatePath('.7coder');
    fs.mkdirSync(dir, { recursive: true });
    writeStateFile(internalStatePath('.7coder', 'last_interaction'), Date.now().toString());
  } catch (e) { console.warn('[WARN] last interaction save failed: ' + e.message); }
}

function parseBtwMigrationState(text) {
  const j = parseStateJson(text), digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!j || j.kind !== '7coder-btw-migration-v1' || !digest(j.sourceHash) || !digest(j.afterTargetHash) ||
      !(j.beforeTargetHash === null || digest(j.beforeTargetHash)) ||
      !Number.isSafeInteger(j.sourceBytes) || j.sourceBytes < 0 || j.sourceBytes > stateFileByteLimit() ||
      !Number.isSafeInteger(j.afterTargetBytes) || j.afterTargetBytes < 0 || j.afterTargetBytes > stateFileByteLimit()) throw new Error('invalid BTW migration journal');
  return j;
}
function migrateLegacyBtw() {
  const source = managedWorkspacePath('BTW.md'), target = internalStatePath('.7coder', 'BTW.md'), journal = internalStatePath('.7coder', 'btw-migration.json');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const saved = readStateRecord(journal, parseBtwMigrationState);
  let sourceBytes = null, sourceStat = null;
  try {
    sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile()) throw new Error('Legacy BTW source must be a regular file, not a link/directory');
    sourceBytes = readFileBytesBounded(source, stateFileByteLimit(), 'Legacy BTW notes');
  }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!saved && sourceBytes === null) return false;
  let current = readStateRecord(target), currentHash = current ? hash(current.bytes) : null, record = saved && saved.value;
  if (sourceBytes !== null && current) {
    const stat = fs.statSync(target);
    if (sourceStat.ino && sourceStat.ino === stat.ino && sourceStat.dev === stat.dev) throw new Error('BTW migration source and target refer to the same file; files retained');
  }
  if (!record) {
    const proposed = (current ? current.value : '') + decodeUtf8Text(sourceBytes);
    if (Buffer.byteLength(proposed, 'utf8') > stateFileByteLimit()) throw fileByteLimitError('Merged BTW notes', stateFileByteLimit());
    const after = Buffer.from(proposed, 'utf8');
    record = { kind: '7coder-btw-migration-v1', sourceHash: hash(sourceBytes), sourceBytes: sourceBytes.length,
      beforeTargetHash: currentHash, afterTargetHash: hash(after), afterTargetBytes: after.length };
    // Publish intent before touching the target. Content hashes distinguish a
    // pending append from a committed append after unlink/crash/cleanup failure.
    writeStateFile(journal, JSON.stringify(record), parseBtwMigrationState, null);
  }
  if (sourceBytes === null) {
    if (currentHash !== record.afterTargetHash || current.bytes.length !== record.afterTargetBytes) throw new Error('BTW migration conflict: source absent and target does not match committed content; journal retained');
    deleteStateFile(journal); return true;
  }
  if (sourceBytes.length !== record.sourceBytes || hash(sourceBytes) !== record.sourceHash) throw new Error('BTW migration conflict: legacy source changed; original files and journal retained');
  if (currentHash !== record.afterTargetHash) {
    if (currentHash !== record.beforeTargetHash) throw new Error('BTW migration conflict: target changed; original files and journal retained');
    const proposed = (current ? current.value : '') + decodeUtf8Text(sourceBytes), bytes = Buffer.from(proposed, 'utf8');
    if (bytes.length !== record.afterTargetBytes || hash(bytes) !== record.afterTargetHash) throw new Error('BTW migration conflict: proposed content differs from journal');
    writeStateFile(target, proposed, parseStateText, current ? current.bytes : null);
    current = readStateRecord(target); currentHash = current ? hash(current.bytes) : null;
  }
  if (currentHash !== record.afterTargetHash || !current || current.bytes.length !== record.afterTargetBytes) throw new Error('BTW migration conflict: committed target could not be verified');
  const latest = readFileBytesBounded(source, stateFileByteLimit(), 'Legacy BTW notes');
  if (latest.length !== record.sourceBytes || hash(latest) !== record.sourceHash) throw new Error('BTW migration conflict: legacy source changed before cleanup');
  fs.unlinkSync(source); // failure leaves journal: next startup must not append again
  deleteStateFile(journal);
  return true;
}

// P2-1: one-time migration of the three legacy workspace-root files into
// .7coder/. Idempotent: only fires when the old file exists (last_interaction /
// dream.lock: and the new one does not; BTW.md: appended into the new file so
// nothing is lost, then removed). Called once at the top of main().
function migrateWorkspaceRootFiles() {
  const dotDir = internalStatePath('.7coder');
  const ensureDot = () => { try { fs.mkdirSync(dotDir, { recursive: true }); } catch (e) {} };
  try {
    const oldLast = path.join(launchDir, '.7coder_last_interaction');
    const newLast = path.join(dotDir, 'last_interaction');
    if (fs.existsSync(oldLast) && !fs.existsSync(newLast)) {
      ensureDot();
      fs.renameSync(oldLast, newLast);
    }
  } catch (e) {}
  try {
    const oldLock = path.join(launchDir, '7C.dream.lock');
    const newLock = path.join(dotDir, 'dream.lock');
    if (fs.existsSync(oldLock) && !fs.existsSync(newLock)) {
      ensureDot();
      fs.renameSync(oldLock, newLock); // rename preserves mtime for the stale-lock check
    }
  } catch (e) {}
  try {
    migrateLegacyBtw();
  } catch (e) { console.warn('[WARN] BTW migration stopped; inspect retained source/target/journal: ' + e.message); }
}

function releaseOwnedDreamLock(owner = triggerDreamIfNeeded.owner) {
  if (!owner) return false;
  try {
    const lockPath = internalStatePath('.7coder', 'dream.lock');
    if (decodeUtf8Text(readFileBytesBounded(lockPath, 4096, 'Dream lock')) !== owner) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[WARN] dream lock cleanup failed: ' + e.message);
    return false;
  }
}

async function triggerDreamIfNeeded(modelContext, execution) {
  if (triggerDreamIfNeeded.owner || shuttingDown) return false;
  triggerDreamIfNeeded.lastOutcome = 'skipped';
  if (!DREAM_ALLOW) return false;
  checkExecution(execution);
  const lastTime = getLastInteractionTime();
  const hoursSince = (Date.now() - lastTime) / (1000 * 60 * 60);
  const lockPath = internalStatePath('.7coder', 'dream.lock');
  if (hoursSince < 5) return false;
  // The workspace lease excludes another current Agent. Recognized locks
  // from a previous owner can therefore recover immediately; legacy locks
  // retain their existing four-hour grace period.
  try {
    if (fs.existsSync(lockPath)) {
      let recognized = false;
      try { recognized = JSON.parse(decodeUtf8Text(readFileBytesBounded(lockPath, 4096, 'Dream lock'))).kind === '7coder-dream-owner-v1'; } catch (e) {}
      if (recognized || Date.now() - fs.statSync(lockPath).mtimeMs > 4 * 60 * 60 * 1000) fs.unlinkSync(lockPath);
    }
  } catch (e) {}
  if (fs.existsSync(lockPath)) return false;

  checkExecution(execution);
  console.log(`[DREAM] 7coder is ${getRandomSpinner()} [DREAM MODE - self-consolidation]`);
  // A2-08: a brand-new workspace has no .7coder/ yet - create it before the
  // lock write, otherwise the dream path dies with ENOENT (the write below is
  // not otherwise guarded, and triggerDreamIfNeeded has no try/catch around it).
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner = JSON.stringify({ kind: '7coder-dream-owner-v1', pid: process.pid, nonce: crypto.randomBytes(16).toString('hex') });
  fs.writeFileSync(lockPath, owner, { flag: 'wx' });
  triggerDreamIfNeeded.owner = owner;
  const cancelled = execution || createExecutionControl();
  try {
    const completed = await runDreamSession(modelContext, cancelled);
    triggerDreamIfNeeded.lastOutcome = cancelled() ? 'cancelled' : (completed ? 'completed' : 'failed');
    if (completed) { checkExecution(cancelled); updateLastInteractionTime(); }
    return true;
  } finally {
    if (!execution) cancelled.dispose();
    releaseOwnedDreamLock(owner);
    triggerDreamIfNeeded.owner = null;
  }
}

async function runDreamSession(modelContext, cancelled) {
  const mdPath = managedWorkspacePath('7CODER.md');
  let currentContent = 'No prior content.';
  try {
    const record = readStateRecord(mdPath);
    if (record) currentContent = record.value || currentContent;
  } catch (e) {
    console.warn('[DREAM] source notes unavailable; consolidation skipped: ' + e.message);
    return false;
  }
  const dreamSystemPrompt = `${systemPrompt}
[DREAM MODE OVERRIDE - SELF-CONSOLIDATION SESSION WITH AN EXECUTION DEADLINE]
You are now in a dedicated deep organization session for 7CODER.md.
Rules (strict, no exceptions):
- NO lazy summaries ("Fix this bug later", "Improve X", etc.). Be hyper-detailed and descriptive.
- Target YOURSELF only: "I (7coder) will implement [exact change] because [reason]. Full self-plan: step-by-step...".
- Never generalize to user or use irrelevant examples (e.g. no "how to make toast").
- Reorganize everything into clean sections, priorities, full code blocks where relevant.
- At the end of the tool chain, use write_file with path="7CODER.md" and the COMPLETE new organized content (full file, no truncation).`;
  // GAP-9: dream also sees the memory index - it may rewrite stale notes via
  // write_file (auto-safe under .7coder/memory/), but the mandatory target
  // stays 7CODER.md so the existing dream contract is unchanged.
  const memTopics = listMemoryTopics();
  const memNote = memTopics.length
    ? `\n\nMemory notes on disk (${memTopics.join(', ')}): after writing 7CODER.md you MAY also rewrite any of these via write_file to .7coder/memory/<topic>.md if consolidation improves them - skip them otherwise.`
    : '';
  const dreamUserPrompt = `Begin the DREAM SESSION. Consolidate this content:\n\n${currentContent}${memNote}`;
  const dreamMessages = [
    { role: 'system', content: dreamSystemPrompt },
    { role: 'user', content: dreamUserPrompt }
  ];
  console.log('Dreaming deeply (self-consolidation in progress)...');
  try {
    await processWithTools(dreamMessages, { modelContext, cancel: cancelled });
    checkExecution(cancelled);
    console.log('[OK] Dream consolidation complete.');
    return true;
  } catch (e) {
    // A2-08: a failed consolidation must NEVER overwrite 7CODER.md - the old
    // fallback destroyed the user's whole memory file on a transient API error.
    console.error('[DREAM] consolidation failed - original 7CODER.md preserved: ' + e.message);
    return false;
  }
}

// ====================== VISION HELPER ======================
async function describeWithVision(imageUrl, modelContext, cancelled) {
  checkExecution(cancelled);
  if (!VISION_MODEL) {
    return makeToolResult('error', `[IMAGE] Image at ${imageUrl} - (VISION_MODEL not set in .env - configure it to enable vision)`);
  }
  try {
    if (typeof imageUrl !== 'string' || !imageUrl.trim()) throw new Error('Vision image URL must be a nonempty string');
    if (Buffer.byteLength(imageUrl, 'utf8') > 6 * 1024 * 1024) throw fileByteLimitError('Vision image URL', 6 * 1024 * 1024);
    const mcfg = (modelContext && modelContext.routes[String(VISION_MODEL).toLowerCase()]) || resolveModelConfig(VISION_MODEL);
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
    const response = await executionHttp({ method: 'post', url: `${base}/chat/completions`, data: payload,
      headers: authHeadersFor(mcfg.apiKey),
      maxBodyLength: MODEL_RESPONSE_MAX_BYTES,
      maxContentLength: MODEL_RESPONSE_MAX_BYTES,
      timeout: 30000
    }, cancelled);
    const content = response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message && response.data.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Vision response has no text content');
    return makeToolResult('ok', content.trim());
  } catch (e) {
    if (cancelled && cancelled()) throw e;
    return makeToolResult('error', `Vision error: ${e.message}`);
  }
}

// GAP-4: read a screenshot back as a data URL so it can be fed straight to an
// OpenAI-compatible vision model (describeWithVision accepts any URL, and data
// URLs are valid image_url values). Keep null-on-error for optional callers;
// a requested vision operation uses strict mode so missing analysis is visible.
function screenshotToDataUrl(p, strict = false) {
  try {
    const buf = readFileBytesBounded(p, 4 * 1024 * 1024, 'Screenshot image');
    if (buf.length < 8 || !buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot image has no PNG signature');
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) {
    if (strict) throw e;
    return null;
  }
}

function readWorkspaceCommand(name) {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error('Invalid workspace command name');
  let raw;
  try { raw = decodeUtf8Text(readFileBytesBounded(internalStatePath('.7coder/commands', name + '.md'), 64 * 1024, 'Workspace command')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const expanded = raw.trim();
  if (!expanded) throw new Error('Workspace command is empty');
  return expanded;
}

function configPathForOpen() {
  const exists = file => {
    try { if (!fs.statSync(file).isFile()) throw new Error('Configuration path is not a regular file: ' + file); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  };
  const workspace = managedWorkspacePath('.env');
  if (exists(workspace)) return workspace;
  const installed = guardStateFile(path.join(appDir, '.env'));
  if (exists(installed)) return installed;
  const template = decodeUtf8Text(readFileBytesBounded(path.join(appDir, '.env.example'), 1024 * 1024, 'Configuration template'));
  writeStateFile(workspace, template);
  return workspace;
}

function launchDesktopPath(openPath, target, timeoutMs = 5000) {
  const active = launchDesktopPath.active || (launchDesktopPath.active = new Set());
  const waitMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(5000, Math.floor(timeoutMs))) : 5000;
  if (active.size >= 4) return Promise.resolve({ status: 'busy', pid: null, exitCode: null, signal: null,
    error: { code: 'OPEN_BUSY', message: 'Four desktop launchers still await close; inspect them before another request.' } });
  return new Promise(resolve => {
    let child, timer, settled = false, outcome, exitCode = null, signal = null;
    const finish = (status, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      outcome = { status, pid: child && child.pid || null, exitCode, signal,
        error: error ? { code: runtimeText(error.code, 40), message: runtimeText(error.message) } : null };
      recordRuntimeEvent('open-launcher', status === 'accepted' ? 'ok' : 'error', { id: target, path: openPath,
        pid: outcome.pid, exitCode, signal, code: error && error.code,
        message: error ? error.message : 'Launcher exited 0; actual application state is unverified.' });
      resolve(outcome);
    };
    const stopDirect = () => {
      // Stop only the retained launcher's direct handle. Never infer that an
      // editor/window or any descendants have been stopped or opened.
      if (child && child.pid && child.exitCode == null && child.signalCode == null && !child.killed) {
        try { child.kill(); } catch (e) { recordRuntimeEvent('open-launcher-stop', 'error', { id: target, path: openPath, pid: child.pid, message: e.message, code: e.code }); }
      }
    };
    const failed = error => {
      if (settled) return;
      if (!child || !child.pid) active.delete(child); // Node13 EMFILE may have no close
      finish('error', error); stopDirect();
    };
    try {
      let cmd, argv;
      if (process.platform === 'win32') { cmd = 'cmd.exe'; argv = ['/c', 'start', '', openPath]; }
      else if (process.platform === 'darwin') { cmd = 'open'; argv = [openPath]; }
      else { cmd = 'xdg-open'; argv = [openPath]; }
      child = child_process.spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true });
      active.add(child);
      child.on('error', failed); // attach even when pid/stdio were never created
      child.once('exit', (code, sig) => { exitCode = Number.isInteger(code) ? code : null; signal = sig || null; });
      child.once('close', (code, sig) => {
        active.delete(child); clearTimeout(timer);
        if (exitCode === null) exitCode = Number.isInteger(code) ? code : null;
        if (!signal) signal = sig || null;
        if (settled) {
          recordRuntimeEvent('open-launcher-close', 'error', { id: target, path: openPath, pid: child.pid, exitCode, signal,
            message: 'Late launcher close observed after ' + outcome.status + '; application state remains unverified.' });
          return;
        }
        if (exitCode === 0 && !signal) finish('accepted');
        else finish(exitCode == null && !signal ? 'unknown' : 'error', { code: 'OPEN_EXIT',
          message: 'Desktop launcher did not confirm success (exit ' + exitCode + (signal ? ', signal ' + signal : '') + ').' });
      });
      timer = setTimeout(() => {
        finish('unknown', { code: 'OPEN_TIMEOUT', message: 'Desktop launcher close was not confirmed within ' + waitMs + 'ms; opening result is unknown. Check the desktop before retrying.' });
        stopDirect();
      }, waitMs);
      child.unref();
    } catch (error) { failed(error); }
  });
}

function replDraftByteLimit() { return 1024 * 1024; }
function reserveReplNote(draft, note) {
  const bytes = Buffer.byteLength('\n' + note + '\n', 'utf8');
  if (bytes > replDraftByteLimit() - draft.textBytes - draft.reservedBytes) throw new Error('Draft exceeds 1 MiB UTF-8 including queued notes; execute or clear the current draft first.');
  draft.reservedBytes += bytes;
  return bytes;
}
function releaseReplNote(draft, token) {
  draft.reservedBytes -= token.draftReservedBytes || 0;
  token.draftReservedBytes = 0;
}
function appendReplDraft(draft, text, token) {
  const bytes = Buffer.byteLength(text, 'utf8'), reserved = token ? token.draftReservedBytes || 0 : 0;
  if (bytes > replDraftByteLimit() - draft.textBytes - draft.reservedBytes + reserved) throw new Error('Draft exceeds 1 MiB UTF-8 including queued notes; input was not queued.');
  if (token) releaseReplNote(draft, token);
  draft.text += text;
  draft.textBytes += bytes;
}

// ====================== LIGHT/HEAVY CALLER ======================
// GAP-8: token usage observability. The upstream reports per-response token
// usage; sessionUsage aggregates every callOpenAI call made by THIS process
// (a CLI session, or a server since it started). recordUsage() tolerates
// endpoints that omit the field entirely.
const sessionUsage = { prompt: 0, completion: 0 };
function recordUsage(u, model) {
  if (!u || typeof u !== 'object') return;
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!valid(u.prompt_tokens) && !valid(u.completion_tokens)) return;
  const prompt = valid(u.prompt_tokens) ? u.prompt_tokens : 0;
  const completion = valid(u.completion_tokens) ? u.completion_tokens : 0;
  sessionUsage.prompt += prompt;
  sessionUsage.completion += completion;
  audit({ ts: new Date().toISOString(), type: 'usage', model: String(model || ''),
    prompt, completion, total: prompt + completion });
}
// T22-06: callable tokens preserve the existing positional cancel contract.
// Subscription-based HTTP/CLI controls need no per-operation polling; legacy
// callback tokens are observed only while an asynchronous wait is active.
function executionCancelledError(cancelled) {
  const error = new Error((cancelled && cancelled.reason) || 'Execution cancelled.');
  error.code = 'EXECUTION_CANCELLED';
  return error;
}
function serializeModelRequest(payload, cancelled, maxBytes = 8 * 1024 * 1024) {
  let bytes = 0, nodes = 0, chars = 0;
  const ancestors = new Set();
  function add(n) { bytes += n; if (bytes > maxBytes) throw new Error('JSON body exceeds ' + maxBytes + ' byte budget'); }
  function quoted(value) {
    add(2);
    for (let i = 0; i < value.length; i++) {
      if ((++chars & 4095) === 0) checkExecution(cancelled);
      const ch = value.charCodeAt(i);
      if (ch === 34 || ch === 92 || ch === 8 || ch === 9 || ch === 10 || ch === 12 || ch === 13) add(2);
      else if (ch < 32) add(6);
      else if (ch < 128) add(1);
      else if (ch < 2048) add(2);
      else if (ch >= 0xD800 && ch <= 0xDBFF && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xDC00 && value.charCodeAt(i + 1) <= 0xDFFF) { add(4); i++; }
      else if (ch >= 0xD800 && ch <= 0xDFFF) add(6); // Node13 well-formed JSON.stringify
      else add(3);
    }
  }
  const omitted = value => value === undefined || typeof value === 'function' || typeof value === 'symbol';
  function ownValue(value, key) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d && !Object.prototype.hasOwnProperty.call(d, 'value')) throw new Error('JSON body contains an accessor');
    return d ? d.value : undefined;
  }
  function walk(value, depth) {
    checkExecution(cancelled);
    if (++nodes > 100000) throw new Error('JSON body exceeds 100000 values');
    if (depth > 64) throw new Error('JSON body exceeds 64 nested levels');
    if (typeof value === 'string') { quoted(value); return; }
    if (value === null || omitted(value)) { add(4); return; }
    if (typeof value === 'number') { add(Number.isFinite(value) ? String(value).length : 4); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value !== 'object') throw new Error('JSON body contains an unsupported value type');
    if (ancestors.has(value)) throw new Error('JSON body contains a cycle');
    // Outbound payloads are plain JSON records. Reject executable serializers
    // rather than running them once in preflight and again in stringify.
    let proto = value, levels = 0;
    while (proto) {
      if (++levels > 64) throw new Error('JSON body has an unsupported prototype chain');
      if (typeof ownValue(proto, 'toJSON') === 'function') throw new Error('JSON body contains an executable serializer');
      proto = Object.getPrototypeOf(proto);
    }
    ancestors.add(value); add(2); let count = 0;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { if (count++) add(1); walk(ownValue(value, String(i)), depth + 1); }
    } else {
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const child = ownValue(value, key);
        if (omitted(child)) continue;
        if (count++) add(1); quoted(key); add(1); walk(child, depth + 1);
      }
    }
    ancestors.delete(value);
  }
  try {
    checkExecution(cancelled); walk(payload, 0);
    const body = JSON.stringify(payload);
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') !== bytes) throw new Error('JSON body changed during preparation');
    return body;
  } catch (error) {
    if (cancelled && cancelled()) throw error;
    const rejected = new Error('Model request rejected before sending: ' + error.message);
    rejected.code = 'MODEL_REQUEST_REJECTED'; rejected.requestNotSent = true;
    throw rejected;
  }
}
function checkExecution(cancelled) {
  if (cancelled && cancelled()) throw executionCancelledError(cancelled);
}
function watchExecution(cancelled, callback) {
  if (!cancelled) return () => {};
  if (typeof cancelled.subscribe === 'function') return cancelled.subscribe(callback);
  let timer = null, fired = false;
  const poll = () => {
    if (!fired && cancelled()) { fired = true; clearInterval(timer); callback(); }
  };
  timer = setInterval(poll, 100);
  poll();
  return () => clearInterval(timer);
}
function createExecutionControl(timeoutMs = EXECUTION_TIMEOUT_MS) {
  const active = createExecutionControl.active || (createExecutionControl.active = new Set());
  const listeners = new Set();
  const deadlineAt = Date.now() + timeoutMs;
  let timer;
  function token() {
    if (!token.reason && Date.now() >= deadlineAt) token.cancel('Execution deadline exceeded.');
    return !!token.reason;
  }
  token.reason = '';
  token.deadlineAt = deadlineAt;
  token.cancel = reason => {
    if (token.reason) return;
    token.reason = reason || 'Execution cancelled.';
    clearTimeout(timer);
    for (const callback of Array.from(listeners)) callback();
    listeners.clear();
  };
  token.subscribe = callback => {
    if (token()) { callback(); return () => {}; }
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  token.dispose = () => { clearTimeout(timer); listeners.clear(); active.delete(token); };
  timer = setTimeout(() => token.cancel('Execution deadline exceeded.'), timeoutMs);
  active.add(token);
  return token;
}
function cancelActiveExecutions(reason) {
  for (const token of Array.from(createExecutionControl.active || [])) token.cancel(reason);
}
function waitForExecution(ms, cancelled) {
  checkExecution(cancelled);
  return new Promise((resolve, reject) => {
    let detach = () => {};
    const timer = setTimeout(() => { detach(); resolve(); }, ms);
    detach = watchExecution(cancelled, () => { clearTimeout(timer); reject(executionCancelledError(cancelled)); });
  });
}
async function executionHttp(config, cancelled, consume) {
  checkExecution(cancelled);
  const source = cancelled ? axios.CancelToken.source() : null;
  let stream = null, responseRequest = null, completed = false;
  const closeResponse = () => {
    // Axios may wrap the raw response in Readable.from(asyncGenerator). On
    // Node13 destroying that wrapper while its next read is pending need not
    // close the underlying socket. CancelToken notification is asynchronous
    // and wrapper 'close' can unsubscribe it first: retain the owned native
    // response request and destroy it independently, before the wrapper.
    if (responseRequest && typeof responseRequest.destroy === 'function' && !responseRequest.destroyed) responseRequest.destroy();
    if (stream && !stream.destroyed) stream.destroy();
  };
  const detach = watchExecution(cancelled, () => {
    source.cancel((cancelled && cancelled.reason) || 'Execution cancelled.');
    closeResponse();
  });
  try {
    const response = await axios(Object.assign({}, config, source ? { cancelToken: source.token } : {}));
    responseRequest = response.request || null;
    stream = config.responseType === 'stream' ? response.data : null;
    checkExecution(cancelled);
    const result = consume ? await consume(response) : response;
    checkExecution(cancelled);
    completed = true;
    return result;
  } catch (error) {
    checkExecution(cancelled);
    throw error;
  } finally {
    // If cancellation landed before the parser attached, no error listener
    // exists yet: destroy without emitting a new, unhandled stream error.
    if (!completed || (cancelled && cancelled())) closeResponse();
    detach();
  }
}
// Fixed HTML regexes can also backtrack on incomplete local/generated pages.
// Run only this constant script, with page text as data; never evaluate HTML/JS.
function htmlPreviewBounded(html, search = false, extract = true, cancelled = null) {
  checkExecution(cancelled);
  if (typeof html !== 'string') throw new Error('HTML response must be text');
  if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) throw fileByteLimitError('HTML response', 2 * 1024 * 1024);
  const remaining = cancelled && Number.isFinite(cancelled.deadlineAt) ? cancelled.deadlineAt - Date.now() : 200;
  if (remaining <= 0) throw executionCancelledError(cancelled);
  const budget = Math.max(1, Math.min(200, Math.floor(remaining)));
  const context = vm.createContext({ html, search: !!search, extract: !!extract });
  const script = new vm.Script(String.raw`
    var re = search ? /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g : /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    var links = [], match, limit = search ? 10 : 20;
    while ((match = re.exec(html)) !== null) {
      links.push((search ? match[2] : match[2].trim()) + ' -> ' + match[1]);
      if (links.length >= limit) break;
    }
    var text = extract ? html.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000) : '';
    ({ links: links, text: text });
  `);
  try {
    const result = script.runInContext(context, { timeout: budget });
    checkExecution(cancelled);
    return result;
  } catch (e) {
    checkExecution(cancelled);
    if (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new Error('HTML parsing exceeded ' + budget + 'ms budget; no complete preview available');
    throw e;
  }
}
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
    let usage = null; // GAP-8: usage chunk (OpenAI sends it on the final chunk) - last one wins
    let sawAnything = false;
    let sawDone = false; // A2-15: an upstream that ends WITHOUT [DONE] and
    // WITHOUT finish_reason did not complete - treat as an error, not success.
    let upstreamErrorSeen = false;
    let sawReasoning = false;
    let buffer = '';
    let receivedBytes = 0;
    let settled = false;
    function settle(error, choice) {
      if (settled) return;
      settled = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      stream.removeListener('aborted', onAborted);
      buffer = '';
      if (error) {
        // destroy() can itself emit an asynchronous error before close.
        if (typeof stream.destroy === 'function' && !stream.destroyed) {
          const ignoreError = () => {};
          stream.on('error', ignoreError);
          stream.once('close', () => stream.removeListener('error', ignoreError));
          stream.destroy();
        }
        reject(error);
      } else resolve(choice);
    }
    function onError(error) { settle(error); }
    function onClose() { settle(new Error('upstream error: stream closed before end')); }
    function onAborted() { settle(new Error('upstream error: stream aborted')); }
    function objectValue(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function invalid(detail) { throw new Error('upstream error: invalid SSE data (' + detail + ')'); }
    function onData(chunk) {
      if (settled) return;
      try {
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf8');
      if (receivedBytes + bytes > MODEL_RESPONSE_MAX_BYTES) throw new Error('upstream error: model response exceeds 8MiB budget');
      receivedBytes += bytes;
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
        if (!payload) continue;
        if (payload === '[DONE]') { sawDone = true; continue; } // A2-15
        let parsed;

        try { parsed = JSON.parse(payload); } catch (e) {

          // Malformed error payloads (LMStudio appends trailing junk after the

          // error object) still deserve to surface, not be silently skipped.

          if (upstreamErrorSeen || payload.indexOf('"error"') >= 0) {

            throw new Error('upstream error: ' + payload.substring(0, 300));

          }

          continue;

        }
        if (!objectValue(parsed)) invalid('expected object');
        // LMStudio and other local endpoints can report errors inside SSE.
        if (parsed.error) {
          const em = parsed.error.message || String(parsed.error);
          throw new Error('upstream error: ' + em);
        }
        if (parsed.choices !== undefined && !Array.isArray(parsed.choices)) invalid('choices must be an array');
        const ch = parsed.choices && parsed.choices[0];
        if (parsed.usage) usage = parsed.usage; // GAP-8: capture before the no-choices gate (usage-only final chunks exist)
        if (!parsed.choices || !parsed.choices.length) continue;
        if (!objectValue(ch)) invalid('choice must be an object');
        sawAnything = true;
        const delta = ch.delta == null ? {} : ch.delta;
        if (!objectValue(delta)) invalid('delta must be an object');
        for (const field of ['content', 'reasoning_content']) {
          if (delta[field] != null && typeof delta[field] !== 'string') invalid(field + ' must be a string');
        }
        if (ch.finish_reason != null && typeof ch.finish_reason !== 'string') invalid('finish_reason must be a string');
        if (delta.reasoning_content) {
          sawReasoning = true;
          message.reasoning = (message.reasoning || '') + delta.reasoning_content;
          if (onReasoning) onReasoning(delta.reasoning_content);
        }
        if (delta.content) {
          message.content += delta.content;
          if (onDelta) onDelta(delta.content);
        }
        if (delta.tool_calls != null) {
          if (!Array.isArray(delta.tool_calls)) invalid('tool_calls must be an array');
          // Tool calls stream as fragments; merge them by index.
          for (const tc of delta.tool_calls) {
            if (!objectValue(tc)) invalid('tool call must be an object');
            if (tc.index !== undefined && (!Number.isInteger(tc.index) || tc.index < 0 || tc.index > 1023)) invalid('tool call index out of range');
            if (tc.id != null && typeof tc.id !== 'string') invalid('tool call id must be a string');
            if (tc.function != null && !objectValue(tc.function)) invalid('function must be an object');
            if (tc.function) {
              for (const field of ['name', 'arguments']) {
                if (tc.function[field] != null && typeof tc.function[field] !== 'string') invalid('function ' + field + ' must be a string');
              }
            }
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
      } catch (error) {
        settle(new Error(/^upstream error:/.test(error.message) ? error.message : 'upstream error: SSE handler failed: ' + error.message));
      }
    }
    function onEnd() {
      if (settled) return;
      try {
      const merged = toolCalls.filter(tc => tc && tc.function && tc.function.name);
      if (merged.length) message.tool_calls = merged;
      if (!message.content && !merged.length && sawReasoning) message.reasoning_only = true;
      if (!sawAnything) return settle(null, null);
      if (!sawDone && !finishReason) {
        return settle(new Error('upstream error: stream ended without completion (no [DONE], no finish_reason) - partial reply discarded'));
      }
      const out = { message, finish_reason: finishReason || 'stop' };
      if (usage) out.usage = usage; // GAP-8: attach upstream usage for callOpenAI to record
      settle(null, out);
      } catch (error) { settle(error); }
    }
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
    stream.on('aborted', onAborted);
  });
}

async function callOpenAI(currentMessages, options = {}) {
  const {
    model = options.modelContext ? options.modelContext.main : HEAVY_MODEL,
    useTools = true,
    toolChoice = "auto",
    temperature = TEMPERATURE,
    maxTokens = MAX_TOKENS,
    onDelta = null,
    onReasoning = null,
  } = options;

  const mcfg = (options.modelContext && options.modelContext.routes[String(model).toLowerCase()]) || resolveModelConfig(model);
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
  if (onDelta) { payload.stream = true; payload.stream_options = { include_usage: true }; }
  // Preflight escaped JSON bytes and structure before allocating the full
  // serialized body. Retain one immutable body across retry attempts.
  const requestBody = serializeModelRequest(payload, options.cancel);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    checkExecution(options.cancel);
    try {
      if (onDelta) {
        const choice = await executionHttp({ method: 'post', url, data: requestBody,
          headers: Object.assign({}, authHeadersFor(mcfg.apiKey), { 'Content-Type': 'application/json' }),
          maxBodyLength: 8 * 1024 * 1024,
          maxContentLength: MODEL_RESPONSE_MAX_BYTES,
          timeout: 420000,
          responseType: 'stream'
        }, options.cancel, response => parseSSEStream(response.data, onDelta, onReasoning));
        if (choice) recordUsage(choice.usage, model); // GAP-8: streamed usage rides on the assembled choice
        if (choice && (choice.message.content || (choice.message.tool_calls && choice.message.tool_calls.length))) {
          return choice;
        }
        throw new Error((choice && choice.message.reasoning_only) ? 'empty response: the model emitted only reasoning tokens (reasoning_content) and never produced an answer or tool call - raise MAX_TOKENS or disable thinking' : 'empty streamed response');
      }
      const response = await executionHttp({ method: 'post', url, data: requestBody,
        headers: Object.assign({}, authHeadersFor(mcfg.apiKey), { 'Content-Type': 'application/json' }),
        maxBodyLength: 8 * 1024 * 1024,
        maxContentLength: MODEL_RESPONSE_MAX_BYTES,
        timeout: 420000, // 7 minutes - generous for slow local LLM endpoints
      }, options.cancel);
      if (response.data && response.data.choices && response.data.choices[0]) {
        recordUsage(response.data.usage, model); // GAP-8: non-stream usage lives on the response envelope
        return response.data.choices[0];
      }
      throw new Error('Invalid API response structure: ' + JSON.stringify(response.data));
    } catch (error) {
      checkExecution(options.cancel);
      let msg = error.message;
      if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
        msg = error.response.data.error.message;
      }
      if (/maxContentLength size of \d+ exceeded/.test(msg)) throw new Error('upstream error: model response exceeds 8MiB budget');
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
      await waitForExecution(1200 * attempt, options.cancel);
    }
  }
}

// ====================== RISK CLASSIFICATION & PERMISSION ======================
async function classifyRisk(toolName, args, modelContext, cancelled) {
  const prompt = `Classify risk of tool call as ONLY ONE WORD: LOW, MEDIUM or HIGH.
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Consider file edits, shell commands, web access, computer control, protected paths.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: modelContext ? modelContext.light : LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, useTools: false });
    const cleaned = (choice.message.content || 'MEDIUM').replace(/[*'`"“”’‘]/g, '').trim().toUpperCase();
    const first = cleaned.split(/\s+/)[0].replace(/[^A-Z]/g, '');
    return ['LOW', 'MEDIUM', 'HIGH'].includes(first) ? first : 'MEDIUM';
  } catch (e) {
    if (cancelled && cancelled()) throw e;
    return 'MEDIUM';
  }
}

async function getPermissionExplanation(toolName, args, risk, modelContext, cancelled) {
  const prompt = `Explain this tool action to the user in 1-2 friendly sentences. Include what it does and why it might need approval.
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Risk level: ${risk}`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: modelContext ? modelContext.light : LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, useTools: false });
    return (choice.message.content || `Tool ${toolName} will run (risk: ${risk}).`).trim();
  } catch (e) {
    if (cancelled && cancelled()) throw e;
    return `Tool ${toolName} will run. Risk: ${risk}.`;
  }
}

async function isAutoApprovalSafe(toolName, args, risk, modelContext, cancelled) {
  // AST-R2: ask for a STRUCTURED verdict - a bare YES/NO gave the model no
  // way to say why, so declines were indistinguishable and unfixable. Legacy
  // YES/NO replies still parse (models that ignore the JSON instruction).
  const prompt = `Is this tool action safe to auto-approve in AUTO mode? Risk: ${risk}
Tool: ${toolName}
Args: ${JSON.stringify(args)}
Reply ONLY with compact JSON: {"safe": true, "reason": "one short sentence"} or {"safe": false, "reason": "why not"}.`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: modelContext ? modelContext.light : LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, useTools: false });
    const raw = choice.message.content || '';
    let safe = false;
    let reason = '';
    const jm = raw.match(/\{[\s\S]*\}/);
    if (jm) {
      try {
        const j = JSON.parse(jm[0]);
        safe = j.safe === true || String(j.safe).toLowerCase() === 'true' || String(j.safe).toLowerCase() === 'yes';
        reason = String(j.reason || '').substring(0, 160);
      } catch (e) {}
    }
    if (!jm || (!safe && !reason)) {
      const cleaned = raw.replace(/[*'`"“”’‘]/g, '').trim().toUpperCase();
      if (cleaned.startsWith('YES')) safe = true;
    }
    return { safe: safe, reason: reason };
  } catch (e) {
    if (cancelled && cancelled()) throw e;
    return { safe: false, reason: 'light model call failed: ' + e.message };
  }
}

// ====================== STRUCTURED TASK STORE (GAP-6) ======================
// The task list lives at .7coder/todos.json as { items: [{id,title,status,updated}] }.
// status is one of pending/doing/done; ids are t1/t2/... (max+1, stable across
// deletions of later ids). A missing file is treated as an empty list only
// when no previous version exists. Corrupt stores recover a valid previous version
// or fail visibly; a subsequent add must never overwrite them as an empty list.
const TODO_STATUSES = ['pending', 'doing', 'done'];
const TODO_STORE_MAX = 500; // safety cap so a looping model cannot grow the file forever
function todosFilePath() { return internalStatePath('.7coder', 'todos.json'); }
function loadTodos() {
  const record = readStateRecord(todosFilePath(), parseTodoState);
  return record ? record.value.items : [];
}
function saveTodos(items) {
  writeStateFile(todosFilePath(), JSON.stringify({ items: items }, null, 2), parseTodoState);
}
// Legacy human-readable log kept in sync with the structured store: every
// mutating todo_write_tool call still appends to TODO.md (the pre-GAP-6
// contract - suite A asserts TODO.md is created), one line per change.
function appendTodoLog(entry) {
  try {
    const file = managedWorkspacePath('TODO.md');
    const current = readStateRecord(file);
    writeStateFile(file, (current ? current.value : '') + `\n## ${new Date().toISOString()}\n${entry}\n`);
  } catch (e) { console.warn('[WARN] todo log save failed (structured todo store is authoritative): ' + e.message); }
}
function nextTodoId(items) {
  let max = 0;
  for (const it of items) {
    const m = /^t(\d+)$/.exec(String(it && it.id || ''));
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  return 't' + (max + 1);
}

// ====================== TOOL EXECUTION ======================
// `conversation` is the current message array (used by snip_tool); tools that
// spawn their own sub-conversations must NOT push into it mid-tool-call.
async function executeToolRaw(name, args, conversation, approvalBridge, cancelled, modelContext) {
  // Entry boundary. Tools that await before committing need additional checks.
  if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: execution cancelled]');
  if (name === 'read_file') {
    try {
      const fullPath = path.join(launchDir, sanitizePath(args.path || ''));
      return makeToolResult('ok', await readUtf8Window(fullPath, args, cancelled, MAX_TOOL_RESULT_CHARS));
    } catch (e) {
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: file read cancelled]');
      return makeToolResult('error', `Read error: ${e.message}`);
    }
  }
  if (name === 'write_file') {
    try {
      const fullPath = path.join(launchDir, sanitizePath(args.path || ''));
      const stateParser = managedStateParser(fullPath);
      if (stateParser) readStateRecord(fullPath, stateParser);
      const original = readUtf8ForWrite(fullPath, true);
      const content = preserveTextBom(original, normalizeUtf8Input(args.content || '', original.newline));
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      checkExecution(cancelled); // re-check straddling the pre-write backup
      backupExistingFile(fullPath, cancelled);
      checkExecution(cancelled);
      if (stateParser) writeStateFile(fullPath, content, stateParser);
      else fs.writeFileSync(fullPath, content, 'utf8');
      if (args.path && args.path.endsWith('7CODER.md')) return makeToolResult('ok', '[OK] 7CODER.md updated with findings');
      return makeToolResult('ok', `Written: ${path.relative(launchDir, fullPath)}`);
    } catch (e) { return makeToolResult('error', `Write error: ${e.message}`); }
  }
  if (name === 'append_file') {
    try {
      const fullPath = path.join(launchDir, sanitizePath(args.path));
      const stateParser = managedStateParser(fullPath);
      if (stateParser) readStateRecord(fullPath, stateParser);
      const original = readUtf8ForWrite(fullPath, true);
      const content = normalizeUtf8Input(args.content || '', original.newline);
      if (Buffer.byteLength(original.text, 'utf8') + Buffer.byteLength(content, 'utf8') > textFileByteLimit()) throw fileByteLimitError('Appended text', textFileByteLimit());
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      checkExecution(cancelled); // re-check straddling the pre-write backup
      backupExistingFile(fullPath, cancelled);
      checkExecution(cancelled);
      if (stateParser) writeStateFile(fullPath, original.text + content, stateParser);
      else fs.appendFileSync(fullPath, content, 'utf8');
      return makeToolResult('ok', `Appended: ${args.path}`);
    } catch (e) { return makeToolResult('error', `Append error: ${e.message}`); }
  }

  if (name === 'edit_file') {
    try {
      const fullPath = path.join(launchDir, sanitizePath(args.path));
      const stateParser = managedStateParser(fullPath);
      if (stateParser) readStateRecord(fullPath, stateParser);
      const original = readUtf8ForWrite(fullPath, false);
      const content = original.text;
      const oldStr = normalizeUtf8Input((args.old_string === undefined || args.old_string === null) ? '' : String(args.old_string), original.newline);
      if (oldStr === '') return makeToolResult('error', 'Edit error: old_string is required');
      const newStr = normalizeUtf8Input((args.new_string === undefined || args.new_string === null) ? '' : String(args.new_string), original.newline);
      const replacement = replaceTextBounded(content, oldStr, newStr, args.replace_all);
      const count = replacement.count;
      const next = preserveTextBom(original, replacement.text);
      checkExecution(cancelled); // re-check straddling the pre-write backup
      backupExistingFile(fullPath, cancelled);
      checkExecution(cancelled);
      if (stateParser) writeStateFile(fullPath, next, stateParser);
      else fs.writeFileSync(fullPath, next, 'utf8');
      return makeToolResult('ok', `[OK] Edited ${path.relative(launchDir, fullPath)} (${args.replace_all ? count : 1} replacement(s))`);
    } catch (e) { return makeToolResult('error', `Edit error: ${e.message}`); }
  }

  if (name === 'agent_tool') {
    const agentName = String(args.name || 'agent').substring(0, 60);
    const task = String(args.task || '').trim();
    if (!task) return makeToolResult('error', 'Agent error: task is required');
    // runSubAgent itself returns a structured result (batch 5) - sub-agent
    // failures carry error status instead of being blanket-wrapped as ok.
    return await runSubAgent(agentName, task, cancelled, modelContext);
  }

  if (name === 'run_command') {
    let cmd = args.command || '';
    if (DANGER_MODE || effectivePermissionMode() === 'bypass') console.log(`[WARN] Running: ${cmd}`);

    // AST-09: async exec - a long command no longer freezes the HTTP server.
    const { r, aborted } = await awaitCommandCancellable(runCommandAsync({ cmd: withUtf8Codepage(cmd) }), cancelled);
    if (aborted) return makeToolResult('cancelled', '[aborted: client disconnected]', { exitCode: null });
    if (r.error) return makeToolResult('error', `[ERROR] Command failed:\n${r.error.message}\n${r.stderr || ''}`, { exitCode: r.exitCode });
    // T22-20: a successful exit can still carry warnings on stderr - keep
    // them instead of silently dropping the stream.
    const okText = r.stderr.trim() ? `Command OK:\n${r.stdout}\n[STDERR]\n${r.stderr}` : `Command OK:\n${r.stdout}`;
    return makeToolResult('ok', okText, { exitCode: r.exitCode });
  }

  if (name === 'bash_tool') {
    if (args.persistent === true && ENABLE_HTTP_SERVER) {
      return makeToolResult('blocked', 'BLOCKED: Persistent bash is disabled in HTTP server mode until backend conversation ownership is defined. Use persistent=false with explicit cwd/env, or use CLI/REPL.', { exitCode: null });
    }
    let cmd = args.command || '';
    if (DANGER_MODE || effectivePermissionMode() === 'bypass') console.log(`[WARN] Running (bash): ${cmd.substring(0, 200)}`);

    // GAP-2: persistent=true runs in the conversation's long-lived bash so
    // cwd/env/aliases survive across calls (cd, export...). Default stays the
    // stateless one-shot mode - deterministic and safe for scripts.
    if (args.persistent === true) {
      const sh = getPersistentShell(shellSessionKey(), cancelled);
      if (!sh) {
        return makeToolResult('error', 'bash not found. On Windows install Git for Windows (it ships bash.exe), then retry - or use powershell_tool / run_command instead.', { exitCode: null });
      }
      const limit = Math.max(1000, Math.min(300000, parseInt(args.timeout_ms, 10) || 120000));
      const r = await sh.run(String(cmd), limit, cancelled);
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: client disconnected]', { exitCode: null });
      // Negative codes are shell bookkeeping; a retired session (including
      // synthetic timeout 124) has no confirmed command exit status.
      const data = { exitCode: !r.restarted && Number.isInteger(r.code) && r.code >= 0 ? r.code : null };
      if (r.restarted) return makeToolResult('error', `[ERROR] Command failed:\n${r.out}`, data);
      if (r.code !== 0) return makeToolResult('error', `[ERROR] Command failed (exit ${r.code}):\n${r.out}`, data);
      return makeToolResult('ok', `Command OK (persistent shell, exit 0):\n${r.out}`, data);
    }

    const bash = persistentBashExecutable(findBash());
    checkExecution(cancelled);
    if (!bash) {
      return makeToolResult('error', 'bash not found. On Windows install Git for Windows (it ships bash.exe), then retry - or use powershell_tool / run_command instead.', { exitCode: null });
    }
    const { r, aborted } = await awaitCommandCancellable(runCommandAsync({ file: bash, args: ['-c', String(cmd)] }, { env: persistentBashEnvironment(bash) }), cancelled);
    if (aborted) return makeToolResult('cancelled', '[aborted: client disconnected]', { exitCode: null });
    if (r.error) return makeToolResult('error', `[ERROR] Command failed:\n${r.error.message}\n${r.stderr || ''}`, { exitCode: r.exitCode });
    const okText = r.stderr.trim() ? `Command OK:\n${r.stdout}\n[STDERR]\n${r.stderr}` : `Command OK:\n${r.stdout}`;
    return makeToolResult('ok', okText, { exitCode: r.exitCode });
  }

  if (name === 'powershell_tool') {
    if (process.platform !== 'win32') {
      return makeToolResult('error', 'powershell_tool is Windows-only - use bash_tool or run_command on this platform.', { exitCode: null });
    }
    let cmd = args.command || '';
    if (DANGER_MODE || effectivePermissionMode() === 'bypass') console.log(`[WARN] Running (PowerShell): ${cmd.substring(0, 200)}`);
    // Fixed ASCII bootstrap decodes UTF-16LE Base64; avoids the host's
    // EncodedCommand CLIXML stderr mode. No user command is shell-quoted.
    const { r, aborted } = await awaitCommandCancellable(runCommandAsync(powerShellSpec(cmd), { windowsHide: true }), cancelled);
    if (aborted) return makeToolResult('cancelled', '[aborted: client disconnected]', { exitCode: null });
    if (r.error) return makeToolResult('error', `[ERROR] Command failed:\n${r.error.message}\n${r.stderr || ''}`, { exitCode: r.exitCode });
    const okText = r.stderr.trim() ? `Command OK:\n${r.stdout}\n[STDERR]\n${r.stderr}` : `Command OK:\n${r.stdout}`;
    return makeToolResult('ok', okText, { exitCode: r.exitCode });
  }

  if (name === 'glob_tool') {
    // P2-3: budgeted walk - heavy dirs skipped, depth/entry caps keep huge
    // workspaces from flooding the context (sentinel line marks truncation).
    try {
      const files = recursiveReaddir(args.directory, args.pattern, { skipHeavy: true, maxDepth: 12, maxEntries: 1000, deadlineAt: cancelled && cancelled.deadlineAt, cancelled });
      return makeToolResult('ok', files.length ? files.join('\n') : 'No files matched');
    } catch (e) {
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: glob cancelled]');
      return makeToolResult('error', 'Glob error: ' + e.message);
    }
  }
  if (name === 'grep_tool') {
    const text = grepSearch(args.pattern, args.path, { skipHeavy: true, deadlineAt: cancelled && cancelled.deadlineAt, cancelled });
    // Invalid patterns/starting paths are errors; an incomplete scan has an
    // explicit marker, while a complete no-match scan remains normal output.
    return makeToolResult(text.startsWith('Tool error:') ? 'error' : 'ok', text);
  }

  if (name === 'list_dir') {
    try {
      const dirPath = args.path ? path.join(launchDir, sanitizePath(args.path)) : launchDir;
      if (!fs.statSync(dirPath).isDirectory()) return makeToolResult('error', 'List error: not a directory');
      const deadlineAt = Math.min(Date.now() + 5000, cancelled && cancelled.deadlineAt || Infinity);
      const scan = readDirectoryEntriesBounded(dirPath, { deadlineAt, cancelled }), lines = [];
      for (const entry of scan.entries) {
        checkExecution(cancelled);
        if (Date.now() >= deadlineAt) { scan.incomplete = 'directory scan deadline exceeded'; break; }
        const e = entry.name, full = path.join(dirPath, e);
        try {
          const st = fs.statSync(full);
          lines.push(st.isDirectory() ? '[DIR]     ' + e : String(st.size).padStart(9) + '  ' + e);
        } catch (err) { lines.push('[?]       ' + e); }
      }
      return makeToolResult('ok', (scan.incomplete ? '[incomplete: ' + scan.incomplete + ']\n' : '') + (lines.length ? lines.join('\n') : scan.incomplete ? '(no entries collected)' : '(empty directory)'));
    } catch (e) { return makeToolResult(cancelled && cancelled() ? 'cancelled' : 'error', `List error: ${e.message}`); }
  }

  if (name === 'process_list_tool') {
    // AST-09: async - tasklist can take seconds on a busy system.
    const { r } = await awaitCommandCancellable(runCommandAsync({ cmd: withUtf8Codepage(process.platform === 'win32' ? 'tasklist' : 'ps -eo pid,comm') }), cancelled);
    if (r.error) return makeToolResult('error', `Process list error: ${r.error.message}`);
    return makeToolResult('ok', r.stdout);
  }
  if (name === 'process_kill_tool') {
    const pid = parseInt(args.pid, 10);
    if (!pid || pid < 2) return makeToolResult('error', 'Invalid PID (must be >= 2)');
    try {
      if (process.platform === 'win32') {
        child_process.execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf8', timeout: 30000 });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      return makeToolResult('ok', `[OK] Killed process ${pid}`);
    } catch (e) { return makeToolResult('error', `Kill error: ${e.message}`); }
  }

  if (name === 'web_fetch_tool') {
    try {
      const res = await executionHttp({ method: 'get', url: args.url, timeout: 10000, maxContentLength: 2 * 1024 * 1024 }, cancelled);
      // Fetched page content passes through verbatim - its leading text must
      // never decide the status, so success is marked explicitly.
      return makeToolResult('ok', typeof res.data === 'string' ? res.data : stringifyJsonBounded(res.data, 'Fetched JSON'));
    } catch (e) {
      if (cancelled && cancelled()) throw e;
      return makeToolResult('error', `Fetch error: ${e.message}`);
    }
  }
  if (name === 'download_tool') {
    // T22-09: close and flush a unique sibling, snapshot the old version, then
    // rename OVER the destination in one operation. Never unlink dest first.
    let temp = null;
    let tempOwned = false;
    let writer = null;
    let writerClosed = null;
    let response = null;
    try {
      checkExecution(cancelled);
      const destRel = sanitizePath(args.path);
      if (!destRel) return makeToolResult('error', 'Download error: destination path required');
      if (!args.url || !/^https?:\/\//i.test(args.url)) return makeToolResult('error', 'Download error: url must start with http:// or https://');
      const dest = path.join(launchDir, destRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const MAX_BYTES = 500 * 1024 * 1024;
      return await executionHttp({ method: 'get', url: args.url, responseType: 'stream', timeout: 60000 }, cancelled, async res => {
        response = res;
        checkExecution(cancelled);
        temp = dest + '.part-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
        // Node 13 _destroy waits for 'open' when fd is null, even after open
        // failed. Acquire exclusively first, so every created writer owns a
        // real fd and its close can be awaited without that permanent wait.
        const tempFd = fs.openSync(temp, 'wx');
        tempOwned = true;
        try { writer = fs.createWriteStream(temp, { fd: tempFd, autoClose: true, emitClose: true }); }
        catch (e) { fs.closeSync(tempFd); throw e; }
        writerClosed = new Promise(resolve => writer.once('close', resolve));
        let writerError = null;
        writer.on('error', error => { writerError = error; });
        let received = 0;
        const limiter = new Transform({ transform(chunk, encoding, callback) {
          received += chunk.length;
          callback(received > MAX_BYTES ? new Error('download exceeds 500 MB cap') : null, chunk);
        } });
        await new Promise((resolve, reject) => {
          pipeline(response.data, limiter, writer, error => error ? reject(error) : resolve());
        });
        // On Node 13 finish/pipeline completion can precede the file close.
        // A close error must fail before backup/commit, especially on Windows.
        await writerClosed;
        if (writerError) throw writerError;
        checkExecution(cancelled);
        flushDownloadFile(temp);
        checkExecution(cancelled); // re-check straddling the pre-commit backup
        const previous = backupExistingFile(dest, cancelled);
        checkExecution(cancelled); // backup/flush can outlast the shared deadline
        fs.renameSync(temp, dest);
        temp = null; // ownership transferred - the catch path must not delete it
        return makeToolResult('ok', `[OK] Downloaded ${args.url} to ${destRel} (${received} bytes)` +
          (previous ? `\nPrevious version: ${path.relative(launchDir, previous)} (restore with /undo ${destRel})` : ''));
      });
    } catch (e) {
      if (response && response.data) { try { response.data.destroy(); } catch (e2) {} }
      if (writer) {
        try { writer.destroy(); } catch (e2) {}
        if (writerClosed) await writerClosed;
      }
      let residue = '';
      if (temp && tempOwned) {
        try { fs.unlinkSync(temp); }
        catch (e2) { if (e2.code !== 'ENOENT') residue = `; temporary file retained at ${temp}: ${e2.message}`; }
      }
      if (cancelled && cancelled()) return makeToolResult('cancelled', `[aborted: download cancelled]${residue}`);
      return makeToolResult('error', `Download error: ${e.message}${residue}`);
    }
  }
  if (name === 'web_search_tool') {
    // GAP-10: pluggable search providers. Unknown values fail fast with the
    // legal list - never a silent network fallback.
    const validProviders = "'' (DuckDuckGo lite), ddg, searxng, brave, bing";
    if (SEARCH_PROVIDER !== '' && SEARCH_PROVIDER !== 'ddg' && SEARCH_PROVIDER !== 'searxng' && SEARCH_PROVIDER !== 'brave' && SEARCH_PROVIDER !== 'bing') {
      return makeToolResult('error', `Search error (provider): Unknown SEARCH_PROVIDER "${SEARCH_PROVIDER}". Valid values: ${validProviders}.`);
    }
    try {
      const q = encodeURIComponent(args.query);
      if (SEARCH_PROVIDER === 'searxng') {
        const base = SEARCH_ENDPOINT.replace(/\/+$/, '');
        if (!base) return makeToolResult('error', 'Search error (provider): SEARCH_ENDPOINT is required when SEARCH_PROVIDER=searxng (check SEARCH_* configuration)');
        const res = await executionHttp({ method: 'get', url: `${base}/search?q=${q}&format=json`, timeout: 10000, maxContentLength: 2 * 1024 * 1024 }, cancelled);
        const rows = (((res.data || {}).results) || []).slice(0, 10).map(r => `${r.title} -> ${r.url}`);
        return makeToolResult('ok', `Search results:\n${rows.join('\n')}`);
      }
      if (SEARCH_PROVIDER === 'brave') {
        const res = await executionHttp({ method: 'get', url: `https://api.search.brave.com/res/v1/web/search?q=${q}`, timeout: 10000, maxContentLength: 2 * 1024 * 1024, headers: SEARCH_API_KEY ? { 'X-Subscription-Token': SEARCH_API_KEY } : {} }, cancelled);
        const rows = ((((res.data || {}).web || {}).results) || []).slice(0, 10).map(r => `${r.title} -> ${r.url}`);
        return makeToolResult('ok', `Search results:\n${rows.join('\n')}`);
      }
      if (SEARCH_PROVIDER === 'bing') {
        const res = await executionHttp({ method: 'get', url: `https://api.bing.microsoft.com/v7.0/search?q=${q}`, timeout: 10000, maxContentLength: 2 * 1024 * 1024, headers: SEARCH_API_KEY ? { 'Ocp-Apim-Subscription-Key': SEARCH_API_KEY } : {} }, cancelled);
        const rows = ((((res.data || {}).webPages || {}).value) || []).slice(0, 10).map(r => `${r.name} -> ${r.url}`);
        return makeToolResult('ok', `Search results:\n${rows.join('\n')}`);
      }
      const res = await executionHttp({ method: 'get', url: `https://lite.duckduckgo.com/lite?q=${q}`, timeout: 10000, maxContentLength: 2 * 1024 * 1024 }, cancelled);
      const links = htmlPreviewBounded(res.data, true, false, cancelled).links;
      return makeToolResult('ok', `Search results:\n${links.join('\n')}`);
    } catch (e) {
      if (cancelled && cancelled()) throw e;
      return makeToolResult('error', `Search error (provider): ${e.message} (check SEARCH_PROVIDER/SEARCH_ENDPOINT/SEARCH_API_KEY configuration)`);
    }
  }

  if (name === 'web_browser_tool') {
    const url = args.url;
    const action = args.action || 'navigate';
    console.log(`[WEB] Real browser tool: ${action} -> ${url}`);

    try {
      const isImage = url.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i);
      if (isImage) {
        const desc = await describeWithVision(url, modelContext, cancelled);
        if (toolResultStatus(desc) !== 'ok') return desc;
        return makeToolResult('ok', `[IMAGE] Image viewed at ${url}\nVision description:\n${toolResultText(desc)}`);
      }

      const res = await executionHttp({ method: 'get', url, timeout: 15000, responseType: 'text', maxContentLength: 2 * 1024 * 1024 }, cancelled);
      let pageContent = typeof res.data === 'string' ? res.data : stringifyJsonBounded(res.data, 'Page JSON');

      const pagePreview = htmlPreviewBounded(pageContent, false, action === 'extract' || action === 'navigate', cancelled);
      const linksSummary = pagePreview.links.join('\n');

      let result = `[PAGE] Page fetched successfully (${action})\nURL: ${url}\n\n[LINKS] Links found (infer from names):\n${linksSummary || 'No clickable links found'}\n\n`;

      if (action === 'extract' || action === 'navigate') {
        result += `Content preview (first 3000 chars):\n${pagePreview.text}...`;
      } else if (action === 'click') {
        result += `[LINKS] Click simulated - navigated to the provided URL. Use the extracted links above for next steps.`;
      }
      return makeToolResult('ok', result);
    } catch (e) {
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: browser operation cancelled]');
      return makeToolResult('error', `[WEB] Browser error for ${url}: ${e.message}`);
    }
  }

  if (name === 'notebook_edit_tool') {
    try {
      const nbPath = path.join(launchDir, sanitizePath(args.path));
      const original = readUtf8ForWrite(nbPath, false);
      let notebook = JSON.parse(original.text.replace(/^\uFEFF/, ''));
      if (args.edits.cells) notebook.cells = args.edits.cells;
      if (args.edits.metadata) notebook.metadata = { ...notebook.metadata, ...args.edits.metadata };
      const content = preserveTextBom(original, normalizeUtf8Input(stringifyNotebookBounded(notebook), original.newline));
      checkExecution(cancelled); // re-check straddling the pre-write backup
      backupExistingFile(nbPath, cancelled);
      checkExecution(cancelled);
      fs.writeFileSync(nbPath, content, 'utf8');
      return makeToolResult('ok', 'Notebook edited successfully');
    } catch (e) { return makeToolResult('error', `Notebook error: ${e.message}`); }
  }

  if (name === 'ask_user_question_tool') {
    // P2-15: "skipped" reads like a silent answer - the model must decide for
    // itself and surface the assumption instead of inventing a user reply.
    const userUnreachable = 'User is unreachable in this mode. Do NOT assume an answer - decide yourself, then state the assumption explicitly in your final answer.';
    if (subAgentModeOverride) return makeToolResult('ok', 'Question skipped (a sub-agent cannot ask the user questions).');
    if (!INTERACTIVE || rlClosed) return makeToolResult('ok', userUnreachable);
    if (DANGER_MODE || effectivePermissionMode() === 'bypass') return makeToolResult('ok', userUnreachable);
    const answer = await cliQuestions.ask(`${args.question}\nAnswer: `, cancelled);
    return answer === null ? makeToolResult('ok', userUnreachable) : makeToolResult('ok', `User answered: ${answer}`);
  }

  if (name === 'brief_tool') {
    try {
      const folderRel = sanitizePath(args.folder);
      const summaryPath = internalStatePath('.7coder/summaries', folderRel + '.summary');
      const files = recursiveReaddir(args.folder, '', { skipHeavy: true, maxDepth: 12, maxEntries: 1000 });
      const cap = 2000;
      let body = files.join('\n');
      if (files.length > cap) {
        body = files.slice(0, cap).join('\n') + '\n...(truncated, ' + (files.length - cap) + ' more files)';
      }
      const summary = `Summary of ${args.folder} (${files.length} files):\n${body}\n\nGenerated at ${new Date().toISOString()}`;
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      writeStateFile(summaryPath, summary);
      return makeToolResult('ok', `Summary written to ${summaryPath}`);
    } catch (e) { return makeToolResult('error', `Brief error: ${e.message}`); }
  }

  if (name === 'task_create_tool') {
    if (shuttingDown) return makeToolResult('error', 'Task refused: 7coder is shutting down.');
    const command = String(args.command || '').trim();
    if (!command) return makeToolResult('error', 'Task error: command is required (e.g. "npm test")');
    if (command.length > 32768) return makeToolResult('error', 'Task error: command exceeds 32768 characters.');
    const activeCount = Array.from(backgroundTasks.values()).filter(t => t.child && !observeOwnedChild(t.child).closed).length;
    if (activeCount >= TASK_MAX_ACTIVE) return makeToolResult('error', 'Task error: active task limit reached (' + TASK_MAX_ACTIVE + '); stop or finish an existing task first.');
    const taskId = `task-${Date.now()}-${++taskSeq}`;
    const task = {
      id: taskId,
      description: String(args.description || command).slice(0, 2000),
      command,
      status: 'running',
      output: '',
      outputBytes: 0,
      outputTruncated: false,
      outputExceeded: false,
      startedAt: new Date().toISOString(),
      endedAt: null,
      child: null,
      stopRequested: false
    };
    const child = child_process.exec(withUtf8Codepage(command), { cwd: launchDir, timeout: 1800000, maxBuffer: TASK_OUTPUT_LIMIT }, (err) => {
      if (err) {
        task.commandError = String(err.message).slice(0, 2000);
        appendTaskOutput(task, `\n[Task failed] ${task.commandError}`);
      }
    });
    const state = observeOwnedChild(child, 'background-child', taskId);
    const complete = () => {
      task.status = task.outputExceeded ? 'failed' : (task.stopRequested ? 'stopped' : (task.commandError || state.error ? 'failed' : 'completed'));
      task.endedAt = new Date().toISOString();
      task.child = null;
      pruneTasks();
    };
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', d => captureTaskOutput(task, d.toString()));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', d => captureTaskOutput(task, d.toString()));
    }
    task.child = child;
    backgroundTasks.set(taskId, task);
    if (state.closed) complete();
    else state.waiters.add(complete);
    pruneTasks();
    return makeToolResult('ok', `[OK] Background task ${taskId} started: ${command}`);
  }
  if (name === 'task_get_tool') {
    const t = backgroundTasks.get(args.task_id) || (!args.task_id ? latestTask() : null);
    if (!t) return makeToolResult('error', 'Task not found');
    return makeToolResult('ok', JSON.stringify({ id: t.id, description: t.description, command: t.command, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, stopMessage: t.stopMessage,
      outputBytes: t.outputBytes, outputTruncated: t.outputTruncated, outputExceeded: t.outputExceeded }, null, 2));
  }
  if (name === 'task_list_tool') {
    if (!backgroundTasks.size) return makeToolResult('ok', 'No tasks');
    return makeToolResult('ok', Array.from(backgroundTasks.values())
      .map(t => `${t.id} | ${t.status} | ${t.command.substring(0, 60)}`)
      .join('\n'));
  }
  if (name === 'task_output_tool') {
    const t = backgroundTasks.get(args.task_id) || (!args.task_id ? latestTask() : null);
    if (!t) return makeToolResult('error', 'Task not found');
    const MAXSHOW = 8000;
    const out = t.output || '(no output yet)';
    const notice = t.outputExceeded ? '[Task output limit exceeded; check task status and side effects]\n' : (t.outputTruncated ? '[Earlier output discarded; retained tail only]\n' : '');
    if (out.length > MAXSHOW) {
      return makeToolResult('ok', notice + `...(output truncated, showing last ${MAXSHOW} chars)\n` + out.substring(out.length - MAXSHOW));
    }
    return makeToolResult('ok', notice + out);
  }
  if (name === 'task_stop_tool') {
    const t = backgroundTasks.get(args.task_id) || (!args.task_id ? latestTask() : null);
    if (!t) return makeToolResult('error', 'Task not found');
    if (['completed', 'failed', 'stopped'].includes(t.status) && !t.child) return makeToolResult('ok', `Task ${t.id} already ${t.status}`);
    const stopped = await stopBackgroundTask(t);
    return makeToolResult(stopped.closed ? 'ok' : 'error', `Task ${t.id}: ${stopped.message}`);
  }

  if (name === 'todo_write_tool') {
    // GAP-6: structured task list in .7coder/todos.json (add/update/list).
    // Backward compat: a legacy call with only a content string is an add.
    const action = args.action;
    if (!action && typeof args.content === 'string' && args.content.trim()) {
      const items = loadTodos();
      const item = { id: nextTodoId(items), title: args.content.trim(), status: 'pending', updated: new Date().toISOString() };
      if (items.length >= TODO_STORE_MAX) return makeToolResult('error', 'Tool error: task list is full (' + TODO_STORE_MAX + ' items)');
      items.push(item);
      saveTodos(items);
      appendTodoLog(item.title);
      return makeToolResult('ok', `[OK] Task ${item.id} added (pending): ${item.title}`);
    }
    if (action === 'add') {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) return makeToolResult('error', 'Tool error: todo_write_tool add requires a non-empty "title"');
      const items = loadTodos();
      if (items.length >= TODO_STORE_MAX) return makeToolResult('error', 'Tool error: task list is full (' + TODO_STORE_MAX + ' items)');
      const item = { id: nextTodoId(items), title: title, status: TODO_STATUSES.indexOf(args.status) !== -1 ? args.status : 'pending', updated: new Date().toISOString() };
      items.push(item);
      saveTodos(items);
      appendTodoLog(item.title);
      return makeToolResult('ok', `[OK] Task ${item.id} added (${item.status}): ${item.title}`);
    }
    if (action === 'update') {
      const items = loadTodos();
      const it = items.find(x => x.id === args.id);
      if (!it) return makeToolResult('error', `Tool error: task id "${args.id}" not found`);
      if (typeof args.title === 'string' && args.title.trim()) it.title = args.title.trim();
      if (args.status !== undefined && args.status !== null) {
        if (TODO_STATUSES.indexOf(args.status) === -1) return makeToolResult('error', `Tool error: invalid status "${args.status}" (pending/doing/done)`);
        it.status = args.status;
      }
      it.updated = new Date().toISOString(); // any update (incl. status change) refreshes updated
      saveTodos(items);
      appendTodoLog(`${it.id} -> [${it.status}] ${it.title}`);
      return makeToolResult('ok', `[OK] Task ${it.id} updated (${it.status}): ${it.title}`);
    }
    if (action === 'list') {
      const items = loadTodos();
      if (!items.length) return makeToolResult('ok', 'No tasks yet. Use action=add to create one.');
      return makeToolResult('ok', items.map(it => `${it.id}\t[${it.status}]\t${it.title}`).join('\n'));
    }
    return makeToolResult('error', 'Tool error: todo_write_tool requires action=add|update|list (or a legacy content string)');
  }

  if (name === 'memory_tool') {
    // GAP-9: durable topic notes in .7coder/memory/<topic>.md. save upserts,
    // read returns one note, list returns the index, delete removes.
    // Topics are strictly [a-z0-9][a-z0-9_-]{0,39} - no path control at all,
    // which is why this tool is auto-safe (same trust class as the todo list).
    const action = args.action;
    if (action === 'save') {
      const topic = String(args.topic || '').trim();
      const content = typeof args.content === 'string' ? args.content : '';
      if (!memoryTopicValid(topic)) return makeToolResult('error', 'Tool error: memory_tool save requires a topic of [a-z0-9][a-z0-9_-] (max 40 chars)');
      if (!content.trim()) return makeToolResult('error', 'Tool error: memory_tool save requires non-empty content');
      const guard = memoryPathGuard(topic); // A2-01: junction/protected_extra fail closed
      if (guard) return makeToolResult('error', guard);
      const existed = readMemoryFile(topic) !== null;
      const MAX = 32 * 1024;
      saveMemoryFile(topic, content.length > MAX ? content.substring(0, MAX) + '\n[truncated at 32KB]' : content);
      return makeToolResult('ok', `[OK] Memory note ${existed ? 'updated' : 'saved'}: ${topic}.md (${content.length} chars)`);
    }
    if (action === 'read') {
      const topic = String(args.topic || '').trim();
      if (!memoryTopicValid(topic)) return makeToolResult('error', 'Tool error: invalid topic');
      const guard = memoryPathGuard(topic); // A2-01
      if (guard) return makeToolResult('error', guard);
      const body = readMemoryFile(topic);
      if (body === null) return makeToolResult('error', `Tool error: no memory note named "${topic}"`);
      return makeToolResult('ok', `## ${topic}\n${body}`);
    }
    if (action === 'list') {
      const index = memoryTopicIndex(), issues = new Set(index.incomplete), rows = [];
      if (!index.topics.length && !issues.size) return makeToolResult('ok', 'No memory notes yet. Use action=save with a topic and content.');
      for (const t of index.topics) {
        try {
          const guard = memoryPathGuard(t); if (guard) throw new Error(guard);
          const body = readMemoryFile(t, 64 * 1024) || '';
          let head = (body.split('\n').find(l => l.trim()) || '').substring(0, 80);
          const last = head.charCodeAt(head.length - 1);
          if (last >= 0xD800 && last <= 0xDBFF) head = head.slice(0, -1);
          rows.push(`${t}\t${head}`);
        } catch (e) { issues.add('preview unavailable for ' + t); rows.push(t + '\t[preview unavailable]'); }
      }
      if (issues.size) rows.push('[memory list incomplete: ' + Array.from(issues).join('; ') + ']');
      return makeToolResult(issues.size ? 'error' : 'ok', rows.join('\n'));
    }
    if (action === 'delete') {
      const topic = String(args.topic || '').trim();
      if (!memoryTopicValid(topic)) return makeToolResult('error', 'Tool error: invalid topic');
      const guard = memoryPathGuard(topic); // A2-01
      if (guard) return makeToolResult('error', guard);
      try { deleteStateFile(memoryFilePath(topic)); return makeToolResult('ok', `[OK] Memory note deleted: ${topic}.md`); }
      catch (e) { return makeToolResult('error', `Tool error: cannot delete memory note "${topic}": ${e.message}`); }
    }
    return makeToolResult('error', 'Tool error: memory_tool requires action=save|read|list|delete');
  }

  if (name === 'list_mcp_resources_tool') {
    try {
      const safeDir = internalStatePath('.mcp');
      fs.mkdirSync(safeDir, { recursive: true });
      const scan = readDirectoryEntriesBounded(safeDir, { deadlineAt: cancelled && cancelled.deadlineAt, cancelled });
      return makeToolResult('ok', (scan.incomplete ? '[incomplete: ' + scan.incomplete + ']\n' : '') + (scan.entries.map(e => e.name).join('\n') || (scan.incomplete ? 'No resources collected' : 'No MCP resources')));
    } catch (e) { return makeToolResult(cancelled && cancelled() ? 'cancelled' : 'error', `MCP resource list error: ${e.message}`); }
  }
  if (name === 'read_mcp_resource_tool') {
    try {
      const resPath = internalStatePath('.mcp', args.resource_id || '');
      const resReal = realPathSafe(resPath);
      // internalStatePath already verifies the .mcp root and every existing
      // prefix before this final real-path read.
      return makeToolResult('ok', decodeUtf8Text(readFileBytesBounded(resReal, 4 * 1024 * 1024, 'MCP resource')));
    } catch (e) {
      return makeToolResult('error', e.code === 'ENOENT' || /^Security:/.test(e.message)
        ? 'Resource not found (paths outside the .mcp directory are blocked)' : 'Resource read error: ' + e.message);
    }
  }

  if (name === 'mcp_tool') {
    const { tool_name: toolName, args: toolArgs = {}, server, mcp_url, npx_pkg } = args;

    // GAP-1: real MCP stdio transport - server names come from mcp.json /
    // .7coder/mcp.json (see loadMcpServers), JSON-RPC over the child's pipes.
    if (typeof server === 'string' && server.trim()) {
      const sv = server.trim();
      if (!mcpServers[sv]) {
        const names = Object.keys(mcpServers);
        return makeToolResult('error', `MCP error: unknown server "${sv}". Configured: ${names.length ? names.join(', ') : '(none - add one to .7coder/mcp.json)'}.`);
      }
      try {
        return makeToolResult('ok', await getMcpClient(sv, cancelled).callTool(String(toolName || ''), toolArgs, cancelled));
      } catch (e) {
        if (cancelled && cancelled()) return makeToolResult('cancelled', `[aborted: MCP cancelled; sent requests may have unknown effects] ${e.message}`);
        return makeToolResult('error', `MCP tool error (${sv}/${toolName}): ${e.message}`);
      }
    }

    const effectiveUrl = mcp_url || MCP_SERVER_URLS[0] || null;
    const effectiveNpx = npx_pkg || (MCP_NPX_PKGS.length ? MCP_NPX_PKGS[0] : null);

    if (effectiveUrl) {
      console.log(`[WEB] Calling external MCP server: ${effectiveUrl} / ${toolName}`);
      try {
        const payload = { tool: toolName, arguments: toolArgs };
        const res = await executionHttp({ method: 'post', url: `${effectiveUrl.replace(/\/$/, '')}/invoke`, data: payload,
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000, maxContentLength: 4 * 1024 * 1024, maxBodyLength: 4 * 1024 * 1024
        }, cancelled);
        const responsePayload = res.data;
        const failed = responsePayload && typeof responsePayload === 'object' && (responsePayload.isError === true || (responsePayload.jsonrpc === '2.0' && responsePayload.error != null));
        return makeToolResult(failed ? 'error' : 'ok', typeof responsePayload === 'string' ? responsePayload : stringifyJsonBounded(responsePayload, 'MCP JSON result'));
      } catch (e) {
        if (cancelled && cancelled()) return makeToolResult('cancelled', `[aborted: MCP cancelled; remote result unknown] ${e.message}`);
        const note = /Request body larger than maxBodyLength limit/.test(e.message) ? 'request body refused before sending' : 'remote result unknown; check side effects before retrying';
        return makeToolResult('error', `MCP external error (${effectiveUrl}): ${e.message}; ${note}`);
      }
    } else if (effectiveNpx) {
      console.log(`[MCP] Running MCP via npx: ${effectiveNpx} ${toolName}`);
      if (!/^[@a-zA-Z0-9._\/-]+$/.test(effectiveNpx)) {
        return makeToolResult('blocked', 'BLOCKED: npx package name contains shell metacharacters');
      }
      let argsToken = '';
      if (Object.keys(toolArgs).length) {
        const json = JSON.stringify(toolArgs);
        if (/[^a-zA-Z0-9 {}.,:_\/-]/.test(json)) {
          return makeToolResult('blocked', 'BLOCKED: MCP tool arguments contain shell metacharacters - pass simpler args or use run_command');
        }
        argsToken = json;
      }
      // A2-17: the legacy npx bridge composes a shell command - run it through
      // the hard rail explicitly (calling executeToolRaw directly skips every
      // check in safeExecuteToolInner).
      const npxCmd = `npx ${effectiveNpx} ${toolName} ${argsToken}`.trim();
      if (isSuperDangerous(npxCmd)) return makeToolResult('blocked', 'BLOCKED: Super-dangerous command prevented (even in danger mode).');
      return await executeToolRaw('run_command', { command: npxCmd }, conversation, approvalBridge, cancelled, modelContext);
    } else {
      return makeToolResult('error', `MCP error: no endpoint configured. Add servers to .7coder/mcp.json (stdio, recommended - see README), or set MCP_SERVER_URLS / MCP_NPX_PKGS in .env, or pass server/mcp_url/npx_pkg parameters. Args: ${JSON.stringify(toolArgs)}`);
    }
  }

  if (name === 'mcp_list_tools_tool') {
    // GAP-1: discovery over the configured stdio servers. Spawning is limited
    // to commands the USER put in mcp.json, which is why this stays auto-safe.
    const names = Object.keys(mcpServers);
    if (!names.length) return makeToolResult('ok', 'No MCP servers configured. Add one to .7coder/mcp.json:\n{"servers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}}');
    const out = [];
    let failed = false;
    for (const sv of names) {
      checkExecution(cancelled);
      try {
        const tools = await getMcpClient(sv, cancelled).listTools(false, cancelled);
        out.push(sv + ':');
        for (const t of tools) {
          out.push('  ' + (t.name || '?') + ' - ' + String(t.description || '').substring(0, 120));
          if (t.inputSchema) out.push('    args: ' + JSON.stringify(t.inputSchema).substring(0, 300));
        }
      } catch (e) {
        if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: MCP discovery cancelled]');
        failed = true;
        out.push(sv + ': [ERROR] ' + e.message);
      }
    }
    return makeToolResult(failed ? 'error' : 'ok', '[MCP] configured servers and tools:\n' + out.join('\n'));
  }

  if (name === 'sleep_tool') {
    const ms = parseInt(args.ms) || 1000;
    await waitForExecution(ms, cancelled);
    return makeToolResult('ok', `[OK] Slept ${ms}ms`);
  }

  if (name === 'snip_tool') {
    const history = conversation || messages;
    const start = args.start || 0;
    const end = (typeof args.end === 'number') ? args.end : history.length;
    return makeToolResult('ok', history.slice(start, end).map(m => JSON.stringify(m)).join('\n'));
  }

  if (name === 'tool_search_tool') {
    return makeToolResult('ok', tools.map(t => t.function.name).join('\n'));
  }

  if (name === 'enter_worktree_tool') {
    try {
      const rel = sanitizePath(args.path || 'worktree');
      const wtPath = quoteForShell(rel);
      child_process.execSync(`git worktree add ${wtPath}`, { cwd: launchDir, timeout: 60000 });
      return makeToolResult('ok', `[OK] Entered worktree at ${args.path}`);
    } catch (e) { return makeToolResult('error', `Worktree error: ${e.message}`); }
  }

  if (name === 'schedule_cron_tool' || name === 'cron_create_tool') {
    const jobId = `cron-${Date.now()}-${++cronSeq}`;
    // Includes schedule, admission and duplicate-ID failures.
    const text = scheduleCronJob(jobId, args.schedule, args.command);
    return makeToolResult(text.startsWith('[ERROR]') ? 'error' : 'ok', text);
  }
  if (name === 'cron_delete_tool') {
    if (!args.job_id || !cronJobs.has(args.job_id)) {
      return makeToolResult('error', 'Cron job not found: ' + (args.job_id || '(no job_id provided)'));
    }
    const job = cronJobs.get(args.job_id);
    const stopped = await stopCronJob(job);
    if (!stopped.closed) return makeToolResult('error', `Cron job disabled but retained: ${stopped.message}`);
    if (cronJobs.get(args.job_id) === job) cronJobs.delete(args.job_id);
    return makeToolResult('ok', `[OK] Cron job deleted. ${stopped.message}`);
  }
  if (name === 'cron_list_tool') {
    if (!cronJobs.size) return makeToolResult('ok', 'No cron jobs');
    return makeToolResult('ok', Array.from(cronJobs.entries()).map(([id, j]) =>
      `${id} | schedule: ${j.schedule} | runs: ${j.runs} | ${j.stopped ? 'disabled' : 'scheduled'} | running: ${j.running} | next: ${!j.stopped && j.nextRun ? new Date(j.nextRun).toISOString() : 'n/a'}${j.lastError ? ` | lastError: ${j.lastError}` : ''}`
    ).join('\n'));
  }

  if (name === 'skill_tool') {
    const skillName = String(args.skill_name || '').trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(skillName)) {
      return makeToolResult('error', 'Skill error: skill_name must be a simple name (letters, digits, dot, dash, underscore)');
    }
    const skillPath = internalStatePath('.7coder/skills', skillName + '.md');
    try {
      const content = decodeUtf8Text(readFileBytesBounded(skillPath, 1024 * 1024, 'Skill file'));
      const paramsJson = (args.params && Object.keys(args.params).length)
        ? `\n\nCaller-provided params:\n${stringifyJsonBounded(args.params, 'Skill params')}`
        : '';
      return makeToolResult('ok', `Executing skill "${skillName}". Follow these instructions:\n\n${content}${paramsJson}`);
    } catch (e) {
      if (e.code !== 'ENOENT') return makeToolResult('error', 'Skill read error: ' + e.message);
      let available = 'none';
      try {
        const scan = readDirectoryEntriesBounded(internalStatePath('.7coder/skills'), { deadlineAt: cancelled && cancelled.deadlineAt, cancelled });
        available = scan.entries.filter(e => e.name.endsWith('.md')).map(e => e.name).join(', ') || 'none';
        if (scan.incomplete) available = '[incomplete: ' + scan.incomplete + '] ' + available;
      } catch (e2) { if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: skill listing cancelled]'); if (e2.code !== 'ENOENT') available = '[unavailable: ' + e2.message + ']'; }
      return makeToolResult('error', `Skill "${skillName}" not found. Available skills: ${available}. Create skills as .7coder/skills/<name>.md files.`);
    }
  }

  if (name === 'prompt_from_file') {
    try { return makeToolResult('ok', decodeUtf8Text(readFileBytesBounded(path.join(launchDir, sanitizePath(args.file)), 1024 * 1024, 'Prompt file'))); }
    catch (e) { return makeToolResult('error', e.code === 'ENOENT' ? 'File not found' : `Read error: ${e.message}`); }
  }

  if (name === 'auto_approval_return') {
    return makeToolResult('ok', args.description || 'Auto-approval handover complete');
  }

  if (name === 'computer_use') {
    const action = args.action;
    console.log(`[SCREEN] Computer use: ${action}`);
    if (action === 'screenshot') {
      // P2-13: screenshots go under .7coder/screenshots/ instead of littering
      // the workspace root (shots are one-off, so no migration is needed).
      const shotsDir = internalStatePath('.7coder/screenshots');
      try { fs.mkdirSync(shotsDir, { recursive: true }); } catch (e) {}
      const shotPath = path.join(shotsDir, `screenshot_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.png`);
      try {
        if (process.platform === 'darwin') {
          child_process.execSync(`screencapture -x "${shotPath}"`);
        } else if (process.platform === 'win32') {
          // Single-quoted PS strings treat backslashes literally; only ' needs doubling.
          const psPath = shotPath.replace(/'/g, "''");
          const ps = powerShellSpec(
            `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; ` +
            `$bmp = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); ` +
            `$gfx = [System.Drawing.Graphics]::FromImage($bmp); $gfx.CopyFromScreen(0,0,0,0,$bmp.Size); ` +
            `$bmp.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)`
          );
          child_process.execFileSync(ps.file, ps.args, { stdio: 'ignore', timeout: 30000, windowsHide: true });
        } else {
          child_process.execSync(`import -window root "${shotPath}" || scrot "${shotPath}"`, { stdio: 'ignore' });
        }
      } catch (e) {
        return makeToolResult('error', `Screenshot failed: ${e.message}`);
      }
      if (fs.existsSync(shotPath)) {
        // GAP-4 visual loop: with VISION_MODEL configured, feed the fresh
        // screenshot back to the vision model (same OpenAI-compatible endpoint
        // via describeWithVision - a data URL is a valid image_url) and append
        // the description to the tool result. Without VISION_MODEL the reply
        // stays path-only (the previous behavior).
        if (VISION_MODEL) {
          try {
            const dataUrl = screenshotToDataUrl(shotPath, true);
            const desc = await describeWithVision(dataUrl, modelContext, cancelled);
            return makeToolResult(toolResultStatus(desc), `Screenshot saved to ${shotPath}.\nVision: ${toolResultText(desc)}`, { screenshotPath: shotPath });
          } catch (e) {
            if (cancelled && cancelled()) throw e;
            return makeToolResult('error', `Screenshot saved to ${shotPath}.\nVision unavailable: ${e.message}`, { screenshotPath: shotPath });
          }
        }
        return makeToolResult('ok', `Screenshot saved to ${shotPath}`);
      }
      return makeToolResult('error', 'Screenshot failed (file was not created - is a display/session available?)');
    }
    // Real input injection (Windows): a temp .ps1 avoids triple-quoted command
    // strings; user32 mouse_event drives clicks, SendKeys drives typing/keys.
    const inputDir = internalStatePath('.7coder');
    const runPsInput = (ps) => {
      try { fs.mkdirSync(inputDir, { recursive: true }); } catch (e) {}
      const file = path.join(inputDir, 'input.ps1');
      fs.writeFileSync(file, '\ufeff' + ps, 'utf8'); // PS2 otherwise treats BOM-less scripts as ANSI
      child_process.execFileSync(powerShellExecutable(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { stdio: 'ignore', timeout: 30000, windowsHide: true });
    };
    const escapeSendKeys = (text) => {
      // Single pass, in order: \r\n and \r and \n -> {ENTER} (CRLF collapses to
      // one ENTER), \t -> {TAB}, then brace-escape SendKeys metacharacters.
      // Escaping AFTER newline insertion would leave raw braces inside {ENTER}
      // placeholders and SendKeys would re-interpret them (extra key presses).
      const s = String(text);
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (c === '\r') {
          if (s.charAt(i + 1) === '\n') i++; // consume the \n of a CRLF pair
          out += '{ENTER}';
        } else if (c === '\n') {
          out += '{ENTER}';
        } else if (c === '\t') {
          out += '{TAB}';
        } else if (c === '{') {
          out += '{{}';
        } else if (c === '}') {
          out += '{}}';
        } else if ('+^%~()[]'.indexOf(c) !== -1) {
          out += '{' + c + '}';
        } else {
          out += c;
        }
      }
      return out;
    };
    if (action === 'mouse_move' || action === 'click') {
      if (process.platform !== 'win32') return makeToolResult('error', `[WARN] ${action} is Windows-only in this build (got ${process.platform}).`);
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
        return makeToolResult('ok', `[OK] ${action === 'click' ? 'Clicked' : 'Cursor moved'} at ${x},${y}`);
      } catch (e) { return makeToolResult('error', `Input error: ${e.message}`); }
    }
    if (action === 'type_text' && args.text) {
      if (process.platform !== 'win32') return makeToolResult('error', `[WARN] type_text is Windows-only in this build (got ${process.platform}).`);
      try {
        runPsInput(
          'Add-Type -AssemblyName System.Windows.Forms;\n' +
          `[System.Windows.Forms.SendKeys]::SendWait('${escapeSendKeys(args.text).replace(/'/g, "''")}')\n` +
          'Write-Output done\n'
        );
        return makeToolResult('ok', `[OK] Typed ${String(args.text).length} character(s) via SendKeys`);
      } catch (e) { return makeToolResult('error', `Input error: ${e.message}`); }
    }
    if (action === 'press_key' && args.key) {
      if (process.platform !== 'win32') return makeToolResult('error', `[WARN] press_key is Windows-only in this build (got ${process.platform}).`);
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
        return makeToolResult('ok', `[OK] Pressed key: ${args.key}`);
      } catch (e) { return makeToolResult('error', `Input error: ${e.message}`); }
    }
    return makeToolResult('error', `[WARN] Unknown computer_use action "${action}". Available: screenshot, mouse_move, click, type_text, press_key.`);
  }

  if (name === 'workflow_tool') {
    const steps = Array.isArray(args.steps) ? args.steps : null;
    if (!steps || steps.length === 0) return makeToolResult('error', 'Workflow error: steps must be a non-empty array');
    if (steps.length > 50) return makeToolResult('error', 'Workflow error: too many steps (max 50)');
    const transcript = [];
    const stepResults = [];
    const finishWf = (stopReason, status) => {
      const head = stopReason ? ('[STOPPED] ' + stopReason) : '[OK] Workflow complete';
      return makeToolResult(status || (stopReason ? 'error' : 'ok'), head + '\n' + transcript.join('\n'), { steps: stepResults });
    };
    workflowStepDepth++;
    try {
    for (let i = 0; i < steps.length; i++) {
      if (cancelled && cancelled()) return finishWf('client disconnected', 'cancelled');
      const st = steps[i] || {};
      const toolName = typeof st.tool === 'string' ? st.tool.trim() : '';
      if (!toolName) {
        stepResults.push({ step: i + 1, tool: '', status: 'error', optional: !!st.optional });
        transcript.push('step ' + (i + 1) + ': ERROR - missing tool name');
        if (!st.optional) return finishWf('step ' + (i + 1) + ' has no tool name');
        continue;
      }
      if (toolName === 'workflow_tool') {
        stepResults.push({ step: i + 1, tool: toolName, status: 'error', optional: !!st.optional });
        transcript.push('step ' + (i + 1) + ' (' + toolName + '): ERROR - nested workflows are not allowed');
        return finishWf('nested workflow at step ' + (i + 1));
      }
      if (!tools.some(t => t.function.name === toolName)) {
        stepResults.push({ step: i + 1, tool: toolName, status: 'error', optional: !!st.optional });
        transcript.push('step ' + (i + 1) + ' (' + toolName + '): ERROR - unknown tool');
        if (!st.optional) return finishWf('unknown tool at step ' + (i + 1));
        continue;
      }
      const stepArgs = (st.args && typeof st.args === 'object' && !Array.isArray(st.args)) ? st.args : {};
      const res = await safeExecuteTool({ function: { name: toolName, arguments: JSON.stringify(stepArgs) } }, conversation, approvalBridge, cancelled, modelContext);
      const firstLine = toolResultText(res).split('\n')[0];
      const stepStatus = cancelled && cancelled() ? 'cancelled' : toolResultStatus(res);
      stepResults.push({ step: i + 1, tool: toolName, status: stepStatus, optional: !!st.optional });
      transcript.push('step ' + (i + 1) + ' (' + toolName + '): ' + firstLine.substring(0, 160));
      if (stepStatus === 'cancelled') return finishWf('step ' + (i + 1) + ' cancelled', 'cancelled');
      if (!st.optional && toolFailed(res)) {
        transcript.push('(stopped after failed step ' + (i + 1) + ')');
        return finishWf('step ' + (i + 1) + ' failed', stepStatus === 'ok' ? 'error' : stepStatus);
      }
    }
    return finishWf(null);
    } finally {
      try { if (agentDepth === 0) disposePersistentShell('wf-' + workflowStepDepth); }
      finally { workflowStepDepth--; }
    }
  }

// ====================== TEST RUNNER PARSING (D2) ======================
// Turns noisy test-runner output into structured counts the model can act on.
function parseTestOutput(text) {
  // OP2-1: cap the scanned text first - the old (\d+)+ patterns (now fixed)
  // were an exponential-backtracking regex, and even a linear scan has no
  // business walking an unbounded command dump. Counts live near the summary,
  // so the tail is where they appear.
  const t = String(text).substring(String(text).length > 65536 ? String(text).length - 65536 : 0);
  const num = (re) => { const m = t.match(re); return m ? parseInt(m[1], 10) : null; };
  let passed = num(/(\d+)\s+pass(?:ing|ed)?/i);
  let failed = num(/(\d+)\s+fail(?:ing|ed)?/i) || num(/#\s*fail\s+(\d+)/i);
  const skipped = num(/(\d+)\s+skipped/i) || num(/#\s*skipped\s+(\d+)/i);
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

function supportsBuiltinTestRunner(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major >= 19 || (major === 18 && minor >= 1) || (major === 16 && minor >= 17);
}

  if (name === 'run_tests_tool') {
    checkExecution(cancelled);
    let command = String(args.command || "").trim();
    let spec = null;
    let autoNpm = false;
    if (!command) {
      try {
        const pkgPath = path.join(launchDir, 'package.json');
        const pkg = readOptionalJsonConfig(pkgPath, 'Test package manifest');
        if (pkg !== undefined) {
          if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return makeToolResult('error', 'Tests error: package.json must contain an object.');
          if (pkg.scripts !== undefined && (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts))) return makeToolResult('error', 'Tests error: package.json scripts must be an object.');
          const script = pkg && pkg.scripts && pkg.scripts.test;
          if (script !== undefined && typeof script !== 'string') return makeToolResult('error', 'Tests error: package.json scripts.test must be a string.');
          if (script && script.trim()) { command = "npm test --silent"; autoNpm = true; }
        }
      } catch (e) { return makeToolResult('error', 'Tests error: cannot read/parse package.json: ' + e.message); }
    }
    if (!command) {
      try {
        const scan = readDirectoryEntriesBounded(launchDir, { maxEntries: 1000, deadlineAt: Math.min(Date.now() + 5000, cancelled && cancelled.deadlineAt || Infinity), cancelled });
        const hasTests = scan.entries.some(e => /\.test\.js$/i.test(e.name) && fs.statSync(path.join(launchDir, e.name)).isFile());
        if (!hasTests && scan.incomplete) return makeToolResult('error', 'Tests error: test-file discovery incomplete (' + scan.incomplete + '); supply an explicit command. No tests were started.', { exitCode: null });
        if (hasTests) {
          if (!supportsBuiltinTestRunner(process.versions.node)) return makeToolResult('error', 'Tests error: Agent Node ' + process.versions.node + ' does not support --test. Supply an explicit command for this project\'s test framework; no tests were started.', { exitCode: null });
          spec = { file: process.execPath, args: ['--test'] };
          command = '"' + process.execPath + '" --test'; // display only; execFile receives argv
        }
      } catch (e) { return makeToolResult('error', 'Tests error: cannot inspect test files: ' + e.message); }
    }
    if (!command) return makeToolResult('error', "Tests error: no command given and nothing to auto-detect (no scripts.test, no *.test.js).");
    if (autoNpm) {
      const npm = findOptionalExecutable('npm');
      if (!npm) return makeToolResult('error', 'Tests prerequisite error: package scripts.test requires npm, but npm was not found on PATH. The bundled Node runtime does not include npm. Prepare a compatible npm offline or supply an explicit framework command; no tests were started.', { exitCode: null });
      try { command = quoteForShell(npm) + ' test --silent'; }
      catch (e) { return makeToolResult('error', 'Tests prerequisite error: npm path cannot be safely passed to the shell: ' + e.message, { exitCode: null }); }
    }
    const timeoutMs = Math.max(10, Math.min(600, parseInt(args.timeout_seconds, 10) || 120)) * 1000;
    console.log("[TESTS] running: " + command);
    let out = "";
    let exitStatus = 0;
    // AST-09: async - a test run can hold the old sync call for up to 600s,
    // freezing the whole HTTP server for its entire duration.
    checkExecution(cancelled);
    const { r: cmdR, aborted } = await awaitCommandCancellable(runCommandAsync(spec || { cmd: withUtf8Codepage(command) }, { timeout: timeoutMs }), cancelled);
    if (aborted) return makeToolResult('cancelled', '[aborted: client disconnected]');
    // callback-args stdout/stderr are authoritative on failure (the error
    // object's copies are not populated consistently across exec backends)
    out = (cmdR.stdout || "") + (cmdR.stderr || "");
    if (cmdR.error) {
      exitStatus = (typeof cmdR.error.code === 'number') ? cmdR.error.code : (cmdR.error.status !== undefined ? cmdR.error.status : 1);
    }
    const r = parseTestOutput(out);
    // OPT-13: exit codes and parsed failures determine status independently
    // of wording. Keep the existing text protocol for the model.
    const status = exitStatus !== 0 || (r.failed || 0) > 0 || r.failures.length > 0 ? 'error' : 'ok';
    const data = { exitCode: exitStatus, parsed: r.parsed, passed: r.passed,
      failed: r.failed, skipped: r.skipped, total: r.total, failures: r.failures };
    if (!r.parsed) {
      if (exitStatus !== 0) return makeToolResult(status, "Tests error: command finished with exit " + exitStatus + " but no recognizable summary.\nOutput tail:\n" + out.substring(out.length - 2000), data);
      return makeToolResult(status, "[TESTS] command finished (exit=" + exitStatus + ") but no recognizable summary.\nOutput tail:\n" + out.substring(out.length - 2000), data);
    }
    let res = (exitStatus !== 0 ? "Tests error:" : "[TESTS]") + " exit=" + exitStatus + " " + (r.passed || 0) + " passed, " + (r.failed || 0) + " failed, " + (r.skipped || 0) + " skipped (of " + r.total + ").";
    res += '\n';
    res += (r.failures.length ? "Failures:\n" + r.failures.join('\n') : (r.failed || 0) > 0 ? 'Failures: ' + r.failed + ' reported (no failure details).' : "All green.");
    res += "\n\nRaw tail:\n" + out.substring(out.length - 1500);
    return makeToolResult(status, res, data);
  }

// ====================== DIAGNOSTICS FORMATTING (GAP-5) ======================
// One header line + per-problem '  <file>:<line> <code> <msg>' lines, capped.
function formatDiagResult(toolLabel, problems, status) {
  const data = { toolchain: toolLabel, problems };
  if (!problems.length) return makeToolResult(status || 'ok', '[DIAG] clean (0 problems)', data);
  const CAP = 50;
  const lines = problems.slice(0, CAP).map(p => '  ' + p.file + ':' + p.line + ' ' + p.code + ' ' + String(p.msg || '').substring(0, 120));
  let out = '[DIAG] ' + toolLabel + ': ' + problems.length + ' 个问题\n' + lines.join('\n');
  if (problems.length > CAP) out += '\n  ... and ' + (problems.length - CAP) + ' more problems (truncated to ' + CAP + ')';
  return makeToolResult(status || 'error', out, data);
}

  if (name === 'diagnostics_tool') {
    // GAP-5: project-local toolchain diagnostics. Only binaries inside THIS
    // workspace's node_modules are ever executed (node <bin> via execFile -
    // never a shell string, never a global install). A2-03: these binaries run
    // project-defined JavaScript, so the tool is NOT auto-safe - it reaches
    // here only after the permission gate approved it.
    try {
      const tscBin = path.join(launchDir, 'node_modules', 'typescript', 'bin', 'tsc');
      const eslintBin = path.join(launchDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
      const problems = [];
      if (fs.existsSync(tscBin)) {
        // args.path is deliberately ignored for tsc: `tsc --noEmit <file>`
        // bypasses the project tsconfig and reports a different problem set
        // than the project build - diagnostics stay whole-project instead.
        const { r, aborted } = await awaitCommandCancellable(runCommandAsync({ file: process.execPath, args: [tscBin, '--noEmit'] }, { timeout: 120000 }), cancelled);
        if (aborted) return makeToolResult('cancelled', '[aborted: client disconnected]');
        // exit 2 is tsc's "has errors" - the callback's stdout still carries the list
        for (const line of String(r.stdout || '').split('\n')) {
          const m = line.match(/^([^(]+)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
          if (m) problems.push({ file: m[1].trim(), line: m[2], code: m[4], msg: m[5] });
        }
        if (!problems.length && r.error && !String(r.stdout || '').trim() && !String(r.stderr || '').trim()) {
          return makeToolResult('error', 'Diagnostics error: tsc failed: ' + (r.error.message || 'exit ' + r.error.code));
        }
        // A2-11: global tsc errors (e.g. "error TS18003: No inputs were found.")
        // carry no file(line,col) shape, so the loop above misses them and a
        // failing tsc was reported as '[DIAG] clean (0 problems)'. With no
        // line-level problems, surface bare 'error TS' lines (truncated to 160
        // chars each) whenever tsc exited non-zero or the output carries them;
        // only an empty set with exit 0 stays clean.
        if (!problems.length) {
          const tscOut = String(r.stdout || '') + '\n' + String(r.stderr || '');
          const tscFailed = !!r.error;
          const additional = tscOut.split('\n')
            .filter(l => /error TS\d+/.test(l))
            .map(l => l.trim().substring(0, 160));
          if (additional.length) {
            return makeToolResult('error', '[DIAG] tsc: ' + additional.length + ' 个问题\n' + additional.map(l => '  ' + l).join('\n'), { toolchain: 'tsc', globalErrors: additional });
          }
          if (tscFailed) {
            return makeToolResult('error', 'Diagnostics error: tsc failed: exit ' + r.error.code + (String(r.stderr || '').trim() ? (' | ' + String(r.stderr).trim().substring(0, 200)) : ''));
          }
        }
        return formatDiagResult('tsc', problems);
      }
      if (fs.existsSync(eslintBin)) {
        let target = '.';
        if (args.path && String(args.path).trim()) {
          try { target = sanitizePath(String(args.path).trim()) || '.'; } catch (e2) { return makeToolResult('error', 'Diagnostics error: ' + e2.message); }
        }
        const { r, aborted } = await awaitCommandCancellable(runCommandAsync({ file: process.execPath, args: [eslintBin, '--format', 'json', target] }, { timeout: 120000 }), cancelled);
        if (aborted) return makeToolResult('cancelled', '[aborted: client disconnected]');
        let rows = null;
        try { rows = JSON.parse(String(r.stdout || 'null')); } catch (e2) { rows = null; }
        if (!Array.isArray(rows)) {
          return makeToolResult('error', 'Diagnostics error: eslint output was not valid JSON' + (r.error ? (': ' + r.error.message) : '') + (String(r.stderr || '').trim() ? (' | ' + String(r.stderr).trim().substring(0, 200)) : ''));
        }
        for (const f of rows) {
          for (const msg of (f.messages || [])) {
            problems.push({ file: f.filePath, line: msg.line, code: msg.ruleId || '(no rule)', msg: msg.message, severity: msg.severity });
          }
        }
        if (!problems.length && r.error) return makeToolResult('error', 'Diagnostics error: eslint failed: ' + (r.error.message || 'exit ' + r.error.code));
        return formatDiagResult('eslint', problems.slice(0, 30), r.error || problems.some(p => p.severity !== 1) ? 'error' : 'ok');
      }
      return makeToolResult('error', 'Diagnostics: no toolchain found (install typescript or eslint in node_modules).');
    } catch (e) {
      return makeToolResult('error', 'Diagnostics error: ' + e.message);
    }
  }

// ====================== GIT INTEGRATION (D1) ======================
// AST-01: git must never go through a shell. Args are ALWAYS an array and
// user input (paths, commit messages) is passed as single argv entries, so
// quotes/separators/metacharacters can only ever be literal values.
function auditCommitMessage(cancelled) {
  checkExecution(cancelled);
  let bytes;
  try { bytes = readFileBytesBounded(internalStatePath('.7coder', 'audit.jsonl'), 5 * 1024 * 1024, 'Audit commit hints'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  checkExecution(cancelled);
  const text = bytes ? decodeUtf8Text(bytes) : '', verbs = Object.create(null), deadlineAt = Date.now() + 200;
  let offset = 0, lines = 0, incomplete = false;
  while (offset < text.length) {
    checkExecution(cancelled);
    if (lines++ >= 50000 || Date.now() >= deadlineAt) { incomplete = true; break; }
    const end = text.indexOf('\n', offset);
    if (end < 0) { incomplete = true; break; } // never infer activity from a torn record
    const line = text.slice(offset, end); offset = end + 1;
    if (!line.trim()) continue;
    if (line.length > 16384 || Buffer.byteLength(line, 'utf8') > 16384) { incomplete = true; continue; }
    try {
      const e = JSON.parse(line);
      if (e && e.type === 'tool') {
        if (typeof e.tool === 'string' && Object.prototype.hasOwnProperty.call(TOOL_METADATA, e.tool)) verbs[e.tool] = (verbs[e.tool] || 0) + 1;
        else incomplete = true;
      }
    } catch (e) { incomplete = true; }
  }
  const top = Object.keys(verbs).sort((a, b) => verbs[b] - verbs[a]).slice(0, 3);
  return 'chore: session changes (' + (top.length ? 'tools: ' + top.join(', ') : 'no tool activity') + (incomplete ? '; partial audit' : '') + ')';
}

function git(argsArr, opts) {
  return child_process.execFileSync('git', argsArr, Object.assign({ encoding: "utf8", cwd: launchDir, timeout: 30000 }, opts || {}));
}
function inGitRepo() {
  try {
    git(["rev-parse", "--is-inside-work-tree"], { stdio: "pipe", env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' }) });
    return true;
  } catch (e) {
    // Only the actual non-repository diagnosis is an ordinary empty result.
    // Missing/broken Git, ACL/config errors and loader failures are faults.
    if (e.status === 128 && /not a git repository/i.test(String(e.stderr || ''))) return false;
    if (e.code === 'ENOENT') throw new Error('Git executable not found on PATH (ENOENT); prepare a Win7-compatible Git before using Git tools.');
    throw e;
  }
}

  if (name === 'git_status_tool') {
    try {
      if (!inGitRepo()) return makeToolResult('ok', "Not a git repository (no .git found in the workspace).");
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      const last = git(["log", "-1", "--oneline"]).trim();
      // The leading space is the index column of XY, not presentation padding.
      const status = git(["status", "--short"]).replace(/(?:\r?\n)+$/, '');
      const linesN = status ? status.split(/\r?\n/) : [];
      const counts = { staged: 0, modified: 0, untracked: 0 };
      for (const l of linesN) {
        const x = l.charAt(0), y = l.charAt(1);
        if (x !== " " && x !== "?") counts.staged++;
        if (y !== " " && y !== "?") counts.modified++;
        if (l.startsWith("??")) counts.untracked++;
      }
      let out = "[GIT] branch " + branch + " | last: " + last + " | staged:" + counts.staged + " modified:" + counts.modified + " untracked:" + counts.untracked;
      if (status) out += "\n" + status.substring(0, 4000);
      return makeToolResult('ok', out);
    } catch (e) { return makeToolResult('error', "Git status error: " + e.message); }
  }

  if (name === 'git_diff_tool') {
    try {
      if (!inGitRepo()) return makeToolResult('ok', "Not a git repository.");
      const diffArgs = ["diff"];
      if (args.staged) diffArgs.push("--cached");
      const hasPath = typeof args.path === "string" && args.path.trim();
      if (hasPath) { diffArgs.push("--", sanitizePath(args.path)); } // path is ONE argv entry - never shell-parsed
      const diff = git(diffArgs).trim();
      if (!diff) return makeToolResult('ok', "[GIT] no changes" + (args.staged ? " (staged)" : "") + (hasPath ? " for " + args.path : "") + ".");
      return makeToolResult('ok', "[GIT] diff" + (args.staged ? " (staged)" : "") + ":\n" + diff.substring(0, 8000));
    } catch (e) { return makeToolResult('error', "Git diff error: " + e.message); }
  }

  if (name === 'git_commit_tool') {
    try { if (!inGitRepo()) return makeToolResult('error', "Not a git repository."); }
    catch (e) { return makeToolResult('error', 'Git prerequisite error: ' + e.message); }
    let message = (typeof args.message === "string" && args.message.trim()) ? args.message.trim() : "";
    if (!message) {
      // Generate from the session audit log (most common tool verbs of this session)
      try {
        message = auditCommitMessage(cancelled);
      } catch (e) { checkExecution(cancelled); console.warn('[GIT] Automatic message hints unavailable: ' + runtimeText(e.message)); message = "chore: session changes"; }
    }
    try {
      // Pre-commit snapshot for recovery: stash create keeps it retrievable without touching the tree
      let snapshot = "";
      try { snapshot = recordOwnedGitSnapshot(git, 'commit'); } catch (e) { console.warn('[WARN] pre-commit snapshot failed: ' + e.message); }
      // AST-04: .7coder/ holds secrets (models.json apiKeys, audit log).
      // Keep it out of commits via pathspec exclusion - we never edit the
      // user's .gitignore and never untrack files they committed on purpose;
      // add -A just cannot sweep .7coder/ in anymore.
      if (args.stage_all !== false) git(["add", "-A", "--", ":(exclude).7coder/", ":(exclude,glob)**/*.7coder-*"]);
      const staged = git(["diff", "--cached", "--name-only"]).trim();
      if (!staged) return makeToolResult('ok', "[GIT] nothing to commit (no staged changes).");
      git(["commit", "-m", message]); // message is ONE argv entry - no shell quoting at all
      const last = git(["log", "-1", "--oneline"]).trim();
      return makeToolResult('ok', "[OK] committed: " + last + (snapshot ? "\n(snapshot " + snapshot.substring(0, 12) + " recorded for recovery)" : ""));
    } catch (e) { return makeToolResult('error', "Git commit error: " + e.message); }
  }

  if (name === 'synthetic_output_tool') {
    const schema = args.schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !schema.properties) {
      return makeToolResult('error', 'Synthetic output error: schema must be an object with a "properties" map');
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
          { modelContext, cancel: cancelled, useTools: false, temperature: 0.2 }
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
        return makeToolResult('ok', JSON.stringify(obj, null, 2));
      } catch (e) {
        if (cancelled && cancelled()) throw e;
        lastError = e.message;
      }
    }
    return makeToolResult('error', `Synthetic output error: ${lastError}`);
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
      const lightChoice = await callOpenAI([{ role: 'user', content: lightPrompt }], { model: modelContext ? modelContext.light : LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, useTools: false, maxTokens: 1000 });
      checkExecution(cancelled);
      const content = lightChoice && lightChoice.message && lightChoice.message.content;
      if (typeof content !== 'string') throw new Error('Plan response has no text content');
      const planData = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      if (!planData || typeof planData.improved_prompt !== 'string' || !planData.improved_prompt.trim()) throw new Error('Plan response requires a nonempty improved_prompt');
      const loops = typeof planData.refinement_loops === 'string' && /^[1-5]$/.test(planData.refinement_loops.trim()) ? Number(planData.refinement_loops) : planData.refinement_loops;
      if (!Number.isInteger(loops) || loops < 1 || loops > 5) throw new Error('Plan refinement_loops must be an integer from 1 to 5');
      return makeToolResult('ok', `PLAN MODE ACTIVATED BY SMALL MODEL\nImproved prompt:\n${planData.improved_prompt}\nRefinement loops: ${loops}\n\nHeavy model: Use the improved prompt above and perform exactly ${loops} refinement iterations before final answer.`);
    } catch (e) {
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: plan mode cancelled]');
      return makeToolResult('error', `Plan mode error: ${e.message}. Original task preserved; no plan was activated.`);
    }
  }

  // Bickering Tool - 2 small-model PM sub-agents debate until agreement
  if (name === 'bickering_tool') {
    try {
    if (!Number.isInteger(BICKER_ROUNDS) || BICKER_ROUNDS < 1 || BICKER_ROUNDS > 20) return makeToolResult('error', 'Bickering error: BICKER_ROUNDS must be 1 through 20');
    const task = String(args.task || 'No task provided');
    console.log(`Bickering Tool started - 2 PM sub-agents debating "${task.substring(0, 60)}..." for up to ${BICKER_ROUNDS} rounds`);
    let messagesPM1 = [{ role: 'system', content: `You are PM1, a strict product manager. Argue aggressively for the most robust, safe, scalable approach.` }];
    let messagesPM2 = [{ role: 'system', content: `You are PM2, a pragmatic product manager. Argue for the fastest, simplest, most practical approach.` }];
    let round = 0;
    let agreement = null;

    while (round < BICKER_ROUNDS && !agreement) {
      checkExecution(cancelled);
      round++;
      // PM1 speaks
      messagesPM1.push({ role: 'user', content: `Round ${round}: Debate the best way to ${task}. Reply in 1-2 sentences.` });
      const pm1Resp = await callOpenAI(messagesPM1, { model: modelContext ? modelContext.light : LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, useTools: false, maxTokens: 300 });
      checkExecution(cancelled);
      if (!pm1Resp || !pm1Resp.message || typeof pm1Resp.message.content !== 'string' || !pm1Resp.message.content.trim()) throw new Error('PM1 returned no text');
      const pm1Text = pm1Resp.message.content.trim();
      messagesPM1.push({ role: 'assistant', content: pm1Text });

      // PM2 responds
      messagesPM2.push({ role: 'user', content: `Round ${round}: PM1 said "${pm1Text}". Counter or agree in 1-2 sentences.` });
      const pm2Resp = await callOpenAI(messagesPM2, { model: modelContext ? modelContext.light : LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, useTools: false, maxTokens: 300 });
      checkExecution(cancelled);
      if (!pm2Resp || !pm2Resp.message || typeof pm2Resp.message.content !== 'string' || !pm2Resp.message.content.trim()) throw new Error('PM2 returned no text');
      const pm2Text = pm2Resp.message.content.trim();
      messagesPM2.push({ role: 'assistant', content: pm2Text });

      console.log(`Round ${round}: PM1: ${pm1Text} | PM2: ${pm2Text}`);

      // Check for agreement
      const agreementPrompt = `Do these two statements show clear agreement on a plan? Reply ONLY YES or NO.\nPM1: ${pm1Text}\nPM2: ${pm2Text}`;
      const agreeCheck = await callOpenAI([{ role: 'user', content: agreementPrompt }], { model: modelContext ? modelContext.light : LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, useTools: false });
      checkExecution(cancelled);
      const agreeAnswer = String(agreeCheck && agreeCheck.message && agreeCheck.message.content || '').replace(/[*'`"“”’‘.]/g, '').trim().toUpperCase();
      if (!['YES', 'NO'].includes(agreeAnswer)) throw new Error('Agreement verdict must be YES or NO');
      if (agreeAnswer === 'YES') {
        agreement = `Agreed plan after ${round} rounds: ${pm2Text}`;
      }
    }

    if (!agreement) agreement = `No full agreement after ${BICKER_ROUNDS} rounds. Best compromise: ${messagesPM2[messagesPM2.length-1].content}`;
    return makeToolResult('ok', `[OK] Bickering complete - ${agreement}`, { rounds: round, agreed: !agreement.startsWith('No full agreement') });
    } catch (e) {
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: bickering cancelled]');
      return makeToolResult('error', 'Bickering error: ' + e.message);
    }
  }

  // Passive process observation plus bounded repair; never inject into an
  // unverified foreground window or start another debug cycle recursively.
  if (name === 'auto_debug_tool') {
    if (!ENABLE_AUTO_DEBUG) return makeToolResult('blocked', 'Auto-debug disabled in .env (ENABLE_AUTO_DEBUG=false).');
    if (autoDebugActive) return makeToolResult('error', 'Auto-debug reentry refused: another debug/repair cycle is active.');
    autoDebugActive = true;
    try {
      const filePath = path.join(launchDir, sanitizePath(args.path));
      const appType = args.type || (filePath.endsWith('.exe') || filePath.endsWith('.cs') ? 'gui' : 'cli');
      const duration = Math.max(2, Math.min(5, Number(args.duration_minutes) || DEBUG_TEST_MINUTES));
      let fixRound = 0;
      while (true) {
        checkExecution(cancelled);
        if (filePath.endsWith('.cs')) {
          // Recompile after every repair; retesting an old .exe cannot prove
          // that a change to its .cs source fixed the failure.
          const compiler = findCSharpCompiler();
          if (!compiler) return makeToolResult('error', 'Auto-debug prerequisite error: C# compiler csc was not found on PATH or in the installed Windows .NET Framework directories. Prepare a compatible compiler/runtime offline; no compilation or target process was started.');
          const compiled = await awaitCommandCancellable(runCommandAsync({ file: compiler,
            args: ['/target:winexe', filePath, '/out:' + filePath.slice(0, -3) + '.exe']
          }, { timeout: 120000 }), cancelled);
          checkExecution(cancelled);
          if (compiled.r.error) return makeToolResult('error', `[ERROR] Compile failed: ${compiled.r.error.message}\n${compiled.r.stderr || ''}`);
        }
        const exePath = filePath.endsWith('.cs') ? filePath.slice(0, -3) + '.exe' : filePath;
        const cycle = await runDebugCycle(exePath, filePath, appType, fixRound === 0 ? duration : 1, cancelled);
        checkExecution(cancelled);
        const finalLog = (cycle.log + '\nSTDOUT:\n' + cycle.stdout + '\nSTDERR:\n' + cycle.stderr).slice(0, 16000);
        const data = { fixRounds: fixRound, exitCode: cycle.stoppedByAgent ? null : cycle.exitCode,
          signal: cycle.signal, observationOnly: appType === 'gui', cleanupFailed: cycle.cleanupFailed };
        const failed = cycle.spawnFailed || cycle.cleanupFailed || cycle.outputExceeded || cycle.ioError ||
          (!cycle.stoppedByAgent && (cycle.exitCode !== 0 || !!cycle.signal)) || /error|exception|crash|failed/i.test(cycle.stdout + '\n' + cycle.stderr);
        if (!failed) return makeToolResult('ok', `[OK] Auto-debug observation complete - ${fixRound} fix round(s).` +
          (appType === 'gui' ? ' GUI behavior was not validated; no desktop input was sent.' : '') + `\n${finalLog}`, data);
        if (cycle.spawnFailed || cycle.cleanupFailed || cycle.outputExceeded || cycle.ioError || fixRound >= 3) {
          return makeToolResult('error', `[ERROR] Auto-debug did not complete cleanly after ${fixRound} fix round(s).\n${finalLog}`, data);
        }
        fixRound++;
        const fixMessages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Repair the observed app failure. Do not invoke auto_debug_tool recursively.\nPath: ${args.path}\nRecent logs:\n${finalLog.slice(0, 8000)}\nRead the source and fix it via write_file.` }
        ];
        await processWithTools(fixMessages, { cancel: cancelled, modelContext });
        checkExecution(cancelled);
      }
    } catch (e) {
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: auto-debug cancelled; check completed side effects]');
      return makeToolResult('error', `[ERROR] Auto-debug failed: ${e.message}`);
    } finally { autoDebugActive = false; }
  }

  return `Unknown tool: ${name}`;
}

// One launch + observe + kill cycle for auto_debug_tool.
async function runDebugCycle(exePath, filePath, appType, durationMinutes, cancelled) {
  checkExecution(cancelled);
  let cmdToRun = exePath;
  let cmdArgs = [];
  let childEnv;
  if (filePath.endsWith('.js')) {
    cmdToRun = process.execPath;
    cmdArgs = [filePath];
  } else if (filePath.endsWith('.py')) {
    cmdToRun = findOptionalExecutable(process.platform === 'win32' ? 'python' : 'python3') ||
      (process.platform === 'win32' ? findOptionalExecutable('python3') : null);
    if (!cmdToRun) throw new Error('Python prerequisite missing on PATH; prepare a compatible interpreter offline. No target process was started.');
    cmdArgs = [filePath];
  } else if (filePath.endsWith('.sh')) {
    const discovered = process.platform === 'win32' ? findBash() : findOptionalExecutable('bash');
    if (!discovered) throw new Error('Bash prerequisite missing; prepare a compatible Git Bash/bash offline. No target process was started.');
    cmdToRun = persistentBashExecutable(discovered);
    childEnv = persistentBashEnvironment(cmdToRun);
    cmdArgs = [filePath];
  } else if (filePath.endsWith('.bat') || filePath.endsWith('.cmd')) {
    cmdToRun = process.env.ComSpec || 'cmd.exe';
    if (/["%!^&|<>\r\n]/.test(filePath)) throw new Error('Unsupported cmd script path characters');
    cmdArgs = ['/d', '/s', '/c', '""' + filePath + '""'];
  }

  checkExecution(cancelled);
  const result = { log: appType === 'gui' ? '[WARN] Passive GUI observation only; automatic desktop input disabled.\n' : '',
    stdout: '', stderr: '', spawnFailed: false, exitCode: null, signal: null,
    stoppedByAgent: false, cleanupFailed: false, outputExceeded: false, ioError: false };
  return new Promise(resolve => {
    let child, exited = false, closed = false, finished = false, stopping = false;
    let timer = null, closeTimer = null, detach = () => {}, bytes = 0;
    const log = text => { result.log = (result.log + text + '\n').slice(-4000); };
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(closeTimer); detach();
      resolve(result);
    };
    const awaitClose = () => {
      if (closed || closeTimer) return;
      closeTimer = setTimeout(() => {
        result.cleanupFailed = true; log('[ERROR] close not observed; process/descendant result unknown.');
        if (child.stdout) child.stdout.destroy();
        if (child.stderr) child.stderr.destroy();
        finish();
      }, 5000);
    };
    const stop = reason => {
      if (stopping || finished) return;
      stopping = true;
      // Use the ChildProcess handle while its own exit is unobserved. Never
      // taskkill a saved PID after the app exited (the PID may be reused).
      if (!exited && child.exitCode == null && child.signalCode == null) {
        result.stoppedByAgent = true;
        try { if (!child.kill()) { result.cleanupFailed = true; log('[ERROR] direct-child stop was not confirmed.'); } }
        catch (e) { result.cleanupFailed = true; log('[ERROR] stop failed: ' + e.message); }
      }
      log('[DEBUG] ' + reason + '; awaiting close.'); awaitClose();
    };
    try {
      child = child_process.spawn(cmdToRun, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: launchDir,
        env: childEnv,
        windowsHide: appType !== 'gui', windowsVerbatimArguments: /\.(?:bat|cmd)$/i.test(filePath) });
    } catch (e) { result.spawnFailed = true; log('[ERROR] spawn failed: ' + e.message); finish(); return; }
    // Node13 has no reliable 'spawn' event: bind error/exit/close immediately.
    child.on('error', e => {
      result.spawnFailed = true; log('[ERROR] spawn failed: ' + e.message);
      if (!child.pid) finish(); else stop('process error');
    });
    child.on('exit', (code, signal) => { exited = true; result.exitCode = code; result.signal = signal; awaitClose(); });
    child.on('close', (code, signal) => {
      closed = true; result.exitCode = code; result.signal = signal;
      log('[DEBUG] process closed: exit=' + code + ', signal=' + signal); finish();
    });
    for (const key of ['stdout', 'stderr']) if (child[key]) {
      child[key].setEncoding('utf8');
      child[key].on('data', data => {
        if (finished || result.outputExceeded) return;
        const text = String(data), size = Buffer.byteLength(text, 'utf8');
        if (bytes + size > 8 * 1024 * 1024) {
          result.outputExceeded = true; log('[ERROR] combined debug output exceeds 8 MB.'); stop('output limit'); return;
        }
        bytes += size; result[key] += text;
      });
      child[key].on('error', e => { result.ioError = true; log('[ERROR] ' + key + ': ' + e.message); stop('pipe error'); });
    }
    if (child.pid) log('[DEBUG] process started: PID ' + child.pid);
    detach = watchExecution(cancelled, () => stop('execution cancelled'));
    timer = setTimeout(() => stop('observation window ended'), Math.max(1, Math.min(300000, Number(durationMinutes) * 60000 || 60000)));
    if (finished) { clearTimeout(timer); detach(); }
  });
}

// AST-R2: reason of the most recent auto-approval decline, set inside
// safeExecuteToolInner and read back by the auditing wrapper.
let lastDeclineReason = '';

// ====================== SAFE TOOL EXECUTION ======================
// Auditing wrapper: records every tool call (args preview, status, duration)
// to .7coder/audit.jsonl, then delegates to the real implementation.
async function safeExecuteTool(toolCall, conversation, approvalBridge, cancelled, modelContext) {
  const finishRuntime = beginRuntimeOperation('tool');
  try {
  const t0 = Date.now();
  const func = toolCall.function;
  let argsPreview = {};
  try { const a = JSON.parse(func.arguments || '{}'); for (const k of Object.keys(a)) argsPreview[k] = String(JSON.stringify(a[k])).substring(0, 200); } catch (e) { argsPreview = { raw: String(func.arguments || '').substring(0, 200) }; }
  let raw = await safeExecuteToolInner(toolCall, conversation, approvalBridge, cancelled, modelContext);
  if (cancelled && cancelled() && toolResultStatus(raw) !== 'cancelled') {
    raw = makeToolResult('cancelled', '[aborted: execution cancelled; check completed side effects]\n' + toolResultText(raw));
  }
  // Current tool names are structured, including early permission/argument
  // control messages. Successful tool data is already explicitly branded.
  const res = STRUCTURED_RESULT_TOOLS.has(func.name) ? normalizeToolResult(raw) : raw;
  const first = toolResultText(res).split('\n')[0];
  const status = toolResultStatus(res);
  // GAP-12: remember mutating calls for the end-of-task [CHANGES] summary.
  // argsPreview values are the redacted/truncated audit previews - reuse them.
  if (getToolMetadata(func.name).trackChanges && taskChanges.length < 1000) {
    taskChanges.push({ tool: func.name, path: argsPreview.path || argsPreview.url || '', status: status });
  }
  // A2-18: scrub BEFORE truncating, so a token cut by the 160-char limit can
  // never survive as a recognizable prefix either.
  audit({ ts: new Date().toISOString(), type: 'tool', callId: toolCallIdentity(toolCall.id), tool: func.name, mode: effectivePermissionMode(), status, ms: Date.now() - t0, args: argsPreview, result: sanitizeAuditLine(first).substring(0, 160) });
  finishRuntime(status, { id: func.name, message: status === 'ok' ? undefined : first, exitCode: res && res.data && res.data.exitCode });
  return res;
  } catch (error) { finishRuntime('error', error); throw error; }
}

async function safeExecuteToolInner(toolCall, conversation, approvalBridge, cancelled, modelContext) {
  if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: execution cancelled]');
  const func = toolCall.function;
  let args;
  try { args = JSON.parse(func.arguments || '{}'); } catch (e) { return `Parse error: ${e.message}`; }

  try {
    const name = func.name;
    const mode = effectivePermissionMode();
    const modeRevision = effectivePermissionMode.revision || 0;
    const policyResult = () => {
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: execution cancelled]');
      const current = effectivePermissionMode();
      if (current === 'denial') return makeToolResult('blocked', 'Permission mode = denial. Action blocked.');
      if (current !== mode || (effectivePermissionMode.revision || 0) !== modeRevision) {
        return makeToolResult('declined', 'Permission mode changed while awaiting a decision; request a fresh approval before executing.');
      }
      return null;
    };
    const dispatch = async () => {
      const blocked = policyResult();
      return blocked || await executeToolRaw(name, args, conversation, approvalBridge, cancelled, modelContext);
    };

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

    // GAP-11: user deny rules block in EVERY mode (even bypass) - checked
    // before the auto-safe branch so a deny beats built-in auto-safety too.
    const denyHit = matchPermRule('deny', name, args);
    if (denyHit) {
      console.log(`[PERM] blocked by user rule: ${denyHit.raw}`);
      return `BLOCKED by user permission rule: ${denyHit.raw}`;
    }

    // AST-02: the auto-log exemption matches ONLY the workspace-root 7CODER.md
    // after path normalization - a raw-substring match let '7coder.md/../.env'
    // reach the auto-execute branch and write a protected file unapproved.
    // protectedWrite (computed from the basename) always vetoes the branch.
    let isAutoLogWrite = false;
    if (name === 'write_file' && args.path && typeof args.path === 'string') {
      // GAP-9: the model-owned memory dir (.7coder/memory/*.md) shares the
      // auto-log exemption - dream sessions and the model itself rewrite
      // these freely; they are notes, never user source code.
      try {
        const rel = path.relative(launchDir, path.join(launchDir, sanitizePath(args.path))).split(path.sep).join('/').toLowerCase();
        isAutoLogWrite = rel === '7coder.md' || (rel.indexOf('.7coder/memory/') === 0 && rel.endsWith('.md'));
      } catch (e) {}
    }
    if (!protectedRead && !protectedWrite && (getToolMetadata(name).autoSafe || isAutoLogWrite)) {
      console.log(`[TOOL] Auto-executing safe tool: ${name}`);
      return await dispatch();
    }

    // OP2-2/A2-17: EVERY tool that ultimately reaches a shell command goes
    // through the hard rail here - cron tools exec periodically, run_tests
    // execs a user-given command; leaving them off this list let bypass mode
    // schedule `rm -rf /` on a timer (README promises even bypass blocks it).
    if (['run_command', 'bash_tool', 'powershell_tool', 'task_create_tool', 'schedule_cron_tool', 'cron_create_tool', 'run_tests_tool'].includes(name)) {
      if (isSuperDangerous(args.command)) return 'BLOCKED: Super-dangerous command prevented (even in danger mode).';
    }

    if (name === 'computer_use' && !ENABLE_COMPUTER_USE) {
      return makeToolResult('blocked', 'Computer use is disabled in .env (ENABLE_COMPUTER_USE=false).');
    }

    // GAP-11: user allow rules skip ONLY the approval layer. Placement is
    // deliberate: protected files, the super-dangerous block and the
    // computer_use gate above have all already run, so an allow rule can
    // never weaken them. In bypass this is redundant (harmless).
    if (!protectedWrite && !protectedRead) {
      const allowHit = matchPermRule('allow', name, args);
      if (allowHit) {
        console.log(`[PERM] auto-executing per user allow rule: ${allowHit.raw}`);
        return await dispatch();
      }
    }

    if (mode === 'bypass' || DANGER_MODE) {
      console.log(`[TOOL] [DANGER MODE] Executing tool: ${name}`);
      // A2-06: bypass used to drop the cancellation token - a client that
      // hit Stop mid-command still ran it to completion in bypass/danger.
      return await dispatch();
    }

    // Fixed policy and model fallbacks share the same tool declaration.
    const meta = getToolMetadata(name);
    const risk = (protectedWrite || protectedRead) ? 'HIGH' : (meta.risk || await classifyRisk(name, args, modelContext, cancelled));
    const afterRisk = policyResult(); if (afterRisk) return afterRisk;
    if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: execution cancelled]');

    if (mode === 'auto') {
      // AST-03: the workflow OUTER call passes the same auto-approval screen as
      // every other tool (it once was waved through unconditionally, so even a
      // always-rejecting light model let workflows execute). Once the plan is
      // approved - by the light model in auto mode, by the user in default
      // mode - inner steps legitimately inherit that approval.
      const inheritPlan = workflowStepDepth > 0 && !protectedWrite;
      if (inheritPlan) {
        console.log('[PERM] workflow inner step inherits plan approval: ' + name);
      } else {
        // AST-R2: structured verdict - the decline carries the light model's
        // reason so the caller (and the audit log) can explain the veto.
        const verdict = await isAutoApprovalSafe(name, args, risk, modelContext, cancelled);
        const afterVerdict = policyResult(); if (afterVerdict) return afterVerdict;
        if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: execution cancelled]');
        if (!verdict.safe) {
          lastDeclineReason = verdict.reason || 'no reason given';
          audit({ ts: new Date().toISOString(), type: 'approval_decline', tool: name, mode: 'auto', reason: lastDeclineReason, argsPreview: String(JSON.stringify(args)).substring(0, 300) });
          return `Auto-approval declined by light model. Risk: ${risk}.${verdict.reason ? ' Reason: ' + verdict.reason : ''}`;
        }
      }
    } else {
      let preview = null;
      if (['write_file', 'append_file', 'edit_file'].includes(name) && args.path && typeof args.path === 'string') {
        // Show the real diff instead of an LLM paraphrase - deterministic and cheaper.
        try {
          const fullPath = path.join(launchDir, sanitizePath(args.path));
          const original = readUtf8ForWrite(fullPath, true);
          const oldText = original.text;
          let newText = oldText;
          if (name === 'edit_file') {
            const oldStr = normalizeUtf8Input(String(args.old_string === undefined ? '' : args.old_string), original.newline);
            const newStr = normalizeUtf8Input(String(args.new_string === undefined ? '' : args.new_string), original.newline);
            newText = replaceTextBounded(oldText, oldStr, newStr, args.replace_all).text;
            newText = preserveTextBom(original, newText);
          } else if (name === 'write_file') {
            newText = preserveTextBom(original, normalizeUtf8Input(String(args.content === undefined ? '' : args.content), original.newline));
          } else {
            newText = oldText + normalizeUtf8Input(String(args.content === undefined ? '' : args.content), original.newline);
          }
          preview = simpleLineDiff(oldText, newText);
        } catch (e) {
          if (e.code === 'EFILETOOLARGE') return makeToolResult('error', 'Approval preview error: ' + e.message);
          preview = null;
        }
      }
      if (preview) {
        console.log(`\n[PERM] Proposed change to ${args.path}:\n${preview}\n`);
      } else if (meta.explain) {
        console.log(`\n[PERM] ${meta.explain(args)} (risk: ${risk})`);
      } else {
        const expl = await getPermissionExplanation(name, args, risk, modelContext, cancelled);
        console.log(`\n[PERM] ${expl}`);
      }
      if (workflowStepDepth > 0 && !protectedWrite) {
        console.log('[PERM] workflow inner step inherits plan approval: ' + name);
      } else {
      const beforeQuestion = policyResult(); if (beforeQuestion) return beforeQuestion;
      const detail = name === 'workflow_tool' ? JSON.stringify(args.steps, null, 2) : (preview || JSON.stringify(args, null, 2));
      if (detail && detail.length > 65536) return makeToolResult('declined', 'Approval preview exceeds 64 KiB; split the action or workflow into smaller reviewable steps.');
      const approved = await askApproval(`Execute ${name}${protectedWrite ? ' (PROTECTED FILE - make sure you really want this)' : ''}?\n${detail || ''}\n(y/n) `, approvalBridge, cancelled);
      if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: execution cancelled]');
      if (!approved) return 'User declined the tool action.';
      }
    }

    console.log(`[TOOL] Executing approved tool: ${name}`);
    return await dispatch();
  } catch (e) {
    // Never let a tool exception kill the whole conversation - feed the error
    // back to the model so it can react.
    if (cancelled && cancelled()) return makeToolResult('cancelled', '[aborted: execution cancelled]');
    return `Tool error: ${e.message}`;
  }
}

// ====================== APPROVAL ======================
// HTTP approval bridge registry. Each streaming HTTP request creates its OWN
// bridge object (see /v1/chat/completions) and threads it down through
// processWithTools -> safeExecuteTool -> askApproval, so concurrent clients
// can never overwrite/detach each other's approvals. Ids carry a per-request
// random prefix so one connection cannot answer another's pending approval.
var approvalSeq = 0;
var pendingApprovals = new Map(); // id -> resolve

function createHttpApprovalBridge(res, cancelled) {
  let closed = false, detach = () => {};
  const bridge = {
    prefix: 'apr-' + Math.random().toString(36).substring(2, 8) + '-',
    pending: new Set(),
    ask(question, permissionRevision = 0, permissionSession = '') {
      if (closed || res.destroyed || (cancelled && cancelled())) return Promise.resolve(false);
      return new Promise(resolve => {
        const id = bridge.prefix + (++approvalSeq);
        const item = { timer: null, finish: null };
        let done = false;
        item.finish = approved => {
          if (done) return false;
          done = true;
          clearTimeout(item.timer);
          pendingApprovals.delete(id);
          bridge.pending.delete(item);
          const accepted = !!approved && !(cancelled && cancelled());
          resolve(accepted);
          return accepted;
        };
        pendingApprovals.set(id, item.finish);
        bridge.pending.add(item);
        item.timer = setTimeout(() => item.finish(false), 120000);
        try { res.write('data: ' + JSON.stringify({ approval_request: { id, question, permissionRevision, permissionSession } }) + '\n\n'); }
        catch (e) { item.finish(false); }
      });
    },
    dispose() {
      closed = true;
      detach();
      for (const item of Array.from(bridge.pending)) item.finish(false);
    }
  };
  detach = watchExecution(cancelled, () => bridge.dispose());
  return bridge;
}

// One owner of stdin questions. Never overlap readline.question callbacks:
// Node 13 retains only one callback, leaving the other Promise pending forever.
// Input dispatch below routes answers here before ordinary REPL commands.
function createCliQuestionQueue(write) {
  const queue = [];
  let closed = false;
  let poll = null;
  function isCancelled(item) { return item.cancelled && item.cancelled(); }
  function finish(item, answer) { queue.splice(queue.indexOf(item), 1); item.resolve(answer); }
  function advance() {
    if (poll) { clearInterval(poll); poll = null; }
    for (const item of queue.slice()) if (isCancelled(item)) finish(item, null);
    if (queue.length) {
      const first = queue[0];
      if (!first.shown) { first.shown = true; write(first.question); }
      if (queue.some(item => item.cancelled)) poll = setInterval(advance, 100);
    }
  }
  return {
    ask(question, cancelled) {
      if (closed || (cancelled && cancelled())) return Promise.resolve(null);
      return new Promise(resolve => { queue.push({ question, cancelled, resolve, shown: false }); advance(); });
    },
    answer(line) {
      // Consume the line even if cancellation just won the race: an answer
      // intended for a cancelled question must not become a task draft.
      if (!queue.length) return false;
      const item = queue[0];
      finish(item, isCancelled(item) ? null : line);
      advance();
      return true;
    },
    close() {
      closed = true;
      if (poll) { clearInterval(poll); poll = null; }
      for (const item of queue.splice(0)) item.resolve(null);
    },
    hasPending() { return queue.length > 0; }
  };
}

async function askApproval(question, approvalBridge, cancelled) {
  if (cancelled && cancelled()) return false;
  if (approvalBridge) {
    return approvalBridge.ask(question, effectivePermissionMode.revision || 0, PERMISSION_SESSION);
  }
  if (!INTERACTIVE || rlClosed) {
    console.log(`\n[PERM] ${question} (auto-skipped in non-interactive mode)`);
    return false;
  }
  const answer = await cliQuestions.ask(question, cancelled);
  return answer !== null && answer.toLowerCase().startsWith('y');
}

// ====================== TOOL CALLING LOOP ======================
// OPT-13: pilot tools carry authoritative status alongside legacy model text.
// The symbol identifies internal results, so arbitrary returned objects are
// never mistaken for status-bearing results. Data stays internal (not SSE).
// Batch 2 (2026-10-20): read-only tools joined - status-only migration, texts unchanged.
// Batch 3 (2026-10-20): state reads and content passthroughs - not-found texts become explicit errors.
// Batch 4 (2026-10-20): validation-gap tools - Skill/Task/Cron/PID/Agent failures become explicit errors.
// Batch 5 (2026-10-24): web/gap tools - runSubAgent failures, Fetch/Synthetic/Worktree/Screenshot
// failures become explicit errors; fetched page content stays ok.
// Batch 6 (2026-10-24): command tools - aborted commands become cancelled (was inferred ok);
// successful commands retain a non-empty stderr tail; bash-missing/non-Windows gaps closed.
// Batch 7 (2026-10-24): sweep - write/edit + misc cluster; handover description passthrough
// becomes explicitly ok; git_commit's not-a-repository (a failed WRITE intent) becomes error.
const TOOL_RESULT_MARKER = Symbol('7coder.ToolResult');
const TOOL_RESULT_STATUSES = ['ok', 'error', 'blocked', 'declined', 'cancelled'];
const STRUCTURED_RESULT_TOOLS = new Set(['run_tests_tool', 'diagnostics_tool', 'workflow_tool',
  'read_file', 'glob_tool', 'grep_tool', 'list_dir', 'git_status_tool', 'git_diff_tool', 'process_list_tool',
  'task_get_tool', 'task_list_tool', 'task_output_tool', 'memory_tool', 'list_mcp_resources_tool', 'read_mcp_resource_tool', 'prompt_from_file',
  'skill_tool', 'todo_write_tool', 'task_create_tool', 'task_stop_tool', 'cron_delete_tool', 'process_kill_tool', 'agent_tool',
  'web_fetch_tool', 'synthetic_output_tool', 'enter_worktree_tool', 'computer_use', 'schedule_cron_tool', 'cron_create_tool',
  'run_command', 'bash_tool', 'powershell_tool',
  'write_file', 'append_file', 'edit_file', 'notebook_edit_tool', 'download_tool', 'brief_tool',
  'sleep_tool', 'snip_tool', 'tool_search_tool', 'cron_list_tool', 'git_commit_tool',
  'auto_approval_return', 'ask_user_question_tool', 'web_search_tool', 'auto_debug_tool',
  'mcp_tool', 'mcp_list_tools_tool', 'web_browser_tool', 'plan_mode', 'bickering_tool']);
// Call identity is shared by SSE/audit/saved UI activities. Long model IDs
// use a stable digest instead of retaining an unbounded field or a colliding prefix.
function toolCallIdentity(id) {
  if (typeof id !== 'string' || !id) return null;
  return id.length <= 256 ? id : 'sha256:' + crypto.createHash('sha256').update(id, 'utf8').digest('hex');
}
function makeToolResult(status, text, data) {
  if (!TOOL_RESULT_STATUSES.includes(status) || typeof text !== 'string') throw new Error('Invalid ToolResult');
  const result = { [TOOL_RESULT_MARKER]: true, status, text };
  if (data !== undefined) result.data = data;
  return Object.freeze(result);
}
function isToolResult(result) { return !!result && result[TOOL_RESULT_MARKER] === true; }
function toolResultText(result) {
  return isToolResult(result) ? result.text : String(result == null ? '' : result);
}
function toolResultStatus(result) {
  if (isToolResult(result)) return result.status;
  const text = toolResultText(result);
  if (/^BLOCKED|^Permission mode = denial/.test(text)) return 'blocked';
  if (/declined/i.test(text)) return 'declined';
  return TOOL_FAIL_RE.test(text) ? 'error' : 'ok';
}
function normalizeToolResult(result) {
  return isToolResult(result) ? result : makeToolResult(toolResultStatus(result), toolResultText(result));
}
// Non-pilot tools still use the historical text-prefix contract. Do not widen
// their workflow failure rules as part of this gradual migration.
const TOOL_FAIL_RE = /^(?:\[ERROR\]|BLOCKED|Tool error|Tests error|Parse error|Read error|Write error|Append error|Edit error|Notebook error|Brief error|Download error|List error|Input error|Kill error|Workflow error|Git status error|Git diff error|Git commit error|MCP tool error|MCP error|Auto-approval declined|Permission mode = denial|User declined|Search error|Diagnostics error|[SHELL] timeout)/;
function toolFailed(res) { return isToolResult(res) ? res.status !== 'ok' : TOOL_FAIL_RE.test(toolResultText(res)); }

// Central choke point for every model call: caps tool result size and
// compresses the conversation when it grows past CONTEXT_CHARS.
function capToolResult(result) {
  const s = toolResultText(result);
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  const head = Math.floor(MAX_TOOL_RESULT_CHARS * 0.7);
  const tail = MAX_TOOL_RESULT_CHARS - head;
  return s.substring(0, head) +
    `\n\n[... tool result truncated: ${s.length - MAX_TOOL_RESULT_CHARS} chars omitted from the middle ...]\n` +
    `[DO NOT rewrite this file from this truncated view - the omitted range is missing. Re-read with offset/limit first.]\n\n` +
    s.substring(s.length - tail);
}

// GAP-13: chars != tokens, and the gap is worst for CJK - one han character
// is roughly 1-2 tokens but counted as ONE character, so Chinese-heavy
// sessions blew past the real token budget before compression ever fired.
// Weighting CJK code points (and fullwidth/Hangul/Kana neighbors) x2 brings
// the char-based estimate much closer to the tokenizer's account without
// any dependency (a real tokenizer is GAP-13's deferred half).
function charUnits(c) {
  return ((c >= 0x2E80 && c <= 0x9FFF) ||   // CJK radicals..Yi (incl. han)
      (c >= 0xF900 && c <= 0xFAFF) ||    // CJK compat ideographs
      (c >= 0xFF00 && c <= 0xFF60) ||    // fullwidth forms
      (c >= 0x3040 && c <= 0x30FF) ||    // Kana
      (c >= 0xAC00 && c <= 0xD7FF)) ? 2 : 1; // Hangul syllables
}
function textUnits(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += charUnits(s.charCodeAt(i));
  return n;
}
// A2-13: slice a string to at most maxUnits weighted units (the exact
// accounting textUnits() uses) so recall can truncate an oversized note into
// the remaining budget instead of admitting it whole.
function textUnitsSlice(s, maxUnits) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n += charUnits(s.charCodeAt(i));
    if (n > maxUnits) {
      const splitPair = i > 0 && s.charCodeAt(i) >= 0xDC00 && s.charCodeAt(i) <= 0xDFFF && s.charCodeAt(i - 1) >= 0xD800 && s.charCodeAt(i - 1) <= 0xDBFF;
      return s.substring(0, splitPair ? i - 1 : i);
    }
  }
  return s;
}
function messageSize(m) {
  let n = 0;
  if (m.content) n += textUnits(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  if (m.tool_calls) n += textUnits(JSON.stringify(m.tool_calls));
  return n;
}

async function summarizeConversation(oldMessages, modelContext, cancelled) {
  const transcript = oldMessages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')}` +
      (m.tool_calls ? ` [called: ${JSON.stringify(m.tool_calls)}]` : ''))
    .join('\n');
  // Every removed character must reach the summarizer. Keep each request
  // small for local models, but never truncate the unsent tail of history.
  const parts = [];
  for (let start = 0; start < transcript.length;) {
    let end = Math.min(start + 20000, transcript.length);
    const last = transcript.charCodeAt(end - 1);
    if (end < transcript.length && last >= 0xD800 && last <= 0xDBFF) end--;
    parts.push(transcript.slice(start, end));
    start = end;
  }
  const summaries = [];
  for (let i = 0; i < parts.length; i++) {
    const choice = await callOpenAI([{
      role: 'user',
      content: `Summarize this coding conversation compactly. Keep: user goals, hard constraints, files touched, completed side effects (do not repeat them), key decisions, errors hit and their fixes, open threads. Max 15 bullet lines. Part ${i + 1}/${parts.length}.\n\n${parts[i]}`
    }], { model: modelContext ? modelContext.light : LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, useTools: false, maxTokens: 600 });
    const content = choice && choice.message && choice.message.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('empty context summary');
    summaries.push(content.trim());
  }
  if (!summaries.length) throw new Error('empty context transcript');
  return summaries.join('\n\n');
}

// When the conversation exceeds CONTEXT_CHARS, summarize the oldest turns and
// keep the newest ~60% of the budget verbatim. The split point is moved forward
// to the first position that keeps API pairing valid: a 'user' turn, or an
// 'assistant' turn (assistant may follow anything; a 'tool' message may NOT be
// the kept-start because its assistant(tool_calls) would land in the summarized
// part). This also enables compression inside sub-agent conversations, which
// contain no user turns after the initial task.
async function compressConversationIfNeeded(currentMessages, modelContext, cancelled) {
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

  // Keep the active user instruction verbatim, including when compressing a
  // single long sub-agent task. Only historical/tool turns are summarized.
  const activeUser = lastUserIdx >= 1 && lastUserIdx < splitIdx ? currentMessages[lastUserIdx] : null;
  const oldPart = currentMessages.slice(1, splitIdx).filter(m => m !== activeUser);
  if (!oldPart.length) return;
  // Zero-progress guard: when the kept tail alone exceeds the budget, the only
  // summarizable message can be a previous summary - re-summarizing it forever
  // wastes light-model calls without ever converging. Warn and stop instead.
  if (oldPart.length === 1 && String(oldPart[0].content || '').includes('[CONTEXT COMPRESSION]')) {
    console.warn('[CTX] Context still over budget after compression; a single large message dominates. Consider raising CONTEXT_CHARS.');
    return;
  }
  let digest;
  try { digest = await summarizeConversation(oldPart, modelContext, cancelled); }
  catch (error) { throw new Error('Context compression failed; original history preserved: ' + error.message); }
  const summaryMsg = {
    role: 'user',
    content: `[CONTEXT COMPRESSION] Earlier turns were summarized to fit the context window. Summary of everything before this point:\n${digest}`
  };
  const replacement = activeUser ? [summaryMsg, activeUser] : [summaryMsg];
  if (cancelled && cancelled()) throw executionCancelledError(cancelled);
  currentMessages.splice(1, splitIdx - 1, ...replacement);
  let newTotal = 0;
  for (const m of currentMessages) newTotal += messageSize(m);
  console.log(`[CTX] Context compressed: ${oldPart.length} messages summarized (${total} -> ${newTotal} chars).`);
}

async function processWithTools(currentMessages, opts = {}) {
  const onDelta = opts.onDelta || null;
  const onReasoning = opts.onReasoning || null;
  const onToolCall = opts.onToolCall || null;
  const onToolResult = opts.onToolResult || null;
  const modelContext = opts.modelContext || createModelContext(opts.model || HEAVY_MODEL);
  const reqModel = modelContext.main;
  // Cancellation token (A5): an HTTP client that disconnects mid-stream can
  // stop the run at the next step/tool boundary instead of running to
  // completion for a ghost client.
  const cancelled = opts.cancel || (() => false);
  // Per-request approval bridge (P0-3): threaded down to askApproval so
  // concurrent streaming clients each talk to their own SSE connection.
  const approvalBridge = opts.approvalBridge || null;
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (cancelled()) return '[aborted: client disconnected]';
    await compressConversationIfNeeded(currentMessages, modelContext, cancelled);
    if (cancelled()) return '[aborted: client disconnected]';
    const choice = await callOpenAI(currentMessages, { onDelta, onReasoning, model: reqModel, modelContext, cancel: cancelled });
    if (cancelled()) return '[aborted: client disconnected]';
    const assistantMsg = choice && choice.message;
    if (!assistantMsg || typeof assistantMsg !== 'object' || Array.isArray(assistantMsg)) throw new Error('Invalid assistant response: message must be an object');
    // Preflight the entire round before any callback or side effect. The step
    // limit counts model rounds, so it cannot itself bound a huge fan-out.
    if (assistantMsg.tool_calls != null) {
      const batch = assistantMsg.tool_calls;
      if (!Array.isArray(batch)) throw new Error('Tool batch rejected: tool_calls must be an array');
      if (batch.length > 64) throw new Error('Tool batch rejected: more than 64 calls in one round; split into smaller rounds');
      const ids = new Set();
      for (let i = 0; i < batch.length; i++) {
        const tc = batch[i], fn = tc && tc.function;
        if (!tc || typeof tc.id !== 'string' || !tc.id || ids.has(tc.id) ||
            (tc.type !== undefined && tc.type !== 'function') || !fn ||
            typeof fn.name !== 'string' || !fn.name.trim() ||
            (fn.arguments !== undefined && typeof fn.arguments !== 'string')) {
          throw new Error('Tool batch rejected: invalid or duplicate call ID/function at position ' + (i + 1));
        }
        ids.add(tc.id);
      }
    }
    currentMessages.push(assistantMsg);
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      // Notify UI about each tool call before execution
      if (onToolCall) {
        for (const tc of assistantMsg.tool_calls) {
          try {
            var preview = {};
            try { preview = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
            onToolCall(tc.function.name, preview, tc.id);
          } catch (e) {}
        }
      }
      // Parallel execution: read-only tools run concurrently via Promise.all;
      // write tools force sequential execution from that point onward.
      const calls = assistantMsg.tool_calls;
      if (calls.length > 1 && calls.every(tc => READ_ONLY_TOOLS.has(tc.function.name))) {
        if (cancelled()) return '[aborted: client disconnected]';
        const results = await Promise.all(calls.map(tc => safeExecuteTool(tc, currentMessages, approvalBridge, cancelled, modelContext).catch(e => 'Tool error: ' + e.message)));
        for (let i = 0; i < calls.length; i++) {
          if (onToolResult) {
            let preview = {};
            try { preview = JSON.parse(calls[i].function.arguments || '{}'); } catch (e) {}
            onToolResult(calls[i].function.name, preview, results[i], calls[i].id);
          }
          currentMessages.push({ role: 'tool', tool_call_id: calls[i].id, content: capToolResult(results[i]) });
        }
        continue;
      }
      for (const tc of calls) {
        if (cancelled()) return '[aborted: client disconnected]';
        const result = await safeExecuteTool(tc, currentMessages, approvalBridge, cancelled, modelContext);
        if (onToolResult) {
          let preview = {};
          try { preview = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
          onToolResult(tc.function.name, preview, result, tc.id);
        }
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: capToolResult(result) });
      }
      continue;
    }
    return assistantMsg.content || '';
  }
  // Step limit reached - force a final answer without any more tool calls.
  currentMessages.push({ role: 'user', content: `Tool step limit (${MAX_TOOL_STEPS}) reached. Wrap up now and give your final answer without calling more tools.` });
  if (cancelled()) return '[aborted: client disconnected]';
  const finalChoice = await callOpenAI(currentMessages, { useTools: false, onDelta, onReasoning, model: reqModel, modelContext, cancel: cancelled });
  if (cancelled()) return '[aborted: client disconnected]';
  currentMessages.push(finalChoice.message);
  return finalChoice.message.content || '';
}

// ====================== TASK CHANGE SUMMARY (GAP-12) ======================
// Per-task log of mutating tool calls, printed as [CHANGES] when the CLI task
// ends. Records are appended by safeExecuteTool (after the status is known) -
// argsPreview values are the already-redacted/truncated audit previews.
const taskChanges = [];
function resetTaskChanges() { taskChanges.length = 0; }
function printTaskChanges() {
  if (!taskChanges.length) return; // a task with no changes stays silent
  const ok = taskChanges.filter(c => c.status === 'ok').length;
  console.log('[CHANGES] this task: ' + ok + ' ok, ' + (taskChanges.length - ok) + ' blocked/failed');
  for (const c of taskChanges.slice(0, 20)) console.log('  ' + c.tool + ' ' + c.path + ' -> ' + c.status);
}
function ownedGitSnapshotPolicy(kind) {
  if (kind !== 'task' && kind !== 'commit') throw new Error('Unknown snapshot kind');
  const real = fs.realpathSync(launchDir);
  const canonical = process.platform === 'win32' ? path.normalize(real).toLowerCase() : real;
  const workspace = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
  return { prefix: 'refs/7coder/' + (kind === 'task' ? 'task-snapshots' : 'snapshots') + '/v1/' + workspace + '/',
    marker: '7coder owned ' + kind + ' snapshot v1' };
}
function readOwnedGitSnapshots(gitCommand, policy) {
  const text = gitCommand(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)%00%(contents:subject)', policy.prefix]);
  const owned = [];
  for (const line of String(text).split(/\r?\n/)) {
    const fields = line.split('\0'), ref = fields[0] || '';
    if (fields.length !== 5 || !ref.startsWith(policy.prefix) || fields[2] !== 'commit' || fields[3]) continue;
    const name = /^(\d{16})-([a-f0-9]{16})-([a-f0-9]{12})$/.exec(ref.slice(policy.prefix.length));
    if (!name || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[1]) || !fields[1].startsWith(name[3]) ||
        !fields[4].startsWith('On ') || !fields[4].endsWith(': ' + policy.marker)) continue;
    const stamp = Number(name[1]);
    if (Number.isSafeInteger(stamp)) owned.push({ ref, sha: fields[1], stamp });
  }
  return owned;
}
function recordOwnedGitSnapshot(gitCommand, kind) {
  const policy = ownedGitSnapshotPolicy(kind);
  const sha = gitCommand(['stash', 'create', policy.marker]).trim();
  if (!sha) return '';
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Git returned an invalid snapshot object ID');
  const previous = readOwnedGitSnapshots(gitCommand, policy);
  // Existing owned names keep creation order monotonic even across a restart,
  // coarse/frozen Win7 clock or rollback. Nonces also avoid accidental overwrite.
  let stamp = Math.max(0, Date.now());
  for (const record of previous) stamp = Math.max(stamp, record.stamp + 1);
  if (!Number.isSafeInteger(stamp)) throw new Error('Snapshot sequence exhausted');
  const ref = policy.prefix + String(stamp).padStart(16, '0') + '-' + crypto.randomBytes(8).toString('hex') + '-' + sha.slice(0, 12);
  gitCommand(['update-ref', '--no-deref', '-m', policy.marker, ref, sha, '0'.repeat(sha.length)], { stdio: 'pipe' });
  const records = previous.concat({ ref, sha, stamp }).sort((a, b) => a.stamp - b.stamp || a.ref.localeCompare(b.ref));
  let excess = records.length - 50;
  try {
    for (const record of records) {
      if (excess <= 0) break;
      if (record.ref === ref) continue;
      // Never follow a ref changed into a symbolic reference to a user branch.
      // Compare the old OID so an external rewrite fails instead of being erased.
      gitCommand(['update-ref', '--no-deref', '-d', record.ref, record.sha], { stdio: 'pipe' });
      excess--;
    }
  } catch (e) { console.warn('[WARN] snapshot retention stopped; current snapshot retained: ' + e.message); }
  return sha;
}

// GAP-12: create a lightweight, recoverable pre-task checkpoint without
// touching the working tree. This complements the git_commit_tool checkpoint
// Tracked working-tree and index changes are preserved; untracked files are
// excluded by `stash create`. Clean trees need no snapshot. No checkout/index
// changes are made and the refs are local to the repository.
function createTaskGitCheckpoint() {
  const gitTask = (args, opts) => child_process.execFileSync('git', args, Object.assign({ encoding: 'utf8', cwd: launchDir, timeout: 30000 }, opts || {}));
  try {
    if (gitTask(['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' }).trim() !== 'true') return '';
  } catch (e) { return ''; } // ordinary non-Git workspaces are silent
  try {
    const snapshot = recordOwnedGitSnapshot(gitTask, 'task');
    if (!snapshot) return '';
    console.log('[CHECKPOINT] git task snapshot ' + snapshot.substring(0, 12));
    return snapshot;
  } catch (e) {
    console.warn('[WARN] task git checkpoint failed: ' + e.message);
    return '';
  }
}
// GAP-8: end-of-session token usage trailer.
function logSessionUsage() {
  console.log('[USAGE] this process: prompt=' + sessionUsage.prompt + ' completion=' + sessionUsage.completion + ' total=' + (sessionUsage.prompt + sessionUsage.completion) + ' tokens');
}

// ====================== CORE EXECUTION ======================
let currentRawPrompt = '';

// ====================== LAYERED MEMORY (GAP-9) ======================
// Long-lived topic notes under .7coder/memory/<topic>.md, separate from the
// chronological 7CODER.md auto-log. At task start the notes whose keywords
// overlap the user prompt are recalled into the message (deterministic -
// no LLM call); everything else stays on disk until its turn.
const MEMORY_DIR = path.join(launchDir, '.7coder', 'memory');
const MEMORY_MAX_FILES = 20;
const MEMORY_RECALL_UNITS = parseInt(process.env.MEMORY_RECALL_CHARS, 10) || 3000;
function memoryTopicValid(t) { return /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(String(t || '')); }
function memoryFilePath(topic) { return internalStatePath('.7coder/memory', topic + '.md'); }
// A2-01: the memory store is INSIDE the workspace by construction - verify
// that against the real filesystem, not the lexical path. A junction planted
// at .7coder/memory (or a symlinked note file) must fail closed, never read
// or write outside. Returns null when the real path is safely inside, or an
// error string when it is not.
function memoryPathGuard(topic) {
  try {
    const realNote = realPathSafe(memoryFilePath(topic));
    const realStore = realPathSafe(internalStatePath('.7coder/memory'));
    // The STORE must itself sit inside the workspace: a junction planted at
    // .7coder/memory redirects both note and store outside together, which
    // would pass a naive note-inside-store check.
    if (!isInsideDir(getLaunchDirReal(), realStore)) {
      return 'Tool error: .7coder/memory resolves outside the workspace (junction/symlink?) - refused';
    }
    if (!isInsideDir(realStore, realNote)) {
      return 'Tool error: memory note path resolves outside .7coder/memory (junction/symlink?) - refused';
    }
    const rel = path.relative(launchDir, realNote).split(path.sep).join('/');
    const base = path.basename(rel);
    for (const r of permRules.protectedExtra) {
      if (r.argRe.test(rel) || r.argRe.test(base)) {
        return `Tool error: memory note "${topic}" matches a protected_extra pattern - refused`;
      }
    }
    return null; // safe
  } catch (e) {
    return 'Tool error: memory path cannot be resolved safely - refused';
  }
}
function memoryTopicIndex() {
  const topics = [], incomplete = [];
  let dir = null, failed = false;
  try {
    const safeDir = internalStatePath('.7coder/memory');
    if (typeof fs.opendirSync !== 'function') throw new Error('bounded memory index requires bundled Node13.14 fs.opendirSync');
    dir = fs.opendirSync(safeDir);
    let complete = false;
    for (let visited = 0; visited < 400; visited++) {
      const entry = dir.readSync();
      if (!entry) { complete = true; break; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const topic = entry.name.slice(0, -3);
      if (!memoryTopicValid(topic)) { incomplete.push('invalid topic filename skipped'); continue; }
      if (topics.length >= MEMORY_MAX_FILES) { incomplete.push('topic limit ' + MEMORY_MAX_FILES); complete = true; break; }
      topics.push(topic);
    }
    if (!complete) incomplete.push('400 directory-entry scan limit');
  } catch (e) {
    if (e.code !== 'ENOENT') { incomplete.push('index unavailable (' + (e.code || e.message) + ')'); failed = true; }
  } finally {
    if (dir) { try { dir.closeSync(); } catch (e) { incomplete.push('index close failed (' + (e.code || e.message) + ')'); failed = true; } }
  }
  return { topics: topics.sort(), incomplete: Array.from(new Set(incomplete)), failed };
}
function listMemoryTopics() {
  const index = memoryTopicIndex();
  if (index.failed) throw new Error('Memory index unavailable: ' + index.incomplete.join('; '));
  if (index.incomplete.length) console.warn('[MEMORY] index incomplete: ' + index.incomplete.join('; '));
  return index.topics;
}
function readMemoryFile(topic, maxBytes = stateFileByteLimit()) {
  const record = readStateRecord(memoryFilePath(topic), parseStateText, false, maxBytes);
  return record ? record.value : null;
}
function saveMemoryFile(topic, content) {
  writeStateFile(memoryFilePath(topic), String(content || ''));
}
// keyword-overlap score between the prompt and a note (deterministic recall)
function memoryKeywords(promptText) {
  const raw = String(promptText), words = [], seen = new Set();
  let limited = raw.length > 8192;
  for (const w of raw.slice(0, 8192).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (w.length < 2 || seen.has(w)) continue;
    if (words.length >= 128) { limited = true; break; }
    seen.add(w); words.push(w);
  }
  return { words, limited };
}
function memoryScore(promptText, topic, body, words = memoryKeywords(promptText).words) {
  if (!words.length) return 0;
  const hay = (topic + '\n' + body).toLowerCase();
  let score = 0;
  for (const w of words) {
    if (hay.indexOf(w) >= 0) score += (w.length >= 4 ? 2 : 1);
  }
  return score;
}
function recallMemory(promptText) {
  const index = memoryTopicIndex(), topics = index.topics, issues = new Set(index.incomplete);
  const keywords = memoryKeywords(promptText), scored = [], deadlineAt = Date.now() + 5000;
  const limit = Number.isFinite(MEMORY_RECALL_UNITS) ? Math.max(0, Math.min(16384, MEMORY_RECALL_UNITS)) : 3000;
  if (topics.length && keywords.limited) issues.add('prompt scoring limited to 8192 characters / 128 unique keywords');
  if (limit !== MEMORY_RECALL_UNITS) issues.add('recall output budget clamped');
  let order = 0;
  for (const t of topics) {
    if (!limit || !keywords.words.length) break;
    if (Date.now() >= deadlineAt) { issues.add('5s recall scan budget'); break; }
    try {
      const guard = memoryPathGuard(t); if (guard) throw new Error(guard);
      const body = readMemoryFile(t, 64 * 1024);
      if (body === null) continue;
      if (Date.now() >= deadlineAt) { issues.add('5s recall scan budget'); break; }
      const s = memoryScore(promptText, t, body, keywords.words);
      if (s > 0) {
        scored.push({ topic: t, body, score: s, order: order++ });
        scored.sort((a, b) => b.score - a.score || a.order - b.order);
        if (scored.length > 5) scored.pop();
      }
    } catch (e) { issues.add('note unavailable for automatic recall: ' + t); }
  }
  let used = 0;
  const picked = [];
  for (const s of scored) {
    const u = textUnits(s.body);
    // A2-13: a note bigger than the whole budget used to be admitted whole
    // (the old picked.length gate only stopped the SECOND note from
    // overflowing), so one 16k note blew a 100-unit budget. Truncate such a
    // note into what is left of the budget, mark it, and stop - the note on
    // disk stays whole.
    if (u > limit) {
      const room = limit - used;
      if (room <= 0) break;
      s.body = textUnitsSlice(s.body, room) + '\n... [note truncated at recall budget]';
      picked.push(s);
      break; // the budget is now fully spent
    }
    if (used + u > limit) break;
    picked.push(s);
    used += u;
    if (picked.length >= 5) break;
  }
  let note = '';
  if (picked.length) {
    note = '\n\nRelevant long-term memory notes (from .7coder/memory/):\n' +
      picked.map(p => '## ' + p.topic + '\n' + p.body.trim()).join('\n\n');
    console.log('[MEMORY] recalled ' + picked.length + ' note(s): ' + picked.map(p => p.topic).join(', '));
  }
  if (issues.size) {
    const warning = '[memory recall incomplete: ' + Array.from(issues).join('; ') + '; use memory_tool read for specific notes]';
    console.warn('[MEMORY] ' + warning); note += '\n\n' + warning;
  }
  return { note, topics, incomplete: issues.size > 0 };
}

function buildTaskUserContent(rawPrompt) {
  const mdPath = managedWorkspacePath('7CODER.md');
  let content = rawPrompt;
  {
    try {
      const record = readStateRecord(mdPath);
      const completeSummary = record ? record.value.trim() : '';
      if (completeSummary) {
        content += `\n\nthis is what's already been done.\n${completeSummary}`;
      }
    } catch (e) {
      console.error('Error reading 7CODER.md:', e);
    }
  }
  // GAP-9: keyword-recalled topic notes + the full topic index so the model
  // knows what else exists (memory_tool list/read for the rest).
  const mem = recallMemory(rawPrompt);
  if (mem.note) content += mem.note;
  if (mem.topics.length) {
    content += `\n\nMemory topics on disk: ${mem.topics.join(', ')} (memory_tool with action=list shows contents; save new durable facts with action=save).`;
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

// T22-10: text tools must not turn Win7 legacy bytes into replacement chars.
// Round-trip validation is deterministic; it does not guess GBK/UTF-16.
function decodeUtf8Text(bytes) {
  const text = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('Unsupported text encoding or binary data: only lossless UTF-8 is supported. Convert a copy explicitly; original bytes were not changed.');
  }
  return text;
}

// Bounded line view. Validate every scanned UTF-8 prefix, retaining at most
// three incomplete codepoint bytes across chunks. Unscanned tails are unknown.
async function readUtf8Window(fullPath, args, cancelled, maxResultChars) {
  const start = Math.max(1, parseInt(args.offset, 10) || 1);
  const count = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : Infinity;
  const last = start + count - 1;
  const charBudget = Math.max(256, Math.min(maxResultChars, 128 * 1024) - 256);
  const scanBudget = 16 * 1024 * 1024, deadline = Date.now() + 5000;
  const invoke = (method, ...values) => new Promise((resolve, reject) => fs[method](...values, (error, value) => error ? reject(error) : resolve(value)));
  let fd = null, position = 0, line = 1, lineStart = true, selected = false, out = '', pending = Buffer.alloc(0);
  const buffer = Buffer.alloc(64 * 1024);
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  function append(text) {
    if (line < start || line > last) return false;
    selected = true;
    const value = (lineStart ? (out ? '\n' : '') + String(line).padStart(6) + '\t' : '') + text;
    lineStart = false;
    let take = Math.min(value.length, charBudget - out.length);
    if (take > 0 && take < value.length && /[\uD800-\uDBFF]/.test(value.charAt(take - 1)) && /[\uDC00-\uDFFF]/.test(value.charAt(take))) take--;
    out += value.slice(0, take);
    return take < value.length;
  }
  function consume(text) {
    let offset = 0;
    while (offset < text.length) {
      const end = text.indexOf('\n', offset);
      if (append(text.slice(offset, end < 0 ? text.length : end))) return 'output budget exhausted';
      if (end < 0) return null;
      line++; lineStart = true; offset = end + 1;
      if (line > last) return 'window complete';
    }
    return null;
  }
  function partial(reason) {
    return out + '\n[read incomplete: ' + reason + '; scanned through line ' + line +
      '. Request a smaller window or use bounded byte reads. DO NOT rewrite from this partial view.]';
  }
  try {
    checkExecution(cancelled);
    const before = await invoke('stat', fullPath);
    if (!before.isFile()) throw new Error('read_file requires a regular file');
    checkExecution(cancelled);
    fd = await invoke('open', fullPath, 'r');
    const original = await invoke('fstat', fd);
    if (!original.isFile()) throw new Error('read_file requires a regular file');
    async function finish(text) {
      checkExecution(cancelled);
      const after = await invoke('fstat', fd), named = await invoke('stat', fullPath);
      if (!same(original, after) || !same(original, named)) throw new Error('file changed during read; retry before using this view');
      return text;
    }
    if (!original.size) return await finish('(empty file)');
    while (true) {
      checkExecution(cancelled);
      if (Date.now() >= deadline) return await finish(partial('5s read budget exhausted'));
      if (position >= scanBudget) return await finish(partial('16MiB scan budget exhausted before EOF'));
      const bytes = await invoke('read', fd, buffer, 0, Math.min(buffer.length, scanBudget - position), position);
      checkExecution(cancelled);
      if (!position && buffer.slice(0, Math.min(bytes, 4096)).includes(0)) {
        return await finish('[BINARY] ' + args.path + ' looks binary - refused to read as text. Use download_tool or a shell command instead.');
      }
      position += bytes;
      const input = pending.length ? Buffer.concat([pending, buffer.slice(0, bytes)]) : buffer.slice(0, bytes);
      let complete = input.length;
      // Hold only an otherwise valid leading byte with too few trailing bytes.
      let lead = input.length - 1;
      while (lead >= 0 && input.length - lead <= 3 && (input[lead] & 0xC0) === 0x80) lead--;
      const first = input[lead], need = first >= 0xC2 && first <= 0xDF ? 2 : first >= 0xE0 && first <= 0xEF ? 3 : first >= 0xF0 && first <= 0xF4 ? 4 : 1;
      if (lead >= 0 && need > input.length - lead) complete = lead;
      pending = Buffer.from(input.slice(complete));
      const state = consume(decodeUtf8Text(input.slice(0, complete)));
      if (state === 'window complete' || !count) return await finish(out);
      if (state) return await finish(partial(state));
      if (!bytes || position >= original.size) {
        if (pending.length) consume(decodeUtf8Text(pending)); // refuse truncated UTF-8 at EOF
        if (line > last) return await finish(out);
        if (line >= start && lineStart) {
          if (append('')) return await finish(partial('output budget exhausted'));
        }
        return await finish(selected ? out : '(offset ' + args.offset + ' is beyond EOF - the file has ' + line + ' line(s))');
      }
    }
  } finally {
    if (fd !== null) await invoke('close', fd);
  }
}

function readUtf8ForWrite(fullPath, allowMissing) {
  let text;
  try { text = decodeUtf8Text(readFileBytesBounded(fullPath, textFileByteLimit(), 'Editable file')); }
  catch (e) {
    if (allowMissing && e.code === 'ENOENT') return { text: '', bom: false, newline: null };
    throw e;
  }
  let newline = null;
  if (text.includes('\r\n') && !/(^|[^\r])\n|\r(?!\n)/.test(text)) newline = '\r\n';
  else if (text.includes('\n') && !text.includes('\r')) newline = '\n';
  else if (text.includes('\r') && !text.includes('\n')) newline = '\r';
  // Mixed/no line endings: keep caller input literal, preserving untouched bytes.
  return { text, bom: text.charCodeAt(0) === 0xFEFF, newline };
}

function textFileByteLimit() { return 8 * 1024 * 1024; }
function assertTextByteLimit(text) {
  if (Buffer.byteLength(text, 'utf8') > textFileByteLimit()) throw fileByteLimitError('Text content', textFileByteLimit());
  return text;
}
function normalizeUtf8Input(text, newline) {
  if (typeof text !== 'string' || text.includes('\0')) {
    throw new Error('Text content must be a UTF-8 encodable string without NUL or unpaired surrogates.');
  }
  assertTextByteLimit(text);
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) throw new Error('Text content must be a UTF-8 encodable string without NUL or unpaired surrogates.');
  return assertTextByteLimit(newline ? text.replace(/\r\n|\r|\n/g, newline) : text);
}

function preserveTextBom(original, text) {
  return assertTextByteLimit(original.bom && text.charCodeAt(0) !== 0xFEFF ? '\uFEFF' + text : text);
}

function replaceTextBounded(content, oldStr, newStr, replaceAll) {
  if (!oldStr) throw new Error('old_string is required');
  let count = 0, from = 0, at;
  while ((at = content.indexOf(oldStr, from)) !== -1) { count++; from = at + oldStr.length; }
  if (!count) throw new Error('old_string not found in file');
  if (count > 1 && !replaceAll) throw new Error('old_string found ' + count + ' times - add more surrounding context to make it unique, or set replace_all=true');
  const size = Buffer.byteLength(content, 'utf8') + count * (Buffer.byteLength(newStr, 'utf8') - Buffer.byteLength(oldStr, 'utf8'));
  if (!Number.isSafeInteger(size) || size < 0 || size > textFileByteLimit()) throw fileByteLimitError('Edited text', textFileByteLimit());
  // Avoid one array entry/rope per match: even a bounded result may have millions
  // of matches. Copy UTF-8 into one bounded buffer; $ sequences stay literal.
  const output = Buffer.alloc(size);
  let written = 0; from = 0;
  while ((at = content.indexOf(oldStr, from)) !== -1) {
    if (at > from) written += output.write(content.slice(from, at), written, 'utf8');
    if (newStr) written += output.write(newStr, written, 'utf8');
    from = at + oldStr.length;
  }
  if (from < content.length) written += output.write(content.slice(from), written, 'utf8');
  return { count, text: output.toString('utf8') };
}

function stringifyNotebookBounded(notebook) {
  return stringifyJsonBounded(notebook, 'Formatted notebook');
}
function stringifyJsonBounded(notebook, label = 'Formatted JSON') {
  // Parsed JSON and model JSON args have no getters/toJSON side effects. Check
  // compact bytes and indentation growth before materializing pretty output.
  const compact = JSON.stringify(notebook);
  assertTextByteLimit(compact);
  const base = Buffer.byteLength(compact, 'utf8');
  let depth = 0, extra = 0, quoted = false;
  for (let i = 0; i < compact.length; i++) {
    const ch = compact[i];
    if (quoted) { if (ch === '\\') i++; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '{' || ch === '[') {
      if (compact[i + 1] !== (ch === '{' ? '}' : ']')) { depth++; extra += 1 + depth * 2; }
    } else if (ch === '}' || ch === ']') {
      if (compact[i - 1] !== (ch === '}' ? '{' : '[')) { depth--; extra += 1 + depth * 2; }
    } else if (ch === ',') extra += 1 + depth * 2;
    else if (ch === ':') extra++;
    if (base + extra > textFileByteLimit()) throw fileByteLimitError(label, textFileByteLimit());
  }
  return JSON.stringify(notebook, null, 2);
}

// Shared strict snapshot: an unflushed or partial backup must never authorize
// a write or appear in /undo's .bak list.
function flushDownloadFile(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// ---- Owned backup store v1 (T22-26 retention + atomic recovery) ----
// Layout under .7coder/backups:
//   .../<sourceRel>.<stamp>.bak   legacy flat snapshots - read-only discovery
//   v1/store.json                 identity + reliable lastSequence counter
//   v1/<16-digit sequence>-<32hex snapshotId>/{data.bak,manifest.json}
//   v1/.stage-<32hex>/            this transaction's uncommitted staging
//   v1/.deleting-<name>-<hex>/    mid-deletion evidence; never undo candidates
// Only records whose manifest, payload and storeId are all verified count as
// "owned": they alone are eligible for retention cleanup and default /undo.
// Legacy, loose, foreign, corrupt, staging and deleting entries are preserved.
const BACKUP_STORE_VERSION = 1;
const BACKUP_STORE_KIND = '7coder-backup-store-v1';
const BACKUP_MANIFEST_KIND = '7coder-backup-manifest-v1';
const BACKUP_SINGLE_MAX_BYTES = 1024 * 1024 * 1024;     // one snapshot payload
const BACKUP_RETAIN_TARGET_BYTES = 1024 * 1024 * 1024;  // best-effort owned total
const BACKUP_HARD_ADMIT_BYTES = 2 * 1024 * 1024 * 1024; // owned total + this snapshot
const BACKUP_PER_SOURCE_KEEP = 5;
const BACKUP_GLOBAL_KEEP = 200;
const BACKUP_MANIFEST_MAX_BYTES = 4 * 1024;
const BACKUP_STORE_MAX_BYTES = 4 * 1024;
const BACKUP_DISCOVERY_MAX_ENTRIES = 4096;
const BACKUP_DISCOVERY_MAX_CANDIDATES = 1024;
const BACKUP_DISCOVERY_MAX_META_BYTES = 4 * 1024 * 1024;
const BACKUP_DISCOVERY_DEADLINE_MS = 5000;
const BACKUP_CHUNK_BYTES = 64 * 1024;
const BACKUP_IO_BUDGET_MS = 300000; // per-operation wall clock for copy/hash/restore phases
const BACKUP_MAX_SEQUENCE = 9999999999999999; // fits the 16-digit directory name
const backupRecordDirRe = /^(\d{16})-([0-9a-f]{32})$/;
const backupLegacyNameRe = /^(.+)\.\d{4}-\d{2}-\d{2}T[\d\-]+Z\.bak$/;
const backupHex32Re = /^[0-9a-f]{32}$/;
const backupHex64Re = /^[0-9a-f]{64}$/;
// var (not const): the declaration must stay reachable on the sandbox global
// so test contexts can inspect/seed the active-pin set.
var activeBackupRestorePins = new Set();

function backupV1StatePath(child) {
  return internalStatePath(path.join('.7coder', 'backups', 'v1'), child);
}
// Windows sources are matched case-insensitively but the original display case
// is kept in sourceRel; paths are stored with forward slashes.
function normalizeBackupSourceKey(sourceRel) {
  const normalized = String(sourceRel).split(path.sep).join('/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function backupRetentionLimits(limits) {
  const l = limits || {};
  const positive = (v, d) => Number.isSafeInteger(v) && v > 0 ? v : d;
  return {
    singleMax: positive(l.singleMax, BACKUP_SINGLE_MAX_BYTES),
    hardAdmit: positive(l.hardAdmit, BACKUP_HARD_ADMIT_BYTES),
    retainTarget: positive(l.retainTarget, BACKUP_RETAIN_TARGET_BYTES),
    perSource: positive(l.perSource, BACKUP_PER_SOURCE_KEEP),
    globalKeep: positive(l.globalKeep, BACKUP_GLOBAL_KEEP)
  };
}
function parseBackupStoreState(text) {
  const j = parseStateJson(text);
  if (!j || typeof j !== 'object' || Array.isArray(j) ||
      j.kind !== BACKUP_STORE_KIND || j.version !== BACKUP_STORE_VERSION ||
      typeof j.storeId !== 'string' || !backupHex32Re.test(j.storeId) ||
      !Number.isSafeInteger(j.lastSequence) || j.lastSequence < 0 || j.lastSequence > BACKUP_MAX_SEQUENCE) {
    throw new Error('invalid backup store');
  }
  return j;
}
function validateBackupManifest(j, dirName, dirSequence, dirSnapshotId) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
  if (j.kind !== BACKUP_MANIFEST_KIND) throw new Error('unknown kind');
  if (j.version !== BACKUP_STORE_VERSION) throw new Error('unknown version ' + String(j.version));
  if (typeof j.storeId !== 'string' || !backupHex32Re.test(j.storeId)) throw new Error('invalid storeId');
  if (typeof j.snapshotId !== 'string' || j.snapshotId !== dirSnapshotId) throw new Error('snapshotId does not match directory');
  if (!Number.isSafeInteger(j.sequence) || j.sequence < 1 || j.sequence > BACKUP_MAX_SEQUENCE || j.sequence !== dirSequence) throw new Error('sequence does not match directory');
  if (typeof j.createdAt !== 'string' || !j.createdAt) throw new Error('invalid createdAt');
  if (typeof j.sourceRel !== 'string' || !j.sourceRel || j.sourceRel.indexOf('\0') >= 0) throw new Error('invalid sourceRel');
  if (typeof j.sourceKey !== 'string' || j.sourceKey !== normalizeBackupSourceKey(j.sourceRel)) throw new Error('sourceKey does not match sourceRel');
  if (!Number.isSafeInteger(j.bytes) || j.bytes < 0 || j.bytes > BACKUP_SINGLE_MAX_BYTES) throw new Error('invalid byte count');
  if (typeof j.sha256 !== 'string' || !backupHex64Re.test(j.sha256)) throw new Error('invalid digest');
  return j;
}
// Store identity: a random storeId created once with the first v1 backup and
// moved with the workspace. If store.json is unreadable while v1 records
// exist, refuse to invent a new identity that would silently claim them.
function loadBackupStore() {
  const storePath = backupV1StatePath('store.json');
  const current = readStateRecord(storePath, parseBackupStoreState, false, BACKUP_STORE_MAX_BYTES);
  if (current) return current.value;
  const v1Dir = path.dirname(storePath);
  let handle = null, occupied = false;
  try {
    handle = fs.opendirSync(v1Dir);
    // Only published record directories claim the identity: leftover staging
    // or deleting residue alone must not permanently block store creation.
    // The emptiness scan is budgeted too - an unprovable directory (entry or
    // time budget hit) fails closed instead of scanning unbounded (recheck R5).
    let entry, visited = 0;
    const scanDeadline = Date.now() + BACKUP_DISCOVERY_DEADLINE_MS;
    while ((entry = handle.readSync()) !== null) {
      if (backupRecordDirRe.test(entry.name)) { occupied = true; break; }
      if (++visited >= BACKUP_DISCOVERY_MAX_ENTRIES || Date.now() >= scanDeadline) { occupied = true; break; }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  } finally { if (handle) { try { handle.closeSync(); } catch (e2) {} } }
  if (occupied) {
    const err = new Error('backup store identity is missing and v1 is not provably empty within budget; refusing to claim its contents - inspect or remove ' + v1Dir + ' manually');
    err.code = 'EBACKUPIDENTITY';
    throw err;
  }
  const created = { kind: BACKUP_STORE_KIND, version: BACKUP_STORE_VERSION, storeId: crypto.randomBytes(16).toString('hex'), lastSequence: 0 };
  fs.mkdirSync(v1Dir, { recursive: true });
  writeStateFile(storePath, JSON.stringify(created), parseBackupStoreState);
  return created;
}
// Bounded flat scan of v1: every opened handle is closed in finally, visited
// entries / candidates / manifest bytes / wall clock are all budgeted, and any
// exceeded budget is reported as an incomplete index instead of a shorter one.
function discoverBackupV1(storeId) {
  const out = { incomplete: [], records: [], corrupt: [], foreign: [], staging: [], deleting: [], unknown: [], visited: 0, metaBytes: 0, ownBytes: 0 };
  const v1Dir = internalStatePath(path.join('.7coder', 'backups', 'v1'));
  let handle = null;
  try { handle = fs.opendirSync(v1Dir); }
  catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  const deadline = Date.now() + BACKUP_DISCOVERY_DEADLINE_MS;
  try {
    while (true) {
      const entry = handle.readSync();
      if (!entry) break;
      out.visited++;
      if (out.visited > BACKUP_DISCOVERY_MAX_ENTRIES) { out.incomplete.push('entry limit ' + BACKUP_DISCOVERY_MAX_ENTRIES); break; }
      if (Date.now() >= deadline) { out.incomplete.push('discovery deadline exceeded'); break; }
      const name = entry.name;
      if (name.indexOf('.stage-') === 0) { out.staging.push(name); continue; }
      if (name.indexOf('.deleting-') === 0) { out.deleting.push(name); continue; }
      const m = name.match(backupRecordDirRe);
      if (!m) { out.unknown.push(name); continue; }
      if (out.records.length + out.corrupt.length + out.foreign.length >= BACKUP_DISCOVERY_MAX_CANDIDATES) { out.incomplete.push('candidate limit ' + BACKUP_DISCOVERY_MAX_CANDIDATES); break; }
      if (out.metaBytes + BACKUP_MANIFEST_MAX_BYTES > BACKUP_DISCOVERY_MAX_META_BYTES) { out.incomplete.push('metadata byte limit ' + BACKUP_DISCOVERY_MAX_META_BYTES); break; }
      const seq = parseInt(m[1], 10);
      let lstat;
      try { lstat = fs.lstatSync(path.join(v1Dir, name)); }
      catch (e) { out.corrupt.push({ name, seq, sourceKey: null, reason: 'unreadable record directory (' + e.code + ')' }); continue; }
      if (lstat.isSymbolicLink()) { out.corrupt.push({ name, seq, sourceKey: null, reason: 'record directory is a link' }); continue; }
      if (!lstat.isDirectory()) { out.unknown.push(name); continue; }
      let manifest;
      try {
        const bytes = readFileBytesBounded(path.join(v1Dir, name, 'manifest.json'), BACKUP_MANIFEST_MAX_BYTES, 'Backup manifest');
        out.metaBytes += bytes.length;
        manifest = validateBackupManifest(JSON.parse(decodeUtf8Text(bytes)), name, seq, m[2]);
      }
      catch (e) { out.corrupt.push({ name, seq, sourceKey: null, reason: 'manifest unreadable or invalid: ' + e.message }); continue; }
      if (manifest.storeId !== storeId) { out.foreign.push(name); continue; }
      const payloadPath = path.join(v1Dir, name, 'data.bak');
      let st;
      try { st = fs.lstatSync(payloadPath); }
      catch (e) { out.corrupt.push({ name, seq, sourceKey: manifest.sourceKey, reason: 'payload unreadable (' + e.code + ')' }); continue; }
      if (st.isSymbolicLink() || !st.isFile()) { out.corrupt.push({ name, seq, sourceKey: manifest.sourceKey, reason: 'payload is not a regular file' }); continue; }
      if (st.nlink > 1) { out.corrupt.push({ name, seq, sourceKey: manifest.sourceKey, reason: 'payload is shared by a hard link' }); continue; }
      if (st.size !== manifest.bytes) { out.corrupt.push({ name, seq, sourceKey: manifest.sourceKey, reason: 'payload size mismatch (' + st.size + ' != ' + manifest.bytes + ')' }); continue; }
      out.records.push({
        dir: path.join(v1Dir, name), name, seq, bytes: st.size, manifest,
        payloadStat: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }
      });
      out.ownBytes += st.size;
    }
  } finally { try { handle.closeSync(); } catch (e) {} }
  return out;
}
// Legacy candidates live in the source's own backup subdirectory, so undo only
// scans that one directory; v1/ is never confused with legacy files. Loose
// .bak names (no timestamp) are counted but are never restore candidates.
function discoverLegacyBackupCandidates(safeRel) {
  const out = { candidates: [], loose: 0, hardlinked: 0, incomplete: '' };
  let dirPath;
  try {
    const parentRel = path.dirname(safeRel);
    dirPath = internalStatePath(path.join('.7coder', 'backups'), parentRel === '.' ? undefined : parentRel);
  } catch (e) { out.incomplete = 'backup root guard: ' + e.message; return out; }
  let scan;
  try { scan = readDirectoryEntriesBounded(dirPath, { maxEntries: BACKUP_DISCOVERY_MAX_ENTRIES, maxBytes: BACKUP_DISCOVERY_MAX_META_BYTES, deadlineAt: Date.now() + BACKUP_DISCOVERY_DEADLINE_MS }); }
  catch (e) {
    if (e.code === 'ENOENT') return out;
    out.incomplete = 'legacy directory unreadable (' + e.code + ')';
    return out;
  }
  out.incomplete = scan.incomplete || '';
  const prefix = path.basename(safeRel);
  for (const entry of scan.entries) {
    const m = entry.name.match(backupLegacyNameRe);
    if (!m) { if (entry.name.endsWith('.bak')) out.loose++; continue; }
    // Greedy prefix + exact match keeps "b.txt" from claiming "b.txt.old".
    if (m[1] !== prefix) continue;
    const full = path.join(dirPath, entry.name);
    let st;
    try { st = fs.lstatSync(full); }
    catch (e) { out.incomplete = out.incomplete || 'unreadable legacy entry (' + e.code + ')'; continue; }
    // Links/directories are never candidates; hard-linked payloads are
    // excluded under the same rule as the v1 store, but counted for the
    // not-found report (recheck R7 - the two layouts share one policy).
    if (!st.isFile()) continue;
    if (st.nlink > 1) { out.hardlinked++; continue; }
    out.candidates.push({ full, name: entry.name, size: st.size, mtimeMs: st.mtimeMs,
      stat: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs } });
  }
  return out;
}
// Streaming sha256 with the same read-time identity discipline as
// readFileBytesBounded; payloads are never held in memory as a whole.
function digestBackupFile(file, expectedBytes, label, context) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error(label + ' must be a regular file');
    if (before.size !== expectedBytes) throw new Error(label + ' size mismatch (' + before.size + ' != ' + expectedBytes + ')');
    const hash = crypto.createHash('sha256');
    let total = 0;
    while (total < expectedBytes) {
      // Chunk-level progress checks: cancellation and the per-operation wall
      // clock apply INSIDE long digests, not only between victims (recheck R5).
      checkExecution(context && context.cancelled);
      if (context && context.deadlineAt && Date.now() >= context.deadlineAt) throw new Error(label + ' digest budget exceeded');
      const want = Math.min(BACKUP_CHUNK_BYTES, expectedBytes - total);
      const chunk = Buffer.alloc(want);
      const count = fs.readSync(fd, chunk, 0, want, total);
      if (!count) throw new Error(label + ' ended early at ' + total + ' of ' + expectedBytes + ' bytes');
      hash.update(count === want ? chunk : chunk.slice(0, count));
      total += count;
    }
    const after = fs.fstatSync(fd), named = fs.statSync(file);
    const same = st => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => st[k] === before[k]);
    if (!same(after) || !same(named)) throw new Error(label + ' changed during read; retry before using it');
    return { sha256: hash.digest('hex'), bytes: total };
  } finally { fs.closeSync(fd); }
}
// Chunked copy through two held descriptors (never name-then-reopen), hashing
// while writing and rejecting zero-progress loops, short reads and any change
// to the source identity between the initial stat, the copy and its end.
function copyBackupPayload(sourcePath, sourceStat, payloadPath, cancelled, deadlineAt) {
  const srcFd = fs.openSync(sourcePath, 'r');
  let payloadFd = null, payloadClosed = false;
  try {
    const before = fs.fstatSync(srcFd);
    if (!before.isFile()) throw new Error('source must be a regular file');
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(k => before[k] !== sourceStat[k])) throw new Error('source changed before the copy started');
    payloadFd = fs.openSync(payloadPath, 'wx');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(BACKUP_CHUNK_BYTES);
    let total = 0, idleWrites = 0;
    while (total < before.size) {
      checkExecution(cancelled);
      if (deadlineAt && Date.now() >= deadlineAt) throw new Error('backup copy budget exceeded');
      const want = Math.min(BACKUP_CHUNK_BYTES, before.size - total);
      const got = fs.readSync(srcFd, buffer, 0, want, total);
      if (!got) throw new Error('source ended early at ' + total + ' of ' + before.size + ' bytes');
      let off = 0;
      while (off < got) {
        const wrote = fs.writeSync(payloadFd, buffer, off, got - off);
        if (!(wrote > 0)) { if (++idleWrites > 16) throw new Error('backup payload write made no progress'); continue; }
        idleWrites = 0;
        // Slice to the bytes actually written: the last chunk is shorter than
        // the 64KiB buffer, and hashing the allocation would corrupt the digest.
        hash.update(buffer.slice(off, off + wrote));
        off += wrote; total += wrote;
      }
    }
    fs.fsyncSync(payloadFd);
    fs.closeSync(payloadFd);
    payloadClosed = true;
    const after = fs.fstatSync(srcFd), named = fs.statSync(sourcePath);
    const same = st => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => st[k] === before[k]);
    if (!same(after) || !same(named)) throw new Error('source changed during the copy');
    return { sha256: hash.digest('hex'), bytes: total };
  } finally {
    if (payloadFd !== null && !payloadClosed) { try { fs.closeSync(payloadFd); } catch (e) {} }
    try { fs.closeSync(srcFd); } catch (e) {}
  }
}
function createOwnedBackupStageDir(v1Dir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = path.join(v1Dir, '.stage-' + crypto.randomBytes(16).toString('hex'));
    try { fs.mkdirSync(candidate); return candidate; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('cannot create an exclusive staging directory');
}
// Only this transaction's exclusively created staging directory is reclaimed,
// and only its two known members are unlinked - never a wide rm -rf.
function recycleOwnedBackupStaging(dir) {
  const residue = [];
  for (const name of ['data.bak', 'manifest.json']) {
    try { fs.unlinkSync(path.join(dir, name)); }
    catch (e) { if (e.code !== 'ENOENT') residue.push(name + ': ' + e.code); }
  }
  try { fs.rmdirSync(dir); }
  catch (e) { residue.push('directory: ' + e.code); }
  if (residue.length) console.warn('[BACKUP] staging residue retained at ' + dir + ' (' + residue.join(', ') + ') - safe to remove manually once no 7coder runs');
}
// Backup transaction: discovered -> sequence-reserved -> staging-owned ->
// payload-complete -> manifest-complete -> published -> cleanup-attempted.
// Any failure before the publish rename leaves the original file untouched;
// the caller must treat a throw as "do not modify the target".
function backupExistingFile(fullPath, cancelled, limits) {
  const rel = path.relative(launchDir, fullPath);
  const cap = backupRetentionLimits(limits);
  try {
    checkExecution(cancelled);
    let sourceStat;
    try { sourceStat = fs.statSync(fullPath); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!sourceStat.isFile()) throw new Error('destination is not a regular file');
    if (isInsideDir(realPathSafe(backupsDir), realPathSafe(fullPath))) throw new Error('the backup store never backs itself up');
    if (sourceStat.size > cap.singleMax) throw new Error('previous file exceeds the ' + cap.singleMax + '-byte single-snapshot budget; shrink or move it before overwriting');
    checkExecution(cancelled);
    const store = loadBackupStore();
    const index = discoverBackupV1(store.storeId);
    if (index.incomplete.length) throw new Error('backup index incomplete (' + index.incomplete.join('; ') + '); not allocating a new snapshot');
    const seenSequence = Object.create(null);
    let publishedMax = store.lastSequence;
    for (const r of index.records) {
      if (seenSequence[r.seq]) throw new Error('duplicate sequence ' + r.seq + ' among published records');
      seenSequence[r.seq] = true;
      if (r.seq > publishedMax) publishedMax = r.seq;
    }
    // Damaged records still occupy their directory sequence: "metadata
    // unreadable" must not become "never published" after a counter rollback
    // (recheck R4), or allocation would reuse a published sequence.
    for (const c of index.corrupt) {
      if (c.seq === null) continue;
      if (seenSequence[c.seq]) throw new Error('duplicate sequence ' + c.seq + ' among published records');
      seenSequence[c.seq] = true;
      if (c.seq > publishedMax) publishedMax = c.seq;
    }
    const sequence = publishedMax + 1;
    if (sequence > BACKUP_MAX_SEQUENCE) throw new Error('backup sequence space exhausted');
    if (index.ownBytes + sourceStat.size > cap.hardAdmit) throw new Error('owned published backups (' + index.ownBytes + ' bytes) plus this snapshot (' + sourceStat.size + ' bytes) exceed the ' + cap.hardAdmit + '-byte hard budget; clean .7coder/backups/v1 manually');
    // Reliable reservation precedes any payload: a crash here leaves a gap,
    // never a reused sequence, and a rolled-back counter cannot undercut it.
    writeStateFile(backupV1StatePath('store.json'), JSON.stringify(Object.assign({}, store, { lastSequence: sequence })), parseBackupStoreState);
    checkExecution(cancelled);
    const v1Dir = internalStatePath(path.join('.7coder', 'backups', 'v1'));
    const opDeadline = Date.now() + BACKUP_IO_BUDGET_MS;
    let stagingDir = null, owned = false;
    try {
      stagingDir = createOwnedBackupStageDir(v1Dir);
      owned = true;
      const staged = copyBackupPayload(fullPath, sourceStat, path.join(stagingDir, 'data.bak'), cancelled, opDeadline);
      // Independent read-back: the digest and byte count must survive a reopen.
      const verify = digestBackupFile(path.join(stagingDir, 'data.bak'), staged.bytes, 'Staged backup', { cancelled, deadlineAt: opDeadline });
      if (verify.sha256 !== staged.sha256 || verify.bytes !== staged.bytes) throw new Error('staged payload failed its read-back digest check');
      const snapshotId = crypto.randomBytes(16).toString('hex');
      const manifest = {
        kind: BACKUP_MANIFEST_KIND, version: BACKUP_STORE_VERSION, storeId: store.storeId,
        snapshotId, sequence, createdAt: new Date().toISOString(),
        sourceRel: rel.split(path.sep).join('/'), sourceKey: normalizeBackupSourceKey(rel),
        bytes: staged.bytes, sha256: staged.sha256
      };
      const manifestPath = path.join(stagingDir, 'manifest.json');
      replaceStateBytes(manifestPath, Buffer.from(JSON.stringify(manifest), 'utf8'), manifestPath);
      const finalDir = path.join(v1Dir, String(sequence).padStart(16, '0') + '-' + snapshotId);
      let exists = true;
      try { fs.statSync(finalDir); } catch (e) { exists = false; }
      if (exists) throw new Error('backup record already exists: ' + path.basename(finalDir));
      // The publish point: one rename of the fully verified directory.
      fs.renameSync(stagingDir, finalDir);
      owned = false;
      try {
        const payload = fs.statSync(path.join(finalDir, 'data.bak'));
        const manifestStat = fs.statSync(path.join(finalDir, 'manifest.json'));
        if (payload.size !== staged.bytes || !manifestStat.isFile()) throw new Error('published record is unreadable');
      } catch (e) { throw new Error('post-publish verification failed: ' + e.message); }
      pruneOwnedBackups(finalDir, cancelled, cap);
      return path.join(finalDir, 'data.bak');
    } finally {
      if (owned && stagingDir) recycleOwnedBackupStaging(stagingDir);
    }
  } catch (e) {
    throw new Error('Cannot preserve previous file ' + rel + ': ' + e.message);
  }
}
// Ownership-first retention. Only this store's fully verified published
// records are grouped (null-prototype map); per-source and global count caps
// and the byte target are enforced by sequence; the just-published record and
// active restore pins are protected; every deletion re-verifies manifest and
// payload digest, renames the record out of the undo index first, and leaves
// .deleting-* evidence instead of pretending success. Incomplete discovery,
// foreign/unknown/corrupt/legacy entries and deleting/staging residue are
// never deleted, so owned caps cannot be met by deleting what we do not own.
// Full re-verification of one deletion candidate immediately before any
// destructive step (recheck R1). Discovery-time eligibility is never trusted
// across the gap: the directory must still be a plain, non-link directory
// resolving inside the store root with exactly the two protocol members, the
// payload must be an exclusively owned regular file with an unchanged
// identity, and the manifest must still prove ownership of THIS store with
// every field unchanged. Any deviation preserves the record and reports.
function reverifyOwnedRecordForDeletion(store, victim, context) {
  const dirStat = fs.lstatSync(victim.dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('record path is no longer a plain directory');
  const dirReal = realPathSafe(victim.dir);
  if (path.basename(dirReal) !== victim.name || path.dirname(dirReal) !== realPathSafe(path.dirname(victim.dir))) {
    throw new Error('record path resolves outside the store root (link/junction suspected)');
  }
  const members = fs.readdirSync(victim.dir);
  if (members.length !== 2 || members.indexOf('data.bak') < 0 || members.indexOf('manifest.json') < 0) {
    throw new Error('record carries unexpected members (' + members.join(', ') + ')');
  }
  const payloadPath = path.join(victim.dir, 'data.bak');
  const payloadStat = fs.lstatSync(payloadPath);
  const manifestStat = fs.lstatSync(path.join(victim.dir, 'manifest.json'));
  if (!payloadStat.isFile() || payloadStat.isSymbolicLink() || payloadStat.nlink > 1) throw new Error('payload is not an exclusively owned regular file');
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('manifest is not a regular file');
  const same = st => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => st[k] === victim.payloadStat[k]);
  if (!same(payloadStat)) throw new Error('payload identity changed since discovery');
  const bytes = readFileBytesBounded(path.join(victim.dir, 'manifest.json'), BACKUP_MANIFEST_MAX_BYTES, 'Backup manifest');
  const manifest = validateBackupManifest(JSON.parse(decodeUtf8Text(bytes)), victim.name, victim.seq, victim.manifest.snapshotId);
  if (manifest.storeId !== store.storeId || manifest.storeId !== victim.manifest.storeId) throw new Error('record no longer belongs to this store');
  for (const field of ['sha256', 'bytes', 'sourceKey', 'sourceRel', 'createdAt', 'snapshotId']) {
    if (manifest[field] !== victim.manifest[field]) throw new Error('manifest field ' + field + ' changed since discovery');
  }
  const digest = digestBackupFile(payloadPath, victim.bytes, 'Prune check', context);
  if (digest.sha256 !== manifest.sha256) throw new Error('payload digest changed since discovery');
  return dirStat;
}
function pruneOwnedBackups(protectDir, cancelled, cap) {
  cap = cap || backupRetentionLimits(null);
  try {
    const store = loadBackupStore();
    const index = discoverBackupV1(store.storeId);
    if (index.incomplete.length) {
      console.warn('[BACKUP] cleanup deferred: index incomplete (' + index.incomplete.join('; ') + ')');
      return;
    }
    // Unified survivor plan (recheck R2/R3): count and byte quotas are
    // computed over ONE survivor set that includes EVERY owned record - the
    // just-published snapshot and pinned records occupy quota slots and bytes
    // like any other record; they are only excluded from becoming victims.
    const isProtected = r => r.dir === protectDir || activeBackupRestorePins.has(r.dir);
    const victims = new Map();
    const addVictims = list => { for (const r of list) if (!isProtected(r) && !victims.has(r.dir)) victims.set(r.dir, r); };
    const groups = Object.create(null);
    for (const r of index.records) (groups[r.manifest.sourceKey] = groups[r.manifest.sourceKey] || []).push(r);
    for (const key of Object.keys(groups)) {
      addVictims(groups[key].sort((a, b) => b.seq - a.seq).slice(cap.perSource));
    }
    addVictims(index.records.slice().sort((a, b) => b.seq - a.seq).slice(cap.globalKeep));
    let remaining = 0;
    for (const r of index.records) if (!victims.has(r.dir)) remaining += r.bytes;
    if (remaining > cap.retainTarget) {
      for (const r of index.records.slice().sort((a, b) => a.seq - b.seq)) {
        if (remaining <= cap.retainTarget) break;
        if (victims.has(r.dir) || isProtected(r)) continue;
        victims.set(r.dir, r); remaining -= r.bytes;
      }
    }
    const failures = [];
    // Never report a byte target as met when protected records hold it open.
    if (remaining > cap.retainTarget) failures.push('byte target not reachable: protected/pinned records still hold ' + remaining + ' of ' + cap.retainTarget + ' target bytes');
    const ordered = Array.from(victims.values()).sort((a, b) => a.seq - b.seq); // oldest first
    if (!ordered.length) {
      if (failures.length) console.warn('[BACKUP] ' + failures.join('; '));
      return;
    }
    const deadline = Date.now() + BACKUP_DISCOVERY_DEADLINE_MS;
    let removed = 0;
    for (const v of ordered) {
      if (Date.now() >= deadline) { failures.push('cleanup time budget reached; stopped with candidates remaining'); break; }
      try {
        if (isProtected(v)) continue; // a pin may have appeared since planning
        const dirStat = reverifyOwnedRecordForDeletion(store, v, { cancelled, deadlineAt: deadline });
        const deletingDir = path.join(path.dirname(v.dir), '.deleting-' + v.name + '-' + crypto.randomBytes(4).toString('hex'));
        let exists = true;
        try { fs.statSync(deletingDir); } catch (e) { exists = false; }
        if (exists) throw new Error('deleting destination already exists');
        fs.renameSync(v.dir, deletingDir);
        // Re-check the moved object itself before unlinking through the new
        // path: a swap around the rename must not turn member deletion into
        // deleting through a foreign link.
        const moved = fs.lstatSync(deletingDir);
        if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== dirStat.dev || moved.ino !== dirStat.ino) {
          throw new Error('moved record changed identity before member deletion; evidence kept at ' + deletingDir);
        }
        const members = fs.readdirSync(deletingDir);
        if (members.length !== 2 || members.indexOf('data.bak') < 0 || members.indexOf('manifest.json') < 0) {
          throw new Error('unexpected members after move; evidence kept at ' + deletingDir);
        }
        fs.unlinkSync(path.join(deletingDir, 'data.bak'));
        fs.unlinkSync(path.join(deletingDir, 'manifest.json'));
        try { fs.rmdirSync(deletingDir); }
        catch (e2) { throw new Error('directory busy (' + e2.code + '); evidence kept at ' + deletingDir); }
        removed++;
      } catch (e) { failures.push(v.dir + ': ' + e.message); }
    }
    if (failures.length) console.warn('[BACKUP] cleanup incomplete, evidence kept (' + failures.length + ' issue(s), ' + removed + ' removed): ' + failures.slice(0, 4).join('; '));
  } catch (e) {
    console.warn('[BACKUP] cleanup deferred after publishing (' + e.message + ') - the new snapshot is intact');
  }
}
function backupRestoreConflict(stage, message) {
  const e = new Error(message);
  e.restoreConflict = stage;
  return e;
}
// Prepare + verify + single-rename commit for /undo. The existing target is
// never unlinked or truncated: staging is written in the target's parent,
// re-read, (for managed state) parsed, and both target and selected backup are
// re-verified immediately before the one rename that replaces the target.
function commitBackupRestore(target, sourcePath, expectedBytes, expectedSha256, info, context) {
  const result = { format: info.format, snapshotId: info.snapshotId === undefined ? null : info.snapshotId, sequence: info.sequence === undefined ? null : info.sequence };
  const parent = path.dirname(target);
  try {
    if (!isInsideDir(getLaunchDirReal(), realPathSafe(parent))) throw new Error('target parent resolves outside the workspace');
  } catch (e) { return Object.assign(result, { status: 'failed', stage: 'prepare', message: e.message }); }
  let targetBefore = null;
  try {
    const st = fs.lstatSync(target);
    if (!st.isFile()) return Object.assign(result, { status: 'failed', stage: 'prepare', message: 'existing target is not a regular file' });
    targetBefore = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  } catch (e) {
    if (e.code !== 'ENOENT') return Object.assign(result, { status: 'failed', stage: 'prepare', message: e.message });
  }
  const pin = info.recordDir || null;
  if (pin) activeBackupRestorePins.add(pin);
  const tempPath = path.join(parent, '.7coder-restore-' + process.pid + '-' + crypto.randomBytes(8).toString('hex'));
  let tempOwned = false;
  let outcome = null;
  try {
    const srcFd = fs.openSync(sourcePath, 'r');
    let tempFd = null, tempClosed = false;
    try {
      const before = fs.fstatSync(srcFd);
      if (!before.isFile()) throw new Error('selected backup is not a regular file');
      if (before.size !== expectedBytes) throw new Error('selected backup changed size before restore (' + before.size + ' != ' + expectedBytes + ')');
      tempFd = fs.openSync(tempPath, 'wx');
      tempOwned = true;
      const buffer = Buffer.alloc(BACKUP_CHUNK_BYTES);
      let total = 0, idleWrites = 0;
      while (total < expectedBytes) {
        // Chunk-level cancellation and wall-clock budget (recheck R5).
        checkExecution(context && context.cancelled);
        if (context && context.deadlineAt && Date.now() >= context.deadlineAt) throw new Error('restore staging budget exceeded');
        const want = Math.min(BACKUP_CHUNK_BYTES, expectedBytes - total);
        const got = fs.readSync(srcFd, buffer, 0, want, total);
        if (!got) throw new Error('selected backup ended early at ' + total + ' of ' + expectedBytes + ' bytes');
        let off = 0;
        while (off < got) {
          const wrote = fs.writeSync(tempFd, buffer, off, got - off);
          if (!(wrote > 0)) { if (++idleWrites > 16) throw new Error('restore staging write made no progress'); continue; }
          idleWrites = 0; off += wrote; total += wrote;
        }
      }
      fs.fsyncSync(tempFd);
      fs.closeSync(tempFd);
      tempClosed = true;
      const after = fs.fstatSync(srcFd), named = fs.statSync(sourcePath);
      const same = st => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => st[k] === before[k]);
      if (!same(after) || !same(named)) throw new Error('selected backup changed during restore staging');
    } finally {
      if (tempFd !== null && !tempClosed) { try { fs.closeSync(tempFd); } catch (e2) {} }
      try { fs.closeSync(srcFd); } catch (e2) {}
    }
    const staged = digestBackupFile(tempPath, expectedBytes, 'Restore staging', context);
    if (staged.sha256 !== expectedSha256) throw new Error('restore staging digest mismatch');
    // Managed state must parse before it may replace a live target; parser
    // errors never echo file contents (models.json/.env may hold credentials).
    const parser = managedStateParser(target);
    if (parser) {
      let bytes;
      try { bytes = readStateBytes(tempPath, stateFileByteLimit()); }
      catch (e) { throw new Error('restored content exceeds the managed-state budget (' + e.code + '); not overwriting the target'); }
      try { parser(decodeUtf8Text(bytes)); }
      catch (e) { throw new Error('restored content is not valid managed state (' + e.message + '); not overwriting the target'); }
    }
    if (info.payloadStat) {
      const st = fs.statSync(sourcePath);
      if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(k => st[k] !== info.payloadStat[k])) throw backupRestoreConflict('verify', 'selected backup changed before commit');
    }
    if (targetBefore) {
      let now = null;
      try { const st = fs.lstatSync(target); if (st.isFile()) now = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }; }
      catch (e) { now = null; }
      if (!now || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(k => now[k] !== targetBefore[k])) throw backupRestoreConflict('verify', 'existing target was created, deleted, replaced or edited during restore');
    } else {
      let appeared = false;
      try { appeared = fs.lstatSync(target).isFile(); } catch (e) {}
      if (appeared) throw backupRestoreConflict('verify', 'a target that was initially absent appeared during restore');
    }
    if (!isInsideDir(getLaunchDirReal(), realPathSafe(parent))) throw backupRestoreConflict('verify', 'target path boundary changed before commit');
    // A restore that outlived its operation budget must not commit (recheck R5).
    if (context && context.deadlineAt && Date.now() >= context.deadlineAt) throw new Error('restore operation budget exceeded before commit');
    // The only commit point: one same-directory rename over the target.
    fs.renameSync(tempPath, target);
    tempOwned = false;
    outcome = Object.assign(result, { status: 'restored', stage: 'commit', message: 'restored ' + expectedBytes + ' byte(s)', bytes: expectedBytes, warnings: info.warnings || [] });
  } catch (e) {
    outcome = Object.assign(result, e.restoreConflict
      ? { status: 'conflict', stage: e.restoreConflict, message: e.message }
      : { status: 'failed', stage: 'stage', message: e.message, errno: e.code || null });
  } finally {
    if (pin) activeBackupRestorePins.delete(pin);
    if (tempOwned) {
      try { fs.unlinkSync(tempPath); }
      catch (e2) {
        if (e2.code !== 'ENOENT') outcome.residue = 'restore staging retained at ' + tempPath + ' (' + (e2.code || e2.message) + ')';
      }
    }
  }
  return outcome;
}
// Detailed /undo: v1 protocol history wins; legacy fallback only when the
// source has no v1 history at all. A damaged newest v1 snapshot fails
// explicitly; unattributable newer records make the result "unknown" rather
// than a silently older "success". Result statuses: restored / not-found /
// failed / conflict / unknown.
function restoreLatestBackupDetailed(rel, cancelled) {
  const base = { requested: String(rel) };
  let safeRel;
  try { safeRel = sanitizePath(rel); }
  catch (e) { return Object.assign(base, { status: 'failed', stage: 'resolve-path', message: e.message }); }
  if (!safeRel) return Object.assign(base, { status: 'failed', stage: 'resolve-path', message: 'file path required' });
  base.sourceRel = safeRel.split(path.sep).join('/');
  const target = path.join(launchDir, safeRel);
  try {
    if (isInsideDir(realPathSafe(backupsDir), realPathSafe(target))) return Object.assign(base, { status: 'failed', stage: 'guard', message: 'cannot restore into the backup store itself' });
  } catch (e) { return Object.assign(base, { status: 'failed', stage: 'guard', message: e.message }); }
  let store = null;
  try { store = loadBackupStore(); }
  catch (e) {
    if (e.code === 'EBACKUPIDENTITY') return Object.assign(base, { status: 'unknown', stage: 'store', message: e.message });
    return Object.assign(base, { status: 'failed', stage: 'store', message: e.message });
  }
  let index;
  // Index IO failures (EACCES/EIO/...) must stay inside the detailed-result
  // protocol instead of escaping as exceptions (recheck R6).
  try { index = discoverBackupV1(store.storeId); }
  catch (e) { return Object.assign(base, { status: 'unknown', stage: 'index', message: 'backup index unreadable (' + (e.code || e.message) + ')' }); }
  if (index.incomplete.length) return Object.assign(base, { status: 'unknown', stage: 'index', message: 'backup index incomplete (' + index.incomplete.join('; ') + ')' });
  const key = normalizeBackupSourceKey(safeRel);
  let best = null, tie = false;
  for (const r of index.records) {
    if (r.manifest.sourceKey !== key) continue;
    if (!best || r.seq > best.seq) { best = r; tie = false; }
    else if (r.seq === best.seq) tie = true;
  }
  if (best && tie) return Object.assign(base, { status: 'unknown', stage: 'select', message: 'duplicate newest sequence ' + best.seq + ' for this source; inspect .7coder/backups/v1 manually' });
  if (best) {
    for (const c of index.corrupt) {
      if (c.seq === null) continue;
      // Sequence uniqueness is a store invariant: a damaged record SHARING
      // the selected sequence makes "newest" ambiguous (recheck R4B), not
      // silently restorable.
      if (c.seq === best.seq) return Object.assign(base, { status: 'unknown', stage: 'select', message: 'sequence ' + c.seq + ' is ambiguous: a damaged record shares the newest owned sequence for this source' });
      if (c.sourceKey === key && c.seq > best.seq) return Object.assign(base, { status: 'failed', stage: 'select', message: 'the newest v1 snapshot (sequence ' + c.seq + ') is damaged: ' + c.reason });
      if (!c.sourceKey && c.seq > best.seq) return Object.assign(base, { status: 'unknown', stage: 'select', message: 'a newer unattributable record (sequence ' + c.seq + ') exists; cannot prove this is the newest generation' });
    }
    const warnings = managedStateParser(target)
      ? ['restored configuration applies to disk only; restart or re-run the reload command to change running state']
      : [];
    return Object.assign(base, commitBackupRestore(target, path.join(best.dir, 'data.bak'), best.manifest.bytes, best.manifest.sha256, {
      format: 'v1', snapshotId: best.manifest.snapshotId, sequence: best.seq, payloadStat: best.payloadStat, recordDir: best.dir, warnings
    }, { cancelled, deadlineAt: Date.now() + BACKUP_IO_BUDGET_MS }));
  }
  for (const c of index.corrupt) {
    if (c.seq === null) continue;
    if (c.sourceKey === key) return Object.assign(base, { status: 'failed', stage: 'select', message: 'the only v1 snapshot for this source is damaged: ' + c.reason });
    if (c.sourceKey) continue; // verifiably another source's record
    return Object.assign(base, { status: 'unknown', stage: 'select', message: 'an unattributable v1 record (sequence ' + c.seq + ') may be newer than any legacy file' });
  }
  const legacy = discoverLegacyBackupCandidates(safeRel);
  if (legacy.incomplete) return Object.assign(base, { status: 'unknown', stage: 'legacy-index', message: 'legacy backup scan incomplete (' + legacy.incomplete + ')' });
  if (!legacy.candidates.length) return Object.assign(base, {
    status: 'not-found', stage: 'select',
    message: legacy.hardlinked
      ? 'no usable backup (' + legacy.hardlinked + ' legacy candidate(s) are hard-linked and were excluded)'
      : 'no v1 or legacy backup exists for this file'
  });
  let newest = null, tieCount = 0;
  for (const c of legacy.candidates) {
    if (!newest || c.mtimeMs > newest.mtimeMs) { newest = c; tieCount = 1; }
    else if (c.mtimeMs === newest.mtimeMs) tieCount++;
  }
  if (tieCount > 1) return Object.assign(base, { status: 'unknown', stage: 'legacy-select', message: tieCount + ' legacy backups share the newest timestamp; inspect ' + path.join('.7coder', 'backups', path.dirname(safeRel) === '.' ? '' : path.dirname(safeRel)) + ' manually' });
  // Explicit admission for legacy payloads (recheck R5): the 1GiB cap is not
  // automatically inherited from the creation path.
  if (newest.size > BACKUP_SINGLE_MAX_BYTES) return Object.assign(base, { status: 'failed', stage: 'legacy-verify', message: 'legacy backup exceeds the ' + BACKUP_SINGLE_MAX_BYTES + '-byte single-snapshot budget' });
  let digest;
  try { digest = digestBackupFile(newest.full, newest.size, 'Legacy backup', { cancelled, deadlineAt: Date.now() + BACKUP_IO_BUDGET_MS }); }
  catch (e) { return Object.assign(base, { status: 'failed', stage: 'legacy-verify', message: e.message }); }
  const legacyWarnings = ['legacy snapshot has no creation-time digest; only this copy could be verified'];
  if (managedStateParser(target)) legacyWarnings.push('restored configuration applies to disk only; restart or re-run the reload command to change running state');
  return Object.assign(base, commitBackupRestore(target, newest.full, newest.size, digest.sha256, { format: 'legacy', payloadStat: newest.stat, warnings: legacyWarnings }, { cancelled, deadlineAt: Date.now() + BACKUP_IO_BUDGET_MS }));
}
// Boolean wrapper kept for older internal callers and tests.
function restoreLatestBackup(rel) {
  return restoreLatestBackupDetailed(rel).status === 'restored';
}

// Small unified-ish diff for approval previews: trims the common prefix/suffix,
// then shows a bit of context plus - / + lines. Not a full LCS diff, but enough
// for a human to judge an edit.
function simpleLineDiff(oldText, newText, contextLines = 2, maxLines = 40) {
  // Large sources use the caller's exact-arguments approval fallback. Bound
  // before splitting: maxLines only limits the final display, not allocations.
  if (Buffer.byteLength(String(oldText), 'utf8') > 65536 || Buffer.byteLength(String(newText), 'utf8') > 65536) return null;
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
function sessionFilePath() { return internalStatePath('.7coder', 'session.json'); }
function pruneCliSessionHistory(currentName) {
  const directory = internalStatePath('.7coder/sessions'), candidates = [];
  let unreadable = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^cli-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.json$/.test(name)) continue;
    try {
      const file = internalStatePath('.7coder/sessions', name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > SESSION_MAX_BYTES) continue;
      // Retention must not repair/quarantine or reinterpret an unknown file.
      const bytes = readFileBytesBounded(file, SESSION_MAX_BYTES, 'CLI archive'), record = parseSessionState(decodeUtf8Text(bytes));
      if (record.kind !== '7coder-cli-session-v1' || !Number.isFinite(Date.parse(record.savedAt))) continue;
      candidates.push({ name, time: Date.parse(record.savedAt), hash: crypto.createHash('sha256').update(bytes).digest('hex') });
    } catch (error) { unreadable++; }
  }
  candidates.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  let remove = candidates.length - 20;
  for (const candidate of candidates) {
    if (remove <= 0) break;
    if (candidate.name === currentName) continue; // protect latest save even after clock rollback
    const file = internalStatePath('.7coder/sessions', candidate.name);
    if (crypto.createHash('sha256').update(readFileBytesBounded(file, SESSION_MAX_BYTES, 'CLI archive')).digest('hex') !== candidate.hash) {
      console.warn('[WARN] CLI history changed during retention; cleanup stopped without deleting it.'); break;
    }
    deleteStateFile(file); remove--;
  }
  if (unreadable) console.warn('[WARN] CLI history retention preserved ' + unreadable + ' unreadable file(s).');
}
function saveSession() {
  try {
    if (messages.length <= 1) return; // system only - nothing to save
    // Strip tool_calls from assistant turns: the tool results are filtered out,
    // so keeping the calls would break assistant(tool_calls) -> tool pairing on load.
    const keep = messages
      .filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
      .map(m => (m.role === 'assistant' && m.tool_calls) ? { role: 'assistant', content: m.content || '' } : m);
    const savedAt = new Date().toISOString();
    const body = JSON.stringify({ kind: '7coder-cli-session-v1', savedAt, messages: keep });
    if (Buffer.byteLength(body, 'utf8') > SESSION_MAX_BYTES) { console.warn('[WARN] session too large to save (>2 MiB UTF-8)'); return; }
    fs.mkdirSync(internalStatePath('.7coder'), { recursive: true });
    writeStateFile(sessionFilePath(), body, parseSessionState);
    // Explicit CLI ownership: keep twenty new CLI archives, never prune
    // Web/legacy/unknown records by their filename ordering.
    try {
      const sdir = internalStatePath('.7coder/sessions');
      fs.mkdirSync(sdir, { recursive: true });
      const name = 'cli-' + savedAt.replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex') + '.json';
      writeStateFile(internalStatePath('.7coder/sessions', name), body, parseSessionState);
      pruneCliSessionHistory(name);
    } catch (e2) { console.warn('[WARN] session history save/prune failed: ' + e2.message); }
  } catch (e) { console.warn('[WARN] session save failed: ' + e.message); }
}
function loadSession() {
  try {
    const sessionPath = sessionFilePath();
    const record = readStateRecord(sessionPath, parseSessionState);
    if (!record) return false;
    const j = record.value;
    const clean = j.messages.filter(m => m && (m.role === 'system' || ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')));
    if (clean.length < 2) return false;
    messages = clean;
    return true;
  } catch (e) { console.warn('[WARN] session load failed: ' + e.message); return false; }
}

async function summarizeAction(rawPrompt, assistantResponse, modelContext, cancelled) {
  // AST-R1: replies shorter than 200 chars carry nothing worth a light-model
  // round-trip - skip the call entirely (callers treat null as "no summary").
  // A whitespace-only/empty reply is not a "short reply", it is a degenerate
  // response; the fallback summary below exists exactly for that case and
  // must stay reachable (empty-reply contract in suite G).
  const trimmedReply = String(assistantResponse == null ? '' : assistantResponse).trim();
  if (trimmedReply.length > 0 && trimmedReply.length < 200) return null;
  const prompt = `Create a short, concise summary (1-2 sentences) of what has been done in response to the user's task. Do not list tools, just describe the output/effect.
User task: "${rawPrompt}"
Action/Response: "${assistantResponse}"`;
  try {
    const choice = await callOpenAI([{ role: 'user', content: prompt }], { model: modelContext ? modelContext.summary : SUMMARY_MODEL || LIGHT_MODEL || HEAVY_MODEL, modelContext, cancel: cancelled, maxTokens: SUMMARY_MAX_TOKENS, useTools: false });
    return (choice.message.content || `Completed task: ${rawPrompt}`).trim();
  } catch (e) {
    if (cancelled && cancelled()) throw e;
    return `Completed task: ${rawPrompt}`;
  }
}

// Task summaries live inside a marker-delimited section so they never destroy
// free-form content (e.g. a dream session's reorganized 7CODER.md). Anything
// outside the markers is preserved verbatim; the bullet log inside is rebuilt
// from the previous bullets plus the new one.
const LOG_START = '<!-- 7coder:auto-log:start -->';
const LOG_END = '<!-- 7coder:auto-log:end -->';

// HTTP summaries run outside the permission gate, one at a time. Admission
// includes the active item; overload writes a bounded compact record instead
// of retaining an unbounded Promise chain or silently losing the whole task.
function createActionSummaryQueue(options = {}) {
  const maxJobs = options.maxJobs || 8, maxBytes = options.maxBytes || 2 * 1024 * 1024;
  const maxQueueAge = options.maxQueueAge || 60000, maxLifetime = options.maxLifetime || 120000;
  const pending = [];
  let active = null, bytes = 0;
  function compact(payload, reason) {
    console.warn('[SUMMARY] ' + payload.id + ': ' + reason);
    if (shuttingDown || Date.now() >= payload.deadlineAt) return;
    const short = value => String(value || '').slice(0, 500).replace(/\s+/g, ' ').trim();
    try { updateCompleteSummary('Task: ' + short(payload.rawPrompt) + '; response: ' + short(payload.result) + ' [compact summary: ' + reason + ']'); }
    catch (error) { console.warn('[SUMMARY] compact record failed: ' + error.message); }
  }
  function release(job) {
    clearTimeout(job.timer); job.detach(); job.execution.dispose();
    bytes -= job.bytes; job.payload = null;
  }
  function pump() {
    if (active || !pending.length) return;
    const job = pending.shift(); active = job;
    clearTimeout(job.timer); job.detach();
    (async () => {
      try {
        checkExecution(job.execution);
        const p = job.payload;
        const summary = await summarizeAction(p.rawPrompt, p.result, p.modelContext, job.execution);
        checkExecution(job.execution);
        updateCompleteSummary(summary);
      } catch (error) {
        console.warn('[SUMMARY] ' + job.payload.id + ': not written: ' + error.message);
      } finally {
        release(job); active = null; pump();
      }
    })();
  }
  return {
    enqueue(payload) {
      if (shuttingDown || Date.now() >= payload.deadlineAt) { console.warn('[SUMMARY] ' + payload.id + ': expired before enqueue.'); return false; }
      const trimmedReply = payload.result.trim();
      if (trimmedReply.length > 0 && trimmedReply.length < 200) return true;
      const size = Buffer.byteLength(payload.rawPrompt, 'utf8') + Buffer.byteLength(payload.result, 'utf8') +
        Buffer.byteLength(JSON.stringify(payload.modelContext || {}), 'utf8');
      if (pending.length + (active ? 1 : 0) >= maxJobs || bytes + size > maxBytes) {
        compact(payload, 'queue capacity exceeded'); return false;
      }
      const execution = createExecutionControl(Math.max(1, Math.min(maxLifetime, payload.deadlineAt - Date.now())));
      const job = { payload, bytes: size, execution, timer: null, detach: () => {} };
      bytes += size; pending.push(job);
      job.detach = watchExecution(execution, () => {
        const index = pending.indexOf(job);
        if (index < 0) return;
        pending.splice(index, 1);
        // A queue-age cancellation may still record the bounded response;
        // an expired original request or Agent shutdown never writes here.
        compact(job.payload, execution.reason || 'queued summary cancelled');
        release(job); pump();
      });
      if (pending.includes(job)) job.timer = setTimeout(() => execution.cancel('summary queue wait exceeded'), maxQueueAge);
      pump(); return true;
    },
    stats() { return { active: !!active, pending: pending.length, bytes }; }
  };
}
const actionSummaryQueue = createActionSummaryQueue();
function updateCompleteSummary(newSummary) {
  // AST-R1: null means summarizeAction skipped the call (short reply) - leave
  // 7CODER.md untouched instead of appending "null".
  if (!newSummary) return;
  const mdPath = managedWorkspacePath('7CODER.md');
  let existing = '';
  try {
    const record = readStateRecord(mdPath);
    if (record) existing = record.value;
  } catch (e) {
    console.error('Error reading 7CODER.md; summary not written:', e.message);
    return;
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
  // OP5-5: a repeated task that produces the identical summary (retry, same
  // output) must not grow the bullet log - if the last bullet already says
  // exactly this, leave the file untouched.
  if (summaries.length && summaries[summaries.length - 1] === newSummary) {
    console.log('[OK] summary unchanged - dedup');
    return;
  }
  summaries.push(newSummary);
  // OP5-5: cap the auto-log at the newest 60 bullets so a long-lived
  // workspace's 7CODER.md cannot grow without bound.
  if (summaries.length > 60) summaries = summaries.slice(-60);
  // Free-form content outside the markers survives (dream sessions, user notes)
  const outside = (startIdx >= 0 && endIdx > startIdx)
    ? (existing.substring(0, startIdx) + existing.substring(endIdx + LOG_END.length)).trim()
    : existing.trim();
  const autoSection = LOG_START + '\n' + summaries.map(s => '- ' + s).join('\n') + '\n' + LOG_END;
  const next = outside ? autoSection + '\n\n' + outside + '\n' : autoSection + '\n';
  try {
    writeStateFile(mdPath, next);
    console.log('[OK] 7CODER.md updated with complete summary');
  } catch (e) {
    console.error('Error writing to 7CODER.md:', e);
  }
}

// ====================== CORE EXECUTION ======================
async function executeTask(modelContext = createModelContext()) {
  if (shuttingDown) return;
  const cancelled = createExecutionControl();
  const finishRuntime = beginRuntimeOperation('cli-task');
  try {
    resetTaskChanges(); // GAP-12: the [CHANGES] summary covers exactly this task
    createTaskGitCheckpoint();
    console.log(`7coder is ${getRandomSpinner()}`);
    let streamed = false;
    const onDelta = (t) => { streamed = true; process.stdout.write(t); };
    let displayReply = await processWithTools(messages, { onDelta, modelContext, cancel: cancelled });
    checkExecution(cancelled);

    if (ENABLE_RALPH_MODE) {
      console.log(`[LOOP] Ralph Wiggum Loop - Iteration 1: ${displayReply.substring(0, 120)}${displayReply.length > 120 ? '...' : ''}`);

      for (let attempt = 2; attempt <= RALPH_ITERATIONS; attempt++) {
        const refineMsg = `You are in Claude-Like Ralph Wiggum loop mode. This is iteration ${attempt}. Review and iterate. You may use any tools. If complete, start reply with exactly "RALPH_WIGGUM_COMPLETE" followed by final version.`;
        messages.push({ role: 'user', content: refineMsg });
        displayReply = await processWithTools(messages, { onDelta, modelContext, cancel: cancelled });
        checkExecution(cancelled);

        if (displayReply.trim().startsWith('RALPH_WIGGUM_COMPLETE')) {
          displayReply = displayReply.replace(/^RALPH_WIGGUM_COMPLETE\s*/i, '').trim();
          console.log(`[OK] Completion promise fulfilled at iteration ${attempt}!`);
          break;
        }
        console.log(`[LOOP] Ralph Wiggum Loop - Iteration ${attempt}: ${displayReply.substring(0, 120)}${displayReply.length > 120 ? '...' : ''}`);
      }
    }

    // Generate action summary using the small model
    const newSummary = await summarizeAction(currentRawPrompt, displayReply, modelContext, cancelled);
    checkExecution(cancelled);
    updateCompleteSummary(newSummary);

    updateLastInteractionTime();

    if (streamed) console.log(''); // deltas were already printed live
    else console.log(`\n7coder: ${displayReply}`);
    printTaskChanges(); // GAP-12: silent when the task changed nothing
    logSessionUsage(); // GAP-8
    finishRuntime('ok');
    return true;
  } catch (err) {
    finishRuntime(cancelled() ? 'cancelled' : 'error', err);
    const exiting = shuttingDown && cancelled();
    console.error(`${exiting ? '[CANCELLED]' : '[ERROR]'} Error: ${err.message}`);
    printTaskChanges(); // GAP-12: failure path reports what did happen too
    logSessionUsage(); // GAP-8
    if (!exiting) process.exitCode = 1;
    return false;
  } finally {
    cancelled.dispose();
  }
}

// Build a 7coder conversation from a client's OpenAI-style message list.
// The client's own history gives multi-turn continuity over HTTP; our system
// prompt always replaces theirs. Tool messages are not replayed.
// GAP-4: multimodal content arrays keep their structure - text parts merge
// into one leading text item and image_url parts pass through verbatim, so a
// vision-capable upstream still sees the image. Pure-string content and
// text-only arrays are unchanged (they degrade to a plain string exactly as
// before).
function conversationFromClient(clientMessages) {
  const convo = [{ role: 'system', content: systemPrompt }];
  let firstUser = true;
  for (const m of (clientMessages || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (Array.isArray(m.content)) {
      const textPart = m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
      const imageParts = [];
      for (const p of m.content) {
        if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string' && p.image_url.url) {
          imageParts.push({ type: 'image_url', image_url: { url: p.image_url.url } });
        }
      }
      if (imageParts.length) {
        let textOut = textPart;
        if (m.role === 'user' && firstUser) {
          textOut = buildTaskUserContent(textOut);
          firstUser = false;
        }
        convo.push({ role: m.role, content: [{ type: 'text', text: textOut }].concat(imageParts) });
        continue;
      }
      // no images: fall through to the plain-text path below
      let textOnly = textPart;
      if (!textOnly) continue;
      if (m.role === 'user' && firstUser) {
        textOnly = buildTaskUserContent(textOnly);
        firstUser = false;
      }
      convo.push({ role: m.role, content: textOnly });
      continue;
    }
    let content = typeof m.content === 'string' ? m.content : (m.content === undefined || m.content === null ? '' : JSON.stringify(m.content));
    if (m.role === 'assistant' && ['running', 'failed', 'cancelled'].includes(m.status)) {
      content += '\n[Previous response ' + m.status + ': text may be partial; tool side effects may already exist. Check state before retrying.]';
    }
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
const serverStartupState = { phase: 'not-started', error: null, execution: null };
function preemptServerDream() {
  if (serverStartupState.execution && ['queued-dream', 'dream'].includes(serverStartupState.phase)) {
    serverStartupState.execution.cancel('Foreground chat preempted optional startup dream.');
  }
}
async function runServerDream(modelContext) {
  const execution = createExecutionControl(Math.min(EXECUTION_TIMEOUT_MS, 120000));
  serverStartupState.phase = 'queued-dream'; serverStartupState.error = null; serverStartupState.execution = execution;
  let release = null;
  try {
    release = await requestGate(execution);
    checkExecution(execution);
    serverStartupState.phase = 'dream';
    await triggerDreamIfNeeded(modelContext, execution);
    checkExecution(execution);
    serverStartupState.phase = triggerDreamIfNeeded.lastOutcome || 'skipped';
    if (serverStartupState.phase === 'failed') serverStartupState.error = 'Dream consolidation failed; inspect server log.';
  } catch (error) {
    serverStartupState.phase = execution() ? 'cancelled' : 'failed';
    serverStartupState.error = String(error.message).slice(0, 1000);
    console.warn('[STARTUP] Optional dream ' + serverStartupState.phase + ': ' + serverStartupState.error);
  } finally {
    execution.dispose(); serverStartupState.execution = null;
    if (release) release();
  }
}

// AST-10: bounded JSON body reader shared by every POST route. Bytes are
// counted as they arrive (utf8-decoded chunk lengths); on overflow the 413
// response goes out immediately, later chunks are drained without
// accumulating, and a safety timer closes the socket if the client never
// finishes. Before this, the chat route only set a flag and kept growing the
// string until 'end', and the other POST routes had no cap at all.
const BODY_LIMIT_DEFAULT = 1024 * 1024; // ordinary routes; session saves use SESSION_MAX_BYTES
function readJsonBody(req, res, limitBytes, then, options = {}) {
  let body = '';
  let over = false, ended = false, bytes = 0;
  let safety = null, readTimer = null, detach = () => {};
  const fail = (status, message) => {
    if (over || ended) return;
    over = true; body = ''; detach(); clearTimeout(readTimer);
    if (options.onFailure) options.onFailure();
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message } }));
      }
    } catch (error) {}
    safety = setTimeout(() => { try { req.destroy(); } catch (error) {} }, 60000);
  };
  req.setEncoding('utf8');
  req.on('data', c => {
    if (over) return; // keep draining so the client can finish and read the 413
    const size = Buffer.byteLength(c, 'utf8'); bytes += size;
    if (bytes > limitBytes) { fail(413, 'Request body too large (limit ' + limitBytes + ' bytes)'); return; }
    if (options.addBytes && !options.addBytes(size)) { fail(429, 'Chat body memory budget is busy; retry after existing requests finish.'); return; }
    body += c;
  });
  req.on('end', () => {
    ended = true; detach(); clearTimeout(readTimer);
    if (over) { if (safety) clearTimeout(safety); return; }
    try { then(body); } catch (e) {
      if (options.onFailure) options.onFailure();
      try {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      } catch (e2) {}
    }
    body = '';
  });
  const abandon = () => {
    clearTimeout(safety); clearTimeout(readTimer);
    if (ended || over) return;
    over = true; body = ''; detach();
    if (options.onFailure) options.onFailure();
  };
  req.on('error', abandon);
  req.on('aborted', abandon);
  if (options.readTimeoutMs) readTimer = setTimeout(() => fail(408, 'Chat body read deadline exceeded.'), options.readTimeoutMs);
  detach = watchExecution(options.cancelled, () => fail(408, options.cancelled.reason || 'Chat cancelled while reading body.'));
}

function startHttpServer() {
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(HTTP_BIND);
  if (!isLoopback && !HTTP_API_KEY) {
    console.warn('[WARN] HTTP_BIND is not loopback and HTTP_API_KEY is not set -');
    console.warn('[WARN] anyone on the network could use this endpoint to run tools on this machine!');
    console.warn('[WARN] Set HTTP_API_KEY in .env (clients send "Authorization: Bearer <key>") or keep HTTP_BIND=127.0.0.1.');
  }
  // A component failure must not pretend to be a missing file or a ready UI.
  // API/diagnostics stay usable even when the packaged page needs repair.
  let webuiHtml = null, webuiError = null;
  try {
    webuiHtml = readFileBytesBounded(path.join(appDir, 'webui.html'), 2 * 1024 * 1024, 'Built-in UI');
    decodeUtf8Text(webuiHtml);
    if (!webuiHtml.length) throw new Error('Built-in UI file is empty');
  } catch (e) {
    webuiHtml = null; webuiError = { code: runtimeText(e.code, 40), message: runtimeText(e.message) };
    console.warn('[UI] Built-in page unavailable: ' + webuiError.code + ' ' + webuiError.message);
  }

  // ---------- OP5-3: shared helpers + per-route handlers ----------
  // One auth gate for every keyed route (OP2-4 caught three routes that had
  // silently missed their copy of the check; with the table below a new route
  // declares auth:true instead of re-pasting the 401 block).
  function hasAuth(req) {
    return !HTTP_API_KEY || req.headers.authorization === 'Bearer ' + HTTP_API_KEY;
  }
  function writeWorkspaceEnv(updates) {
    const wsEnv = managedWorkspacePath('.env');
    // A2-16: ONLY the managed keys being updated are rewritten. The old code
    // dotenv.parsed the WHOLE file and re-serialized every key - a multiline
    // value like CUSTOM="first\nsecond" lost its quoting and got split into
    // two broken lines. Unknown KEY= lines now pass through verbatim.
    // Managed values are endpoint/key/model. The route rejects CR/LF/NUL;
    // quoting below also preserves whitespace and literal enclosing quotes.
    const managed = {};
    for (const k of Object.keys(updates)) {
      const value = String(updates[k]);
      // dotenv 8 strips enclosing quotes and trims unquoted values. Choose a
      // representation that survives restart with exactly the requested value.
      managed[k] = require('dotenv').parse(k + '=' + value)[k] === value ? value : "'" + value + "'";
    }
    const outLines = [];
    const written = new Set();
    const current = readStateRecord(wsEnv);
    if (current) {
      for (const line of current.value.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && managed[m[1]] !== undefined) { outLines.push(m[1] + "=" + managed[m[1]]); written.add(m[1]); }
        else outLines.push(line); // comments, blank lines, MULTILINE continuations, unknown keys - untouched
      }
    }
    for (const k of Object.keys(managed)) { if (!written.has(k)) outLines.push(k + "=" + managed[k]); }
    const next = outLines.join("\n") + "\n";
    const parsed = require('dotenv').parse(next);
    if (Object.keys(updates).some(k => parsed[k] !== String(updates[k]))) throw new Error('settings cannot be represented losslessly in dotenv 8');
    writeStateFile(wsEnv, next);
  }
  function hUi(req, res) {
    if (webuiHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(webuiHtml);
    } else {
      res.writeHead(webuiError && webuiError.code === 'ENOENT' ? 404 : 503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Built-in UI unavailable: ' + (webuiError ? webuiError.message : 'unknown page error'));
    }
  }
  function hInfo(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: APP_VERSION, model: HEAVY_MODEL, light: LIGHT_MODEL || HEAVY_MODEL, summary: SUMMARY_MODEL || LIGHT_MODEL || HEAVY_MODEL, workspace: launchDir,
      mode: effectivePermissionMode(), configuredMode: PERMISSION_MODE, dangerMode: DANGER_MODE, modeForced: DANGER_MODE && PERMISSION_MODE !== 'denial', permissionRevision: effectivePermissionMode.revision || 0, permissionSession: PERMISSION_SESSION,
      keyRequired: !!HTTP_API_KEY, models: modelList(),
      load: { chatRequests: chatAdmission.count, chatBodyBytes: chatAdmission.bytes, chatActive: requestGateBusy, chatQueued: requestGateQueue.length, summaries: actionSummaryQueue.stats() },
      runtime: runtimeSnapshot(),
      audit: auditSnapshot(),
      ui: { available: !!webuiHtml, fileLimit: 2 * 1024 * 1024, error: webuiError },
      mcp: mcpDiagnosticsSnapshot(),
      startup: { phase: serverStartupState.phase, error: serverStartupState.error },
      capabilities: { persistentShell: !ENABLE_HTTP_SERVER },
      usage: { prompt: sessionUsage.prompt, completion: sessionUsage.completion, total: sessionUsage.prompt + sessionUsage.completion } }));
  }
  function hTodos(req, res) {
    // GAP-6: the structured task list for the webui sidebar; re-read per
    // request so changes made by a CLI session in the same workspace show
    // up immediately.
    try {
      const todos = loadTodos();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ todos }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }
  function hModels(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: modelList().map(id => ({ id, object: 'model', owned_by: '7coder' }))
    }));
  }
  function hSessionsList(req, res) {
    try {
      const sdir = internalStatePath('.7coder/sessions');
      const list = fs.existsSync(sdir)
        ? fs.readdirSync(sdir).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
              try {
                const j = readStateRecord(internalStatePath('.7coder/sessions', f), parseSessionState).value;
                const firstUser = (j.messages || []).find(m => m.role === 'user');
                return { file: f, savedAt: j.savedAt || '?', turns: (j.messages || []).length, preview: firstUser ? String(firstUser.content).substring(0, 80) : '' };
              } catch (e) { return { file: f, savedAt: '?', turns: 0, preview: '(unreadable)' };
              }
            }).sort((a, b) => (Date.parse(b.savedAt) || 0) - (Date.parse(a.savedAt) || 0) || b.file.localeCompare(a.file))
          : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: list }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }
  function hSessionLoad(req, res) {
    readJsonBody(req, res, BODY_LIMIT_DEFAULT, body => {
      try {
        const wanted = String(JSON.parse(body).file || "");
        if (!/^[A-Za-z0-9._-]+[.]json$/.test(wanted)) throw new Error('invalid session file name');
        const f = internalStatePath('.7coder/sessions', wanted);
        const record = readStateRecord(f, parseSessionState);
        if (!record) throw new Error("session not found: " + wanted);
        const j = record.value;
        const msgs = (j.messages || [])
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map(sessionMessageRecord);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: msgs, activities: Array.isArray(j.activities) ? j.activities : [], savedAt: j.savedAt || "?" }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  }
  function hSessionDelete(req, res) {
    readJsonBody(req, res, BODY_LIMIT_DEFAULT, body => {
      try {
        const wanted = String(JSON.parse(body).file || "");
        if (!/^[A-Za-z0-9._-]+[.]json$/.test(wanted)) throw new Error('invalid session file name');
        const f = internalStatePath('.7coder/sessions', wanted);
        if (!fs.existsSync(f) && !fs.existsSync(f + '.7coder-prev')) throw new Error("session not found: " + wanted);
        deleteStateFile(f);
        audit({ ts: new Date().toISOString(), type: 'session_delete', file: wanted });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: wanted }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  }
  function hApprove(req, res) {
    readJsonBody(req, res, BODY_LIMIT_DEFAULT, body => {
      try {
        const j = JSON.parse(body);
        const id = String(j.id || '');
        if (!pendingApprovals.has(id)) throw new Error('no pending approval with id: ' + id);
        const resolve = pendingApprovals.get(id);
        pendingApprovals.delete(id);
        const accepted = resolve(!!j.approved);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, approved: !!accepted }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  }
  function hSessionSave(req, res) {
    readJsonBody(req, res, SESSION_MAX_BYTES, body => {
      try {
        const parsed = JSON.parse(body);
        const msgs = parsed.messages;
        if (!Array.isArray(msgs)) throw new Error("messages must be an array");
        const clean = msgs
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map(sessionMessageRecord);
        const sdir = internalStatePath('.7coder/sessions');
        fs.mkdirSync(sdir, { recursive: true });
        if (Array.isArray(parsed.activities) && parsed.activities.length > 2000) throw new Error('session activity limit exceeded (2000); nothing was overwritten');
        const activities = Array.isArray(parsed.activities) ? parsed.activities.filter(a => a && typeof a.type === 'string')
          .map(a => ({ type: a.type, callId: toolCallIdentity(a.callId) || undefined, turnId: a.turnId === undefined ? undefined : sessionMessageRecord({ turnId: a.turnId }).turnId, name: a.name ? String(a.name).substring(0, 80) : undefined,
            status: a.status ? String(a.status).substring(0, 24) : undefined,
            text: a.text ? String(a.text).substring(0, 12000) : undefined,
            args: a.args && typeof a.args === 'object' ? sanitizeAuditArgs(a.args) : undefined,
            result: a.result ? sanitizeAuditLine(String(a.result)).substring(0, 12000) : undefined })) : [];
        // 原地更新只适用于Web自有记录；继续CLI/legacy档案时新建Web记录。
        const wanted = String(JSON.parse(body).file || "");
        let name = "web-" + new Date().toISOString().replace(/[:.]/g, "-") + '-' + crypto.randomBytes(4).toString('hex') + ".json";
        if (/^[A-Za-z0-9._-]+[.]json$/.test(wanted)) {
          const existing = readStateRecord(internalStatePath('.7coder/sessions', wanted), parseSessionState);
          // Continuing a CLI/legacy archive in the UI creates a Web record;
          // it must not transfer or overwrite an archive owned by another path.
          if (existing && existing.value.kind === '7coder-web-session-v1') name = wanted;
        }
        const stored = JSON.stringify({ kind: '7coder-web-session-v1', savedAt: new Date().toISOString(), messages: clean, activities });
        if (Buffer.byteLength(stored, 'utf8') > SESSION_MAX_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Session exceeds 2 MiB UTF-8; previous saved state was not overwritten.' } })); return;
        }
        writeStateFile(internalStatePath('.7coder/sessions', name), stored, parseSessionState);
        audit({ ts: new Date().toISOString(), type: 'session_save', file: name, turns: clean.length });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: name, turns: clean.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  }
  function hOpen(req, res) {
    readJsonBody(req, res, BODY_LIMIT_DEFAULT, async body => {
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
          openPath = configPathForOpen();
        }
        const result = await launchDesktopPath(openPath, target);
        audit({ ts: new Date().toISOString(), type: 'open', status: result.status, target, path: openPath, pid: result.pid, exitCode: result.exitCode, signal: result.signal, error: result.error });
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(result.status === 'accepted' ? 200 : result.status === 'busy' ? 429 : result.status === 'unknown' ? 504 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Object.assign({ ok: result.status === 'accepted', target, path: openPath }, result)));
      } catch (e) {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: runtimeText(e.message), code: runtimeText(e.code, 40) } }));
      }
    });
  }
  function hSettingsGet(req, res) {
    const profiles = {};
    for (const k of Object.keys(modelProfiles)) {
      const p = modelProfiles[k] || {};
      profiles[k] = { endpoint: p.endpoint || '', apiKey: (typeof p.apiKey === 'string') ? p.apiKey : '' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ endpoint: OPENAI_ENDPOINT, apiKey: OPENAI_API_KEY || '', model: HEAVY_MODEL, profiles }));
  }
  function hSettingsPost(req, res) {
    readJsonBody(req, res, BODY_LIMIT_DEFAULT, body => {
      try {
        const j = JSON.parse(body);
        const updates = {};
        // AST-08: values land in .env as KEY=value lines, so CR/LF/NUL would
        // inject attacker-controlled env vars. Validate before touching anything.
        let newEndpoint = null, newKey = null, newModel = null;
        if (typeof j.endpoint === 'string') {
          if (/[\r\n\u0000]/.test(j.endpoint)) throw new Error('endpoint must not contain CR, LF or NUL characters');
          const ep = j.endpoint.trim();
          if (ep && !/^https?:\/\//i.test(ep)) throw new Error('endpoint must start with http:// or https://');
          newEndpoint = ep || 'https://api.openai.com/v1'; // empty string resets to the default
          updates.OPENAI_ENDPOINT = newEndpoint;
        }
        if (typeof j.apiKey === 'string') {
          if (/[\r\n\u0000]/.test(j.apiKey)) throw new Error('apiKey must not contain CR, LF or NUL characters');
          newKey = j.apiKey;
          updates.OPENAI_API_KEY = newKey;
        }
        if (typeof j.model === 'string' && j.model.trim()) {
          if (/[\r\n\u0000]/.test(j.model)) throw new Error('model must not contain CR, LF or NUL characters');
          newModel = j.model.trim();
          updates.HEAVY_MODEL = newModel;
        }
        // AST-08: persist BEFORE mutating the runtime globals - a failed disk
        // write must leave the running configuration unchanged (500, no update).
        if (Object.keys(updates).length) {
          try {
            writeWorkspaceEnv(updates);
          } catch (e2) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'failed to persist settings: ' + e2.message } }));
            return;
          }
        }
        if (newEndpoint !== null) { OPENAI_ENDPOINT = newEndpoint; process.env.OPENAI_ENDPOINT = OPENAI_ENDPOINT; }
        if (newKey !== null) { OPENAI_API_KEY = newKey; process.env.OPENAI_API_KEY = OPENAI_API_KEY; }
        if (newModel !== null) { HEAVY_MODEL = newModel; process.env.HEAVY_MODEL = HEAVY_MODEL; }
        audit({ ts: new Date().toISOString(), type: 'settings', keys: Object.keys(updates) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, endpoint: OPENAI_ENDPOINT, model: HEAVY_MODEL, models: modelList() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  }
  function hModelsConfigGet(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ profiles: modelProfiles }));
  }
  function hModelsConfigPost(req, res) {
    readJsonBody(req, res, BODY_LIMIT_DEFAULT, body => {
      try {
        const j = JSON.parse(body);
        const profiles = j.profiles;
        if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new Error('profiles must be an object');
        for (const k of Object.keys(profiles)) {
          const p = profiles[k];
          if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('profile "' + k + '" must be an object');
          if (p.endpoint !== undefined && typeof p.endpoint !== 'string') throw new Error('profile "' + k + '" endpoint must be a string');
          if (p.apiKey !== undefined && typeof p.apiKey !== 'string') throw new Error('profile "' + k + '" apiKey must be a string');
        }
        const wsCfgDir = internalStatePath('.7coder');
        if (!fs.existsSync(wsCfgDir)) fs.mkdirSync(wsCfgDir, { recursive: true });
        writeStateFile(internalStatePath('.7coder', 'models.json'), JSON.stringify(profiles, null, 2), parseModelState);
        loadModelProfiles();
        audit({ ts: new Date().toISOString(), type: 'models-config', models: Object.keys(profiles) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, models: modelList() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  }
  function hMode(req, res) {
    readJsonBody(req, res, BODY_LIMIT_DEFAULT, body => {
      try {
        const wanted = (JSON.parse(body).mode || '').toLowerCase().trim();
        if (!VALID_PERMISSION_MODES.includes(wanted)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid mode. Valid: ' + VALID_PERMISSION_MODES.join(', ') } }));
          return;
        }
        const prev = PERMISSION_MODE;
        PERMISSION_MODE = wanted;
        if (prev !== wanted) {
          effectivePermissionMode.revision = (effectivePermissionMode.revision || 0) + 1;
          for (const finish of Array.from(pendingApprovals.values())) finish(false);
        }
        console.log('[PERM] permission mode changed: ' + prev + ' -> ' + wanted);
        audit({ ts: new Date().toISOString(), type: 'mode', from: prev, to: wanted });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: effectivePermissionMode(), configuredMode: PERMISSION_MODE,
          dangerMode: DANGER_MODE, modeForced: DANGER_MODE && PERMISSION_MODE !== 'denial', permissionRevision: effectivePermissionMode.revision || 0, permissionSession: PERMISSION_SESSION }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  }
  function hChat(req, res) {
    const reservation = reserveChatRequest();
    if (!reservation) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: { message: 'Chat request capacity is busy; retry after an existing request finishes.' } }));
      req.resume(); return;
    }
    const execution = createExecutionControl();
    let cleaned = false, bodyReceived = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true; execution.dispose(); reservation.release();
      res.removeListener('close', onDisconnect);
    };
    const onDisconnect = () => {
      if (!res.writableEnded) {
        execution.cancel('Client disconnected.');
        if (!bodyReceived) cleanup();
      }
    };
    res.once('close', onDisconnect);
    readJsonBody(req, res, 10 * 1024 * 1024, async body => {
        bodyReceived = true;
        let wantsStream = false;
        let finishRuntime = null;
        try {
        const data = JSON.parse(body);
        const reqModel = (typeof data.model === 'string' && data.model.trim()) ? data.model.trim().substring(0, 200) : HEAVY_MODEL;
        const modelContext = createModelContext(reqModel);
        wantsStream = data.stream === true;
        const tempMessages = conversationFromClient(data.messages);
        const promptContent = tempMessages.length > 1 && tempMessages[tempMessages.length - 1].role === 'user'
          ? tempMessages[tempMessages.length - 1].content
          : '';
        const rawPrompt = Array.isArray(promptContent)
          ? promptContent.filter(part => part && part.type === 'text').map(part => String(part.text || '')).join('\n')
          : String(promptContent || '');

        console.log('[WEB] HTTP request received from UI');
        preemptServerDream();
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
            res.on('close', () => { if (!res.writableEnded) clientGone = true; });
            const writeChunk = (delta, finishReason) => {
              if (clientGone || res.destroyed) return;
              try {
                res.write('data: ' + JSON.stringify({
                  id: responseId, object: 'chat.completion.chunk', created, model: reqModel,
                  choices: [{ index: 0, delta, finish_reason: finishReason || null }]
                }) + '\n\n');
              } catch (e) {
                clientGone = true;
                execution.cancel('Client write failed.');
              }
            };
            // Per-request approval bridge (P0-3): local to THIS streaming
            // response, threaded into processWithTools -> askApproval.
            // Concurrent clients each get their own bridge, so one finishing
            // or disconnecting can never detach another's approvals. Ids
            // carry a random per-request prefix so /api/approve cannot be
            // answered cross-connection by id guessing.
            const approvalBridge = createHttpApprovalBridge(res, execution);
            const ka = setInterval(() => {
              if (clientGone || res.destroyed) { clearInterval(ka); return; }
              try { res.write(': keep-alive\n\n'); } catch (e) { clientGone = true; execution.cancel('Client write failed.'); clearInterval(ka); }
            }, 5000);
            let releaseGate = null;
            // AST-09: keep-alive timer, pending approvals and the gate are ALL
            // cleaned in one finally - an exception mid-stream used to leak the
            // interval (keep-alive writes on a dead response) and the approvals.
            try {
              releaseGate = await requestGate(execution); // AST-03: permission globals remain serialized
              finishRuntime = beginRuntimeOperation('http-task');
              if (clientGone) return;
              checkExecution(execution);
              createTaskGitCheckpoint();
              const result = await processWithTools(tempMessages, {
                onDelta: t => writeChunk({ content: t }, null), cancel: execution, modelContext,
                onReasoning: t => writeChunk({ reasoning: t }, null),
                onToolCall: (name, args, callId) => writeChunk({ tool_call: { callId: toolCallIdentity(callId), name: name, args: sanitizeAuditArgs(args) } }, null),
                onToolResult: (name, args, output, callId) => {
                  const resultText = sanitizeAuditLine(toolResultText(output)).substring(0, 12000);
                  const resultStatus = toolResultStatus(output);
                  const status = resultStatus === 'ok' ? 'completed' : resultStatus;
                  writeChunk({ tool_result: { callId: toolCallIdentity(callId), name: name, args: sanitizeAuditArgs(args), result: resultText, status: status } }, null);
                },
                approvalBridge: approvalBridge
              });
              // Give the socket-close event a moment to land when the client
              // aborted at the very end of the run - then skip the summary.
              await new Promise(r => setTimeout(r, clientGone ? 0 : 150));
              if (clientGone) return; // aborted: skip summary, 7CODER.md untouched
              checkExecution(execution);
              updateLastInteractionTime();
              writeChunk({}, 'stop');
              res.write('data: [DONE]\n\n');
              res.end();
              finishRuntime('ok');
              actionSummaryQueue.enqueue({ id: responseId, rawPrompt, result, modelContext, deadlineAt: execution.deadlineAt });
            } finally {
              clearInterval(ka);
              approvalBridge.dispose();
              if (releaseGate) releaseGate();
            }
            return;
          }

          const releaseGate = await requestGate(execution); // AST-03
          finishRuntime = beginRuntimeOperation('http-task');
          let result;
          try {
            checkExecution(execution);
            createTaskGitCheckpoint();
            result = await processWithTools(tempMessages, { modelContext, cancel: execution });
            checkExecution(execution);
            updateLastInteractionTime();
          } finally {
            releaseGate();
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: responseId,
            object: 'chat.completion',
            created,
            model: reqModel,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: result },
              finish_reason: 'stop'
            }]
          }));
          finishRuntime('ok');
          actionSummaryQueue.enqueue({ id: responseId, rawPrompt, result, modelContext, deadlineAt: execution.deadlineAt });
        } catch (e) {
          if (finishRuntime) finishRuntime(execution() ? 'cancelled' : 'error', e);
          else recordRuntimeEvent('http-request', execution() ? 'cancelled' : 'error', e);
          console.error('HTTP error:', e);
          if (res.destroyed || res.writableEnded) return;
          if (wantsStream && res.headersSent) {
            try {
              res.write('data: ' + JSON.stringify({ error: { message: e.message } }) + '\n\n');
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (e2) {}
          } else {
            res.writeHead(e.code === 'EXECUTION_CANCELLED' ? 408 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message } }));
          }
        } finally {
          if (finishRuntime) finishRuntime('cancelled', { message: 'Client disconnected before task completion.' });
          cleanup();
        }
      }, { cancelled: execution, addBytes: n => reservation.addBytes(n), readTimeoutMs: 30000, onFailure: cleanup });
  }

  const ROUTES = [
    { method: 'GET', url: '/', auth: false, handler: hUi },
    { method: 'GET', url: '/ui', auth: false, handler: hUi },
    { method: 'GET', url: '/api/info', auth: true, handler: hInfo },
    { method: 'GET', url: '/api/todos', auth: true, handler: hTodos },
    { method: 'GET', url: '/v1/models', auth: true, handler: hModels },
    { method: 'GET', url: '/api/sessions', auth: true, handler: hSessionsList },
    { method: 'POST', url: '/api/sessions/load', auth: true, handler: hSessionLoad },
    { method: 'POST', url: '/api/sessions/delete', auth: true, handler: hSessionDelete },
    { method: 'POST', url: '/api/approve', auth: true, handler: hApprove },
    { method: 'POST', url: '/api/sessions/save', auth: true, handler: hSessionSave },
    { method: 'POST', url: '/api/open', auth: true, handler: hOpen },
    { method: 'GET', url: '/api/settings', auth: true, handler: hSettingsGet },
    { method: 'POST', url: '/api/settings', auth: true, handler: hSettingsPost },
    { method: 'GET', url: '/api/models-config', auth: true, handler: hModelsConfigGet },
    { method: 'POST', url: '/api/models-config', auth: true, handler: hModelsConfigPost },
    { method: 'POST', url: '/api/mode', auth: true, handler: hMode },
    { method: 'POST', url: '/v1/chat/completions', auth: true, handler: hChat },
  ];

  const server = http.createServer((req, res) => {
    // OP5-3: table-driven dispatch. The handler bodies are the verbatim
    // former if-chain arms; auth is enforced here in ONE place for every
    // auth:true route, so a new route cannot silently miss the 401 gate
    // (OP2-4 caught three that had).
    const route = ROUTES.find(r => r.method === req.method && r.url === req.url);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
      return;
    }
    if (route.auth && !hasAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
      return;
    }
    route.handler(req, res);
  });

  // P2-6: fail loudly and exit nonzero when the port is taken (or the server
  // otherwise errors) instead of dying with Node's raw stack trace.
  return new Promise((resolve, reject) => {
  let listening = false;
  server.on('error', e => {
    recordRuntimeEvent('http-server', 'error', e);
    if (e && e.code === 'EADDRINUSE') {
      console.error(`[ERROR] HTTP port ${HTTP_PORT} is already in use - change HTTP_PORT in .env or stop the process holding that port, then retry.`);
    } else {
      console.error(`[ERROR] HTTP server error: ${e && e.message ? e.message : e}`);
    }
    if (listening) flushExit(1);
    else reject(e);
  });
  server.listen(HTTP_PORT, HTTP_BIND, () => {
    listening = true;
    recordRuntimeEvent('http-ready', 'ok');
    console.log(`7coder HTTP OpenAI-compatible endpoint ready at http://${HTTP_BIND}:${HTTP_PORT}`);
    if (HTTP_API_KEY) console.log('[AUTH] API key required (Authorization: Bearer <HTTP_API_KEY>).');
    if (webuiHtml) console.log('Built-in web UI: open http://127.0.0.1:' + HTTP_PORT + '/ in your browser (Chinese-friendly chat).');
    else console.warn('[UI] API is ready; built-in page is unavailable. Inspect /api/info.ui and repair the installation before opening the UI.');
    console.log('Streaming (stream: true) and multi-turn client histories are supported.');
    console.log('Note: in default permission mode non-interactive approvals are declined - use PERMISSION_MODE=auto for server-driven tool use.');
    resolve(server);
  });
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
const cliQuestions = createCliQuestionQueue(question => { rl.setPrompt(question); rl.prompt(); });
let replLineHandler = null;
rl.on('close', () => { rlClosed = true; cliQuestions.close(); });
rl.on('line', input => {
  // /bye remains available while an approval is pending.
  if (!(replLineHandler && input.trim().toLowerCase() === '/bye') && cliQuestions.answer(input)) {
    if (!cliQuestions.hasPending()) rl.setPrompt('You: ');
    return;
  }
  if (replLineHandler) Promise.resolve(replLineHandler(input)).catch(e => console.error(`[REPL] ${e.stack || e.message}`));
});

// ====================== GLOBAL MESSAGES ======================
let messages = [{ role: 'system', content: systemPrompt }];

// ====================== MAIN ======================
async function main() {
  migrateWorkspaceRootFiles(); // P2-1: legacy root files -> .7coder/ (one-time)
  if (leaseHandoff && process.connected) {
    // Parent reports acceptance only after this child owns the workspace and
    // synchronous config/setup succeeded. This is not task completion.
    await new Promise((resolve, reject) => process.send({ kind: '7coder-background-owned',
      handoffToken: leaseHandoff.token, owner: workspaceLease.identity }, e => e ? reject(e) : resolve()));
    process.disconnect();
  }
  if (backgroundMode && promptArg) {
    console.log('[LOOP] Starting background/daemon mode...');
    // The launcher owns all writes until the explicit handoff. It performs no
    // workspace IO after release; the child must acquire the same OS lease.
    const logDir = internalStatePath('.7coder');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = internalStatePath('.7coder', 'background.log');
    const logFd = fs.openSync(logPath, 'a');
    let child;
    try {
      fs.writeSync(logFd, '\n[' + new Date().toISOString() + '] background run: ' + process.argv.slice(1).join(' ') + '\n');
      child = child_process.spawn(process.execPath, process.argv.slice(1).filter(a => a !== '--background'), {
        detached: true, stdio: ['ignore', logFd, logFd, 'ipc'], cwd: launchDir,
        env: Object.assign({}, process.env, { _7CODER_LEASE_HANDOFF: JSON.stringify({ token: workspaceLease.identity.token, pid: process.pid }) })
      });
    } finally { fs.closeSync(logFd); }
    let timer;
    const ready = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Background child did not acknowledge workspace ownership within 15s; inspect ' + logPath)), 15000);
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Background child exited before ownership acknowledgement (exit ' + code + '); inspect ' + logPath)));
      child.on('message', j => {
        if (j && j.kind === '7coder-background-owned' && j.handoffToken === workspaceLease.identity.token && j.owner &&
            j.owner.pid === child.pid && j.owner.key === workspaceLease.address.key && /^[a-f0-9]{48}$/.test(j.owner.token)) resolve();
      });
    });
    ready.catch(() => {}); // release can await while an early spawn error arrives
    try {
      if (!child.pid) throw new Error('Background child could not be spawned; inspect ' + logPath);
      rl.close();
      await workspaceLease.releaseForHandoff();
      await ready;
    } catch (e) {
      try { child.kill(); } catch (e2) {}
      throw e;
    } finally { clearTimeout(timer); }
    if (child.connected) child.disconnect();
    child.unref();
    console.log('[OK] Background worker accepted (PID ' + child.pid + ', workspace owned; task outcome is in log). Output: ' + logPath);
    flushExit(0);
    return;
  }

  if (ENABLE_HTTP_SERVER) {
    console.log('\n7coder HTTP server mode');
    const modelContext = createModelContext();
    const releaseStartup = promptArg ? await requestGate() : null;
    serverStartupState.phase = promptArg ? 'startup-task' : 'starting';
    rl.close();
    try {
      await startHttpServer();
      if (promptArg) {
        console.log(`Running startup task first: ${promptArg}`);
        currentRawPrompt = promptArg;
        messages = prepareMessagesForPrompt(currentRawPrompt);
        const completed = await executeTask(modelContext);
        serverStartupState.phase = completed ? 'completed' : 'failed';
        if (!completed) serverStartupState.error = 'Explicit startup task failed; inspect server log.';
      }
    } finally {
      if (releaseStartup) releaseStartup();
    }
    // Optional maintenance starts only after a successful bind. It owns the
    // same execution gate as chats and yields on valid foreground demand.
    if (!promptArg) runServerDream(modelContext).catch(error => console.warn('[STARTUP] ' + error.message));
    return;
  }

  if (promptArg) {
    console.log(`\n7coder non-interactive mode`);
    const modelContext = createModelContext();
    await triggerDreamIfNeeded(modelContext);
    console.log(`Task: ${promptArg}`);
    currentRawPrompt = promptArg;
    messages = prepareMessagesForPrompt(currentRawPrompt);
    await executeTask(modelContext);
    flushExit(0);
  } else {
    console.log('\nWelcome to 7coder (interactive REPL)');
    if (ENABLE_RALPH_MODE) console.log('Ralph Wiggum mode ENABLED');
    if (DANGER_MODE) console.log('[WARN] DANGER MODE ENABLED');
    console.log('Type your task (multi-line OK), /btw <note> for background notes, then /execute-task-now to run.');
    if (resumeFlag && loadSession()) console.log('[OK] Previous session resumed (' + (messages.length - 1) + ' turns). Use /clear to start fresh.');
    console.log('The conversation is KEPT across tasks (compressed automatically when large).');
    console.log('Commands: /clear (fresh conversation), /undo <file> (restore newest backup), /fork <N> (rewind to user turn N), /bye (quit).\n');

    // Each execution takes ownership of one draft before its first await.
    // Later input (including BTW) belongs to the next draft, even while the
    // previous draft is still waiting for its own note summaries.
    const newDraft = () => ({ text: '', textBytes: 0, reservedBytes: 0, pending: Promise.resolve(), modelContext: createModelContext(), discarded: false, notes: new Set() });
    // Count all unsettled notes, including executing/discarded drafts. A /clear
    // must not reset admission while its cancelled requests are still settling.
    const pendingReplNotes = new Set();
    let currentDraft = newDraft();
    let taskRunning = false;
    // After stdin EOF the readline interface is closed; calling prompt() on it
    // throws ERR_USE_AFTER_CLOSE on modern Node and would crash the process
    // with exit code 1 right after the task finished. Guard every re-prompt.
    // (rlClosed is tracked at module level next to the rl definition.)
    const safePrompt = () => { if (!rlClosed && !cliQuestions.hasPending()) { try { rl.setPrompt('You: '); rl.prompt(); } catch (e) {} } };

    safePrompt();

    replLineHandler = async (input) => {
      if (shuttingDown) return;
      const trimmed = input.trim();

      if (trimmed.toLowerCase() === '/bye') {
        // Quit for real: stop running background tasks, cron jobs and any
        // in-flight cron command, release only our dream lock, then exit. Their
        // handles would otherwise keep the event loop alive (hang) or leak.
        shuttingDown = true;
        cancelActiveExecutions('Agent exiting.');
        cliQuestions.close();
        const stopping = [];
        for (const t of backgroundTasks.values()) {
          if (t.child) stopping.push(stopBackgroundTask(t));
        }
        for (const j of cronJobs.values()) stopping.push(stopCronJob(j));
        disposeMcpClients(); // GAP-1: stop stdio MCP server children too
        disposePersistentShells(); // GAP-2: stop persistent bash sessions
        const stopped = await Promise.all(stopping);
        const unknown = stopped.filter(result => !result.closed);
        if (unknown.length) console.warn('[EXIT] ' + unknown.length + ' direct child close(s) unconfirmed; check remaining processes before restart.');
        // Cancellation normally runs Dream's finally first. If still pending,
        // remove only the exact active owner bytes; preserve foreign/legacy
        // evidence for its owner or the normal startup recovery policy.
        releaseOwnedDreamLock();
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
        try { const safeSession = sessionFilePath(); if (fs.existsSync(safeSession)) fs.unlinkSync(safeSession); } catch (e) {}
        currentDraft.discarded = true;
        for (const token of currentDraft.notes) token.cancel('Draft cleared.');
        currentDraft = newDraft();
        disposePersistentShells(); // A2-14: a fresh conversation must not inherit the old bash env/cwd
        console.log('[SHELL] persistent shell sessions cleared with /clear');
        console.log('[OK] Conversation cleared.');
        safePrompt();
        return;
      }

      if (trimmed.startsWith('/undo')) {
        if (taskRunning) { console.log('A task is running - wait before /undo.'); safePrompt(); return; }
        const rel = trimmed.slice(5).trim();
        if (!rel) {
          console.log('Usage: /undo <file path>');
        } else {
          // Detailed restore outcome: never collapse read failures, damaged
          // snapshots, conflicts or unknown states into "No backup found".
          // The protocol itself never throws, but a guard here keeps the
          // prompt alive even if an internal regression escapes (recheck R6).
          let outcome;
          try {
            outcome = restoreLatestBackupDetailed(rel);
          } catch (e) {
            outcome = { status: 'failed', stage: 'internal', message: e.message };
          }
          if (outcome.status === 'restored') {
            console.log(`[OK] Restored ${rel} from the newest backup (${outcome.format}${outcome.sequence ? ', sequence ' + outcome.sequence : ''}).`);
            for (const warning of outcome.warnings || []) console.log(`[UNDO WARNING] ${warning}`);
          } else if (outcome.status === 'not-found') {
            console.log(`No backup found for ${rel}.`);
          } else {
            console.log(`[UNDO ${outcome.status.toUpperCase()}] at ${outcome.stage || 'unknown stage'}: ${outcome.message || 'no details'}${outcome.residue ? ' ; ' + outcome.residue : ''}`);
            console.log('The current file was NOT modified. Inspect .7coder/backups before retrying.');
          }
        }
        safePrompt();
        return;
      }

      if (trimmed.startsWith('/btw ')) {
        const note = trimmed.slice(5).trim();
        if (note) {
          const draft = currentDraft;
          let reservation;
          try {
            if (pendingReplNotes.size >= 32) throw new Error('32 BTW notes are still pending; wait for completion before adding another note.');
            reservation = reserveReplNote(draft, note);
          } catch (e) { console.error('[BTW] Note not queued: ' + e.message); safePrompt(); return; }
          console.log(`[BTW] /btw note received - small-model sub-agent summarizing for main task...`);
          const noteExecution = createExecutionControl();
          noteExecution.draftReservedBytes = reservation;
          draft.notes.add(noteExecution);
          pendingReplNotes.add(noteExecution);
          // Preserve every note, in input order, and attach it to this draft.
          const work = draft.pending.then(async () => {
            if (draft.discarded || shuttingDown) return;
            checkExecution(noteExecution);
            const btwPrompt = `You are 7coder's BTW sub-agent (light model only).
The user just appended this note to the CURRENT heavy-model coding task WITHOUT interrupting it:

"${note}"

Summarize EXACTLY what the user wants in 1-2 clear, concise sentences.
Output ONLY the summarized user message text (no extra explanation, no quotes, no prefixes).
Make it read like a direct continuation of the user's task instructions for the main agent.`;
            let summarized = note;
            try {
              const resp = await callOpenAI([{ role: 'user', content: btwPrompt }], { model: draft.modelContext.light, modelContext: draft.modelContext, cancel: noteExecution, useTools: false });
              summarized = (resp.message.content || note).trim() || note;
            } catch (e) {
              if (noteExecution()) { console.log('[BTW] Note cancelled: ' + noteExecution.reason); return; }
              console.log(`[BTW] BTW sub-agent error - injecting original note as fallback.`);
            }
            if (shuttingDown || draft.discarded) return;
            checkExecution(noteExecution);
            appendReplDraft(draft, '\n' + summarized + '\n', noteExecution);
            console.log(`[BTW] BTW sub-agent injected into queued task prompt:\n${summarized}`);
            // P2-1: BTW.md lives under .7coder/ now (dir created first - at
            // this point it may not exist yet, e.g. /btw then EOF, no task run).
            const btwDir = internalStatePath('.7coder');
            try { fs.mkdirSync(btwDir, { recursive: true }); } catch (e) {}
            const btwPath = path.join(btwDir, 'BTW.md');
            try {
              const record = readStateRecord(btwPath);
              writeStateFile(btwPath, (record ? record.value : '') + `\n---\n**BTW** ${new Date().toISOString()}\nOriginal note: ${note}\nInjected summary: ${summarized}\n\n`);
            } catch (e) { console.error(`[BTW] Cannot persist note to ${btwPath}: ${e.message}`); }
          }).finally(() => { releaseReplNote(draft, noteExecution); draft.notes.delete(noteExecution); pendingReplNotes.delete(noteExecution); noteExecution.dispose(); });
          // A failed note must neither reject the next note's chain nor leave
          // an unhandled rejection before /execute starts waiting for it.
          draft.pending = work.catch(e => console.error(`[BTW] Note not queued: ${e.message}`));
          await draft.pending;
        } else {
          console.log('Usage: /btw your note here');
        }
        safePrompt();
        return;
      }

      // GAP-14: /fork <N> rewinds the in-memory conversation to just after the
      // Nth user turn. N counts role==='user' messages (system is skipped); the
      // first round's buildTaskUserContent wrapping does not change the count.
      // Nothing is deleted from disk - /clear still does that - only the live
      // `messages` array is truncated, so later tasks continue from turn N.
      const forkMatch = /^\/fork\s+(\d+)$/.exec(trimmed);
      if (forkMatch) {
        if (taskRunning) { console.log('A task is running - wait before /fork.'); safePrompt(); return; }
        const n = parseInt(forkMatch[1], 10);
        const userIdx = [];
        for (let mi = 0; mi < messages.length; mi++) {
          if (messages[mi] && messages[mi].role === 'user') userIdx.push(mi);
        }
        if (n < 1 || n > userIdx.length) {
          console.log(`[FORK] 无效轮次 ${n}（当前共 ${userIdx.length} 个用户轮）`);
          safePrompt();
          return;
        }
        // A2-05: the turn boundary is the START of the (N+1)-th user message -
        // everything before it (the complete assistant(tool_calls) + tool
        // results + final assistant chain of turn N) stays, so pairing is
        // never split. The old "user + one adjacent assistant" cut orphaned
        // tool_calls when the turn began with a tool call.
        const cutIdx = (n < userIdx.length) ? userIdx[n] : messages.length;
        messages = messages.slice(0, cutIdx);
        console.log(`[FORK] 会话已回退到第 ${n} 轮（现共 ${messages.length} 条消息）；之后的对话从这里继续。`);
        safePrompt();
        return;
      }

      if (trimmed === '/execute-task-now') {
        if (taskRunning) {
          console.log('A task is already running - queued lines are still appended to the next task.');
          safePrompt();
          return;
        }
        taskRunning = true;
        const draft = currentDraft;
        currentDraft = newDraft();
        try {
          await draft.pending;
          if (shuttingDown) return;
          const taskText = draft.text.trim();
          if (taskText) {
            try {
              await triggerDreamIfNeeded(draft.modelContext);
            } catch (e) {
              console.error(`[WARN] dream check failed (task continues): ${e.message}`);
            }
            if (shuttingDown) return;
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
            await executeTask(draft.modelContext);
            saveSession();
          } else {
            console.log('No task entered.');
          }
        } finally {
          taskRunning = false;
        }
      } else if (trimmed) {
        // GAP-7a: workspace slash commands. A line shaped "/name" with a
        // matching .7coder/commands/<name>.md (single workspace-level dir, name
        // pre-restricted to [a-z0-9_-] by the regex, so no traversal) expands
        // to the task text: the file body is queued exactly like typed user
        // input and /execute-task-now runs it. Unknown /x keeps the legacy
        // behavior of being queued as plain text. Existing files must be
        // complete lossless UTF-8 within 64KiB; never execute a truncated body.
        const slashCmd = /^\/([a-z0-9_-]+)$/.exec(trimmed);
        let expanded = null;
        if (slashCmd) {
          try { expanded = readWorkspaceCommand(slashCmd[1]); }
          catch (e) {
            console.error(`[CMD] ${slashCmd[1]} not queued: ${e.message}`);
            safePrompt();
            return;
          }
        }
        const queued = expanded || input;
        try { appendReplDraft(currentDraft, queued + '\n'); }
        catch (e) { console.error('[INPUT] ' + e.message); safePrompt(); return; }
        if (expanded) {
          console.log(`[CMD] ${slashCmd[1]} 展开为 ${expanded.length} 字符任务`);
          console.log(expanded); // echo the queued body (the typed-input equivalent)
        }
      }

      safePrompt();
    };
  }
}

await main();
}
initializeAgent().catch(e => {
  console.error('[ERROR] Agent startup/execution failed: ' + (e && e.message ? e.message : String(e)));
  flushExit(1);
});
