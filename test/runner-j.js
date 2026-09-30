// Suite J: cycle attacks (symlink loops), git worktree E2E, RALPH x
// compression, marker log across many tasks, EOF/btw race, MAX_TOOL_STEPS=0,
// duplicate JSON keys, overlapping edit matches, undo path normalization,
// mixed abort/concurrent HTTP.
// Usage: node test/runner-j.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
function rmrf(p) { try { if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true }); else fs.rmdirSync(p, { recursive: true, force: true }); } catch (e) {} }

const path = require('path');
const http = require('http');

const ROOT = __dirname;
const IDX = path.join(ROOT, '..', 'index.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const RUN_ONLY = (process.env.RUN_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
let port = 18650;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  :: ' + String(detail).substring(0, 300)));
}

function startMock(scriptObj) {
  port += 1;
  const scriptPath = path.join(ROOT, 'cur-script-' + port + '.json');
  fs.writeFileSync(scriptPath, JSON.stringify(scriptObj || [{ role: 'assistant', content: 'MOCK-DEFAULT' }]));
  const child = spawn(NODE_BIN, [path.join(ROOT, 'mock-server.js')], {
    env: Object.assign({}, process.env, { MOCK_SCRIPT: scriptPath, MOCK_PORT: String(port) }),
    stdio: 'ignore'
  });
  return { child, port, log: path.join(ROOT, 'mock-log-' + port + '.jsonl') };
}
function stopMock(m) { try { m.child.kill(); } catch (e) {} }

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

function freshCwd(name) {
  let dir = path.join(ROOT, 'w-j-' + name);
  rmrf(dir, { recursive: true, force: true });
  for (let i = 0; i < 3 && fs.existsSync(dir); i++) { try { rmrf(dir, { recursive: true, force: true }); } catch (e) { spawnSync('ping', ['-n', '2', '127.0.0.1'], { stdio: 'ignore' }); } }
    if (fs.existsSync(dir)) dir = dir + '-' + Date.now(); // unique-suffix fallback (stale dir undeletable)
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(opts) {
  const { args, env, cwd, stdinSteps, timeoutMs } = opts;
  return new Promise(resolve => {
    const p = spawn(NODE_BIN, [IDX].concat(args || []), {
      env: Object.assign({}, process.env, {
        OPENAI_API_KEY: 'x',
        OPENAI_ENDPOINT: 'http://127.0.0.1:' + opts.port + '/v1'
      }, env || {}),
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
      }
      p.stdin.end();
    })().catch(() => {});
  });
}

function httpReq(portNo, method, urlPath, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const data = bodyObj === null ? null : (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj));
    const req = http.request({ host: '127.0.0.1', port: portNo, method: method, path: urlPath,
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
function assembleSSE(body) {
  let out = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.substring(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { const c = JSON.parse(payload); if (c.choices && c.choices[0].delta && c.choices[0].delta.content) out += c.choices[0].delta.content; } catch (e) {}
  }
  return out;
}
function pairingValid(messages) {
  const roles = messages.map(x => x.role);
  for (let i = 0; i < roles.length; i++) {
    if (roles[i] === 'tool' && (i === 0 || (roles[i - 1] !== 'assistant' && roles[i - 1] !== 'tool'))) return false;
  }
  return true;
}

const scenarios = [];

// --- J1: symlink/junction cycles must not hang the walkers ---
scenarios.push({
  name: 'cycle',
  fn: async () => {
    const cwd = freshCwd('j1');
    fs.writeFileSync(path.join(cwd, 'target.txt'), 'CYCLE-TARGET');
    // self-referential junction: j -> cwd (points back into the tree it sits in)
    const mk1 = spawnSync('cmd', ['/c', 'mklink', '/J', path.join(cwd, 'jself'), cwd]);
    // junction to its own parent area: jp -> cwd itself is enough for a cycle
    if (mk1.status !== 0) { record('cycle: junction created (setup)', false, mk1.stderr.toString()); return; }
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'glob_tool', arguments: '{"pattern":"*.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'grep_tool', arguments: '{"pattern":"CYCLE-TARGET"}' } }] },
      { role: 'assistant', content: 'CYCLE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const t0 = Date.now();
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 45000 });
    const elapsed = Date.now() - t0;
    record('cycle: glob terminates on junction cycle (no hang/crash)', r.out.includes('CYCLE-DONE') && r.code === 0 && elapsed < 30000, 'elapsed=' + Math.round(elapsed / 1000) + 's exit=' + r.code);
    const res1 = tr(readLog(m.log), 'c1');
    const res2 = tr(readLog(m.log), 'c2');
    record('cycle: glob result is a bounded string (visited-set or error)', typeof (res1 ? res1.c : '') === 'string' && res1.c.length < 200000, 'len=' + (res1 ? res1.c.length : 'none'));
    record('cycle: grep terminates and finds the target exactly once-ish', res2 && res2.c.includes('CYCLE-TARGET') && res2.c.length < 200000, 'len=' + (res2 ? res2.c.length : 'none'));
    stopMock(m);
    try { rmrf(path.join(cwd, 'jself'), { recursive: true, force: true }); } catch (e) {}
  }
});

// --- J2: git worktree E2E (isolation both ways) ---
scenarios.push({
  name: 'worktree-e2e',
  fn: async () => {
    const cwd = freshCwd('j2');
    spawnSync('git', ['init'], { cwd });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd });
    spawnSync('git', ['config', 'user.name', 't'], { cwd });
    fs.writeFileSync(path.join(cwd, 'app.txt'), 'main-version\n');
    spawnSync('git', ['add', '.'], { cwd });
    spawnSync('git', ['commit', '-m', 'i'], { cwd });
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'enter_worktree_tool', arguments: '{"path":"wt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'w2', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'wt/app.txt', old_string: 'main-version', new_string: 'wt-version' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'w3', type: 'function', function: { name: 'run_command', arguments: '{"command":"git -C wt diff --stat"}' } }] },
      { role: 'assistant', content: 'WT-E2E-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const log = readLog(m.log);
    record('wt-e2e: worktree copy edited, main checkout untouched',
      fs.readFileSync(path.join(cwd, 'wt', 'app.txt'), 'utf8').includes('wt-version') &&
      fs.readFileSync(path.join(cwd, 'app.txt'), 'utf8').includes('main-version'), '');
    const diff = tr(log, 'w3');
    record('wt-e2e: git -C wt sees the worktree change', diff && diff.c.includes('app.txt') && diff.c.includes('+'), diff ? diff.c.substring(0, 80) : 'no result');
    spawnSync('git', ['worktree', 'prune'], { cwd });
    stopMock(m);
  }
});

// --- J3: RALPH loop x compression (long iterations with big replies) ---
scenarios.push({
  name: 'ralph-compress',
  fn: async () => {
    const cwd = freshCwd('j3');
    const big = 'RALPHPAYLOAD-'.repeat(120); // ~1.5k per reply
    const m = startMock([
      { role: 'assistant', content: big + ' R1' },
      { role: 'assistant', content: big + ' R2' },
      { role: 'assistant', content: 'RALPH_WIGGUM_COMPLETE R3 done' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', ENABLE_RALPH_MODE: 'true', RALPH_ITERATIONS: '3', CONTEXT_CHARS: '2500' }, cwd, timeoutMs: 60000
    });
    const log = readLog(m.log);
    let pairing = true;
    for (const req of log) if (!pairingValid(req.messages || [])) pairing = false;
    record('ralph-compress: loop completes to R3', r.out.includes('R3 done') && r.out.includes('Completion promise fulfilled'), r.out.substring(0, 150));
    record('ralph-compress: compression fired during the loop', log.some(x => (x.messages || []).some(mm => String(mm.content || '').includes('[CONTEXT COMPRESSION]'))), '');
    record('ralph-compress: pairing valid under ralph+compression', pairing, '');
    stopMock(m);
  }
});

// --- J4: marker log over five tasks ---
scenarios.push({
  name: 'marker-five',
  fn: async () => {
    const cwd = freshCwd('j4');
    const script = [];
    for (let i = 1; i <= 5; i++) {
      script.push({ role: 'assistant', content: 'M' + i + '-REPLY' });
      script.push({ role: 'assistant', content: 'summary ' + i });
    }
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const steps = [];
    for (let i = 1; i <= 5; i++) { steps.push({ t: 'task ' + i + '\n', d: 60 }); steps.push({ t: '/execute-task-now\n', d: 1200 }); }
    steps.push({ t: '/bye\n', d: 400 });
    await runCli({ port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, stdinSteps: steps, timeoutMs: 60000 });
    const md = fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8');
    const starts = (md.match(/auto-log:start/g) || []).length;
    const ends = (md.match(/auto-log:end/g) || []).length;
    const bullets = (md.match(/^- /gm) || []).length;
    record('markers-five: exactly one section, five bullets', starts === 1 && ends === 1 && bullets === 5, 'starts=' + starts + ' bullets=' + bullets);
    stopMock(m);
  }
});

// --- J5: EOF while a /btw light call is in flight ---
scenarios.push({
  name: 'btw-eof',
  fn: async () => {
    const cwd = freshCwd('j5');
    const m = startMock([
      { role: 'assistant', content: 'BTW-SUMMARY' },
      { role: 'assistant', content: 'BTW-NEVER' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 20000,
      stdinSteps: [{ t: '/btw note before quit\n', d: 1200 }]  // stdin ends while/before the light call resolves
    });
    const btw = path.join(cwd, 'BTW.md');
    record('btw-eof: EOF after /btw exits cleanly with BTW.md written', r.code === 0 && fs.existsSync(btw) && fs.readFileSync(btw, 'utf8').includes('note before quit'), 'exit=' + r.code);
    stopMock(m);
  }
});

// --- J6: MAX_TOOL_STEPS=0 -> graceful tool-free answer ---
scenarios.push({
  name: 'steps-zero',
  fn: async () => {
    const cwd = freshCwd('j6');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'z1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.txt"}' } }] },
      { role: 'assistant', content: 'ZERO-STEPS-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', MAX_TOOL_STEPS: '0' }, cwd });
    record('steps-zero: MAX_TOOL_STEPS=0 degrades to tool-free answer, no crash', r.code === 0 && (r.out.includes('ZERO-STEPS-DONE') || r.out.includes('step limit')), r.out.substring(0, 120));
    stopMock(m);
  }
});

// --- J7: duplicate JSON keys in tool args ---
scenarios.push({
  name: 'dup-keys',
  fn: async () => {
    const cwd = freshCwd('j7');
    fs.writeFileSync(path.join(cwd, 'real.txt'), 'REAL');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'dk1', type: 'function', function: { name: 'read_file', arguments: '{"path":"real.txt","path":"decoy.txt"}' } }] },
      { role: 'assistant', content: 'DUP-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const res = tr(readLog(m.log), 'dk1');
    record('dup-keys: duplicate keys deterministic (last-wins -> decoy), no crash', res && res.c.includes('decoy.txt'), res ? res.c.substring(0, 60) : 'no result');
    stopMock(m);
  }
});

// --- J8: overlapping replace_all matches are deterministic ---
scenarios.push({
  name: 'overlap',
  fn: async () => {
    const cwd = freshCwd('j8');
    fs.writeFileSync(path.join(cwd, 'tri.txt'), 'aaaa');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'o1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'tri.txt', old_string: 'aa', new_string: 'X', replace_all: true }) } }] },
      { role: 'assistant', content: 'OVERLAP-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const final = fs.readFileSync(path.join(cwd, 'tri.txt'), 'utf8');
    // split/join semantics: 'aaaa'.split('aa') -> ['',''] -> join('X') = 'XX' (deterministic)
    record('overlap: overlapping replace_all deterministic (split/join)', final === 'XX', JSON.stringify(final));
    stopMock(m);
  }
});

// --- J9: /undo with path normalization variants ---
scenarios.push({
  name: 'undo-norm',
  fn: async () => {
    const cwd = freshCwd('j9');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'u1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'sub/n.txt', content: 'ORIG\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'u2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'sub/n.txt', content: 'CHANGED\n' }) } }] },
      { role: 'assistant', content: 'UNORM-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [
        { t: 'w\n', d: 80 }, { t: '/execute-task-now\n', d: 3500 },
        { t: '/undo ./sub/./n.txt\n', d: 800 },
        { t: '/bye\n', d: 400 }
      ]
    });
    record('undo-norm: dot-segment path normalizes and restores', r.out.includes('Restored') && fs.readFileSync(path.join(cwd, 'sub', 'n.txt'), 'utf8').includes('ORIG'), r.out.substring(0, 100));
    stopMock(m);
  }
});

// --- J10: one client aborts mid-stream while another completes ---
scenarios.push({
  name: 'mixed-abort',
  fn: async () => {
    const cwd = freshCwd('j10');
    const script = [];
    for (let i = 0; i < 8; i++) script.push({ role: 'assistant', content: 'J10-MARK-' + i });
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 350;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      // fire an aborting stream request and a completing one at the same time
      const abortP = new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: srvPort, method: 'POST', path: '/v1/chat/completions',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'a' }] })) } },
          res => { res.once('data', () => { req.destroy(); resolve(); }); });
        req.on('error', () => resolve());
        req.write(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'a' }] }));
        req.end();
      });
      const doneP = httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'b' }] });
      await abortP;
      const done = await doneP;
      record('mixed-abort: completing request succeeds alongside the aborted one', done.status === 200 && /J10-MARK-\d/.test(done.body), 'status=' + done.status);
      const after = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'c' }] });
      record('mixed-abort: server healthy afterwards', after.status === 200, 'status=' + after.status);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

(async () => {
  const t0 = Date.now();
  for (const sc of scenarios) {
    if (RUN_ONLY.length && !RUN_ONLY.includes(sc.name)) continue;
    console.log('--- scenario: ' + sc.name + ' (' + NODE_BIN.substring(0, 40) + ')');
    try { await sc.fn(); } catch (e) { record(sc.name + ' (scenario crashed)', false, e.message); }
  }
  const pass = results.filter(r => r.pass).length;
  if (RUN_ONLY.length && results.length === 0) { console.log('WARNING: RUN_ONLY matched 0 scenarios'); }
  console.log('\n===== SUITE J SUMMARY: ' + pass + '/' + results.length + ' passed in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
  for (const f of results.filter(r => !r.pass)) console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
  process.exit(pass === results.length ? 0 : 1);
})();
