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
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const IDX = path.join(__dirname, '..', 'index.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const RUN_ONLY = (process.env.RUN_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);

function rmrf(p) { try { if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true }); else fs.rmdirSync(p, { recursive: true, force: true }); } catch (e) {} }

function create(opts) {
  opts = opts || {};
  const suite = opts.suite || '';         // '' -> 'SUMMARY:', 'B' -> 'SUITE B SUMMARY:'
  const wsPrefix = opts.wsPrefix || 'w-'; // freshCwd directory prefix, keeps suites from clashing
  const cliBaseEnv = opts.cliBaseEnv || {}; // extra base env for runCli (suite A pins MAX_RETRIES=1)
  const results = [];
  const ownArtifacts = []; // files this run created (cur-script-*, mock-log-*, ...)
  const ownWorkdirs = [];  // w-* workspaces this run created

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
    const child = spawn(NODE_BIN, [file], {
      env: Object.assign({}, process.env, { MOCK_SCRIPT: scriptPath, MOCK_PORT: String(portNum) }, extraEnv || {}),
      stdio: 'ignore'
    });
    const logPath = path.join(ROOT, 'mock-log-' + portNum + '.jsonl');
    ownArtifacts.push(scriptPath, logPath);
    return { child, port: portNum, log: logPath };
  }
  function stopMock(m) { try { m.child.kill(); } catch (e) {} }

  function freshCwd(name) {
    let dir = path.join(ROOT, wsPrefix + name);
    rmrf(dir, { recursive: true, force: true });
    for (let i = 0; i < 3 && fs.existsSync(dir); i++) { try { rmrf(dir, { recursive: true, force: true }); } catch (e) { require('child_process').execSync('ping -n 2 127.0.0.1 >nul', { stdio: 'ignore' }); } }
    if (fs.existsSync(dir)) dir = dir + '-' + Date.now(); // unique-suffix fallback (stale dir undeletable)
    fs.mkdirSync(dir, { recursive: true });
    ownWorkdirs.push(dir);
    return dir;
  }

  function runCli(o) {
    const { args, env, cwd, stdinSteps, timeoutMs } = o;
    return new Promise(resolve => {
      const p = spawn(NODE_BIN, [IDX].concat(args || []), {
        env: Object.assign({}, process.env, {
          OPENAI_API_KEY: 'x',
          OPENAI_ENDPOINT: 'http://127.0.0.1:' + o.port + '/v1'
        }, cliBaseEnv, env || {}),
        cwd: cwd || ROOT
      });
      let out = '';
      p.stdout.on('data', d => out += d.toString());
      p.stderr.on('data', d => out += d.toString());
      const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs || 90000);
      p.on('close', code => { clearTimeout(to); resolve({ code, out }); });
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
    try { for (const f of ownArtifacts) { try { fs.unlinkSync(f); } catch (e) {} } } catch (e) {}
    for (const d of ownWorkdirs) rmrf(d);
    const pass = results.filter(r => r.pass).length;
    if (RUN_ONLY.length && results.length === 0) { console.log('WARNING: RUN_ONLY matched 0 scenarios'); process.exit(1); }
    console.log('\n===== ' + (suite ? 'SUITE ' + suite + ' ' : '') + 'SUMMARY: ' + pass + '/' + results.length + ' passed in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
    for (const f of results.filter(r => !r.pass)) console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
    process.exit(pass === results.length ? 0 : 1);
  }

  function runAll(scenarios) {
    const t0 = Date.now();
    (async () => {
      for (const sc of scenarios) {
        if (RUN_ONLY.length && !RUN_ONLY.includes(sc.name)) continue;
        console.log('--- scenario: ' + sc.name + ' (' + NODE_BIN.substring(0, 40) + ')');
        try { await sc.fn(); } catch (e) { record(sc.name + ' (scenario crashed)', false, e.message); }
      }
      finish(t0);
    })();
  }

  return { ROOT, IDX, NODE_BIN, RUN_ONLY, results, record, startProcessAt, stopMock, freshCwd, runCli, httpReq, readLog, toolResults, tr, rmrf, finish, runAll };
}

module.exports = { create, rmrf, ROOT, IDX, NODE_BIN, RUN_ONLY };
