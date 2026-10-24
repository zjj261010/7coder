// test/_shared.js - shared harness for the offline suites (OPT-4).
// Single implementation of the helpers every runner used to duplicate:
// rmrf (the self-recursion bug once lived in 10 copies), record/readLog/
// toolResults, mock spawning, freshCwd, runCli, httpReq and the summary/
// exit block. Runners keep their own `let port` counter plus a thin
// startMock wrapper, so scenario bodies are untouched by the migration.
// Usage:
//   const S = require('./_shared').create({ suite: 'B', wsPrefix: 'w-b-', cliBaseEnv: {} });
//   const { IDX, NODE_BIN, RUN_ONLY, record, startProcessAt, freshCwd, runCli, httpReq, stopMock, readLog, toolResults, tr, rmrf } = S;
//   ... scenarios ...
//   S.runAll(scenarios);
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const ROOT = __dirname;
const IDX = path.join(__dirname, '..', 'index.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const RUN_ONLY = (process.env.RUN_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);

function delayCommand(ms) {
  return '"' + NODE_BIN + '" -e "setTimeout(function(){console.log(\'TASK-DELAY-DONE\')},' + ms + ')"';
}

// OP5-1: runners also run standalone (npm run test:b, RUN_ONLY=...), where a
// developer's local .env (PERMISSION_MODE=auto, ENABLE_AUTO_DEBUG=true,
// HEAVY_MODEL=...) used to leak into every spawned CLI/server process - the
// spawns build their env from `Object.assign({}, process.env, ...)` here.
// Same rules as scripts/test-all.js loadBaseline(): with REAL_TEST!==1 the
// .env.example values win key-by-key, with REAL_TEST===1 only undefined keys
// are filled; auto-debug is always forced off for the offline suites. Applied
// in place on process.env, so create() callers need no per-spawn changes and
// running under test-all (which baseline-ed the parent env already) is
// idempotent.
function applyBaselineEnv() {
  const example = path.join(__dirname, '..', '.env.example');
  if (fs.existsSync(example)) {
    for (const line of fs.readFileSync(example, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && (process.env.REAL_TEST !== '1' || process.env[m[1]] === undefined)) process.env[m[1]] = m[2];
    }
  }
  // Offline suites must not depend on a developer's auto-debug setting.
  process.env.ENABLE_AUTO_DEBUG = 'false';
  if (process.env.REAL_TEST !== '1') {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key];
  }
}

function rmrf(p) { try { if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true }); else fs.rmdirSync(p, { recursive: true, force: true }); } catch (e) {} }

function create(opts) {
  applyBaselineEnv(); // OP5-1: clean the inherited env before any spawn derives its env from process.env
  opts = opts || {};
  const suite = opts.suite || '';         // '' -> 'SUMMARY:', 'B' -> 'SUITE B SUMMARY:'
  const wsPrefix = opts.wsPrefix || 'w-'; // freshCwd directory prefix, keeps suites from clashing
  const cliBaseEnv = opts.cliBaseEnv || {}; // extra base env for runCli (suite A pins MAX_RETRIES=1)
  const results = [];
  const ownArtifacts = []; // files this run created (cur-script-*, mock-log-*, ...)
  const ownWorkdirs = [];  // w-* workspaces this run created
  // A private install avoids loading real .env/models/permissions. Workspaces
  // outside the source checkout cannot accidentally inherit its .git state.
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), '7coder-test-'));
  const app = path.join(runDir, 'app');
  fs.mkdirSync(app);
  for (const name of ['index.js', 'package.json', 'webui.html', '.env.example']) {
    fs.copyFileSync(path.join(ROOT, '..', name), path.join(app, name));
  }
  const IDX = path.join(app, 'index.js');
  const modules = path.resolve(ROOT, '..', 'node_modules');
  process.env.NODE_PATH = [modules].concat((process.env.NODE_PATH || '').split(path.delimiter).filter(p => p && p !== modules)).join(path.delimiter);
  const manifest = path.join(runDir, 'owned-processes.tsv');
  fs.writeFileSync(manifest, '# 7coder-test-run\t' + runDir + '\n');
  const ownedChildren = new Set();
  let skipped = 0;
  console.log('[TEST] isolated run: ' + runDir);
  function track(child, needle) {
    ownedChildren.add(child);
    if (child.pid) fs.appendFileSync(manifest, child.pid + '\t' + needle + '\n');
    const deadline = setTimeout(() => stopChild(child), 15 * 60 * 1000);
    deadline.unref();
    child.once('close', () => { clearTimeout(deadline); ownedChildren.delete(child); });
    return child;
  }
  function ownedSpawn(command, args, options) {
    const argv = (args || []).slice();
    let needle = IDX;
    if (argv.indexOf(IDX) < 0) {
      needle = '--7coder-test-owner=' + runDir;
      if (command !== NODE_BIN && command !== process.execPath) throw new Error('Use an explicit owned fixture for non-Node asynchronous children');
      argv.push('--', needle);
    }
    const child = spawn(command, argv, Object.assign({ cwd: runDir, env: process.env }, options || {}));
    child.on('error', e => console.error('[TEST child] ' + e.message));
    return track(child, needle);
  }
  function ownedSpawnSync(command, args, options) {
    return spawnSync(command, args, Object.assign({ cwd: runDir, env: process.env, timeout: 90000 }, options || {}));
  }
  function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32' && child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
      else child.kill();
    } catch (e) {}
  }
  function cleanup() {
    for (const child of ownedChildren) stopChild(child);
    for (const f of ownArtifacts) { try { fs.unlinkSync(f); } catch (e) {} }
    for (const d of ownWorkdirs) rmrf(d);
    // Keep the isolated install and manifest for interrupted-run diagnosis.
  }

  function record(name, pass, detail) {
    results.push({ name, pass, detail: detail || '' });
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  :: ' + String(detail).substring(0, 300)));
  }

  // Spawn a mock LLM endpoint on an already-incremented port number.
  // mockFile: basename relative to test/ ('mock-server.js', 'chaos-mock.js');
  // customFile: full path override (suite E's variant servers).
  function startProcessAt(portNum, mockFile, scriptObj, extraEnv, customFile) {
    const scriptPath = path.join(ROOT, 'cur-script-' + portNum + '.json');
    fs.writeFileSync(scriptPath, JSON.stringify(scriptObj || [{ role: 'assistant', content: 'MOCK-DEFAULT' }]));
    const file = customFile || path.join(ROOT, mockFile || 'mock-server.js');
    const owner = '--7coder-test-owner=' + runDir;
    const child = track(spawn(NODE_BIN, [file, owner], {
      env: Object.assign({}, process.env, { MOCK_SCRIPT: scriptPath, MOCK_PORT: String(portNum) }, extraEnv || {}),
      cwd: runDir,
      stdio: 'ignore'
    }), owner);
    const logPath = path.join(ROOT, 'mock-log-' + portNum + '.jsonl');
    ownArtifacts.push(scriptPath, logPath);
    return { child, port: portNum, log: logPath };
  }
  function stopMock(m) { if (m) stopChild(m.child); }

  function freshCwd(name) {
    let dir = path.join(runDir, wsPrefix + name);
    // Do not use a Windows-only ping as a sleep here. If a locked directory
    // survives cleanup, use a unique workspace instead of delaying the suite.
    if (fs.existsSync(dir)) dir = dir + '-' + Date.now();
    fs.mkdirSync(dir, { recursive: true });
    ownWorkdirs.push(dir);
    return dir;
  }

  function runCli(o) {
    const { args, env, cwd, stdinSteps, timeoutMs } = o;
    return new Promise(resolve => {
      const p = track(spawn(NODE_BIN, [IDX].concat(args || []), {
        env: Object.assign({}, process.env, {
          OPENAI_API_KEY: 'x',
          OPENAI_ENDPOINT: 'http://127.0.0.1:' + o.port + '/v1'
        }, cliBaseEnv, env || {}),
        cwd: cwd || freshCwd('default')
      }), IDX);
      let out = '';
      // elapsedMs/firstOutMs: suites C (bye-hang) and F (perf) assert on these;
      // extra resolve fields are ignored by the suites that don't.
      const t0 = Date.now();
      let firstOutMs = null;
      p.stdout.on('data', d => { if (firstOutMs === null) firstOutMs = Date.now() - t0; out += d.toString(); });
      p.stderr.on('data', d => out += d.toString());
      const to = setTimeout(() => stopChild(p), timeoutMs || 90000);
      p.on('error', e => { out += '\nSpawn error: ' + e.message; });
      p.stdin.on('error', () => {});
      p.on('close', code => { clearTimeout(to); resolve({ code, out, elapsedMs: Date.now() - t0, firstOutMs: firstOutMs || Date.now() - t0 }); });
      (async () => {
        if (stdinSteps) {
          for (const s of stdinSteps) {
            p.stdin.write(s.t);
            if (s.d) await new Promise(r => setTimeout(r, s.d));
          }
          p.stdin.end();
        } else {
          p.stdin.end();
        }
      })().catch(() => {});
    });
  }

  function httpReq(portNo, method, urlPath, bodyObj, headers, agent) {
    return new Promise((resolve, reject) => {
      const data = bodyObj === null ? null : (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj));
      const req = http.request({ host: '127.0.0.1', port: portNo, method: method, path: urlPath, agent: agent || undefined,
        headers: Object.assign({}, data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) },
        res => {
          res.setEncoding('utf8'); // preserve multibyte characters across response chunks
          let out = '';
          res.on('data', d => out += d.toString());
          res.on('end', () => resolve({ status: res.statusCode, body: out }));
        });
      req.on('error', reject);
      if (data !== null) req.write(data);
      req.end();
    });
  }

  function readLog(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  }
  function toolResults(log) {
    const out = [];
    for (const r of log) for (const m of (r.messages || [])) if (m.role === 'tool') out.push({ id: m.tool_call_id, c: String(m.content) });
    const seen = new Set(); const uniq = [];
    for (const t of out) if (!seen.has(t.id)) { seen.add(t.id); uniq.push(t); }
    return uniq;
  }
  function tr(log, id) { return toolResults(log).find(t => t.id === id); }

  // Self-cleanup (OPT-11) + summary + exit codes (DS-9: empty RUN_ONLY match exits 1).
  function finish(t0) {
    cleanup();
    const pass = results.filter(r => r.pass).length;
    if (RUN_ONLY.length && results.length === 0 && skipped === 0) { console.log('WARNING: RUN_ONLY matched 0 scenarios'); process.exit(1); }
    console.log('\n===== ' + (suite ? 'SUITE ' + suite + ' ' : '') + 'SUMMARY: ' + pass + '/' + results.length + ' passed; ' + skipped + ' scenarios skipped in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
    for (const f of results.filter(r => !r.pass)) console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
    process.exit(pass === results.length ? 0 : 1);
  }

  function runAll(scenarios) {
    const t0 = Date.now();
    (async () => {
      for (const sc of scenarios) {
        if (RUN_ONLY.length && !RUN_ONLY.includes(sc.name)) continue;
        if (sc.enabled && !sc.enabled()) {
          skipped++;
          console.log('SKIP  ' + sc.name + ' (requires DESKTOP_TEST=1; not counted as PASS)');
          continue;
        }
        console.log('--- scenario: ' + sc.name + ' (' + NODE_BIN.substring(0, 40) + ')');
        try { await sc.fn(); } catch (e) { record(sc.name + ' (scenario crashed)', false, e.message); }
      }
      finish(t0);
    })();
  }

  return { ROOT, IDX, NODE_BIN, RUN_ONLY, runDir, manifest, cleanup, spawn: ownedSpawn, spawnSync: ownedSpawnSync, delayCommand, results, record, startProcessAt, stopMock, freshCwd, runCli, httpReq, readLog, toolResults, tr, rmrf, finish, runAll };
}

module.exports = { create, rmrf, ROOT, IDX, NODE_BIN, RUN_ONLY };
