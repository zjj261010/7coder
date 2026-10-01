// Suite H: feature-interaction pairs, RSS trajectory soak (closes blind spot C8),
// static consistency oracles (tools schema / env docs / README sync / markers /
// secrets), deterministic artifacts, safety-net failure paths, HTTP body quirks.
// Usage: node test/runner-h.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
function rmrf(p) { try { if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true }); else fs.rmdirSync(p, { recursive: true, force: true }); } catch (e) {} }

const path = require('path');
const http = require('http');

const ROOT = __dirname;
const REPO = path.join(ROOT, '..');
const IDX = path.join(REPO, 'index.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const RUN_ONLY = (process.env.RUN_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
let port = 18450;
const results = [];
const ownArtifacts = [];
const ownWorkdirs = [];

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
  const logPath = path.join(ROOT, 'mock-log-' + port + '.jsonl');
  ownArtifacts.push(scriptPath, logPath);
  return { child, port, log: logPath };
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
  let dir = path.join(ROOT, 'w-h-' + name);
  rmrf(dir, { recursive: true, force: true });
  for (let i = 0; i < 3 && fs.existsSync(dir); i++) { try { rmrf(dir, { recursive: true, force: true }); } catch (e) { require('child_process').execSync('ping -n 2 127.0.0.1 >nul', { stdio: 'ignore' }); } }
    if (fs.existsSync(dir)) dir = dir + '-' + Date.now(); // unique-suffix fallback (stale dir undeletable)
  fs.mkdirSync(dir, { recursive: true });
  ownWorkdirs.push(dir);
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
    p.on('close', code => { clearTimeout(to); resolve({ code, out, pid: p.pid }); });
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

function rssKB(pid) {
  try {
    const out = execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', timeout: 15000 });
    const m = out.match(/"([\d\.,]+) K"/);
    if (!m) return null;
    return parseInt(m[1].replace(/[\.,]/g, ''), 10);
  } catch (e) { return null; }
}

const scenarios = [];

// --- H1: Ralph loop x sub-agent interaction ---
scenarios.push({
  name: 'ralph-agent',
  fn: async () => {
    const cwd = freshCwd('h1');
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'ra1', type: 'function', function: { name: 'agent_tool', arguments: JSON.stringify({ name: 'scout', task: 'read nums.txt' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ra2', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: 'SUB-ANSWER: the file says 42' },
      { role: 'assistant', content: 'still working' },
      { role: 'assistant', content: 'RALPH_WIGGUM_COMPLETE done with 42' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', ENABLE_RALPH_MODE: 'true', MAX_RETRIES: '4' }, cwd, timeoutMs: 60000 });
    const log = readLog(m.log);
    const subAnswer = toolResults(log).find(t => t.c.includes('SUB-ANSWER'));
    record('ralph+agent: sub-agent runs inside ralph iteration and returns', !!subAnswer, subAnswer ? subAnswer.c.substring(0, 60) : 'no sub result');
    record('ralph+agent: loop completes with sub-agent knowledge in final answer', r.out.includes('done with 42') && r.out.includes('Completion promise fulfilled'), r.out.substring(0, 200));
    stopMock(m);
  }
});

// --- H2: compression + backup + undo in one long session ---
scenarios.push({
  name: 'compress-backup-undo',
  fn: async () => {
    const cwd = freshCwd('h2');
    const big = 'BIGTURN-'.repeat(200);
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'cb1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'v.txt', content: 'V1\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'cb2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'v.txt', content: 'V2 ' + big }) } }] },
      { role: 'assistant', content: big },
      { role: 'assistant', content: 'turn2 done' },
      { role: 'assistant', content: 'cb summary' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass', CONTEXT_CHARS: '2000' }, cwd, timeoutMs: 60000,
      stdinSteps: [
        { t: 'turn one\n', d: 80 }, { t: '/execute-task-now\n', d: 4000 },
        { t: 'turn two\n', d: 80 }, { t: '/execute-task-now\n', d: 4000 },
        { t: '/undo v.txt\n', d: 800 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const log = readLog(m.log);
    const compressed = log.some(x => (x.messages || []).some(mm => String(mm.content || '').includes('[CONTEXT COMPRESSION]')));
    let pairing = true;
    for (const req of log) {
      const roles = (req.messages || []).map(x => x.role);
      for (let i = 0; i < roles.length; i++) {
        if (roles[i] === 'tool' && (i === 0 || (roles[i - 1] !== 'assistant' && roles[i - 1] !== 'tool'))) pairing = false;
      }
    }
    const restored = fs.readFileSync(path.join(cwd, 'v.txt'), 'utf8');
    record('combo: compression engaged in same session as backups', compressed, '');
    record('combo: pairing valid under compression+tools', pairing, '');
    record('combo: /undo restores V1 while conversation was compressed', restored.startsWith('V1'), 'file=' + JSON.stringify(restored.substring(0, 30)));
    stopMock(m);
  }
});

// --- H3: RSS trajectory over 24 tasks (blind spot C8) ---
scenarios.push({
  name: 'rss-soak',
  fn: async () => {
    const cwd = freshCwd('h3');
    const script = [];
    for (let i = 0; i < 26; i++) script.push({ role: 'assistant', content: 'SOAKPULSE-' + i });
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const steps = [];
    for (let i = 0; i < 24; i++) { steps.push({ t: 't' + i + '\n', d: 50 }); steps.push({ t: '/execute-task-now\n', d: 550 }); }
    steps.push({ t: '/bye\n', d: 400 });
    const p = spawn(NODE_BIN, [IDX], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', PERMISSION_MODE: 'bypass' }),
      cwd
    });
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    const samples = [];
    let idx = 0;
    const sampler = setInterval(() => {
      idx++;
      const kb = rssKB(p.pid);
      if (kb) samples.push(kb);
    }, 1000);
    const done = new Promise(resolve => {
      const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 60000);
      p.on('close', () => { clearTimeout(to); resolve(); });
    });
    (async () => {
      for (const s of steps) { p.stdin.write(s.t); await new Promise(r => setTimeout(r, s.d)); }
      p.stdin.end();
    })().catch(() => {});
    await done;
    clearInterval(sampler);
    const completed = (out.match(/7CODER\.md updated with complete summary/g) || []).length;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const max = Math.max.apply(null, samples);
    record('rss-soak: 24 tasks completed while sampling', completed >= 24 && samples.length >= 3, 'completed=' + completed + ' samples=' + samples.join(','));
    record('rss-soak: no runaway growth (final < 3x initial and max < 400MB)',
      first > 0 && last < first * 3 && max < 400 * 1024,
      'first=' + first + 'KB last=' + last + 'KB max=' + max + 'KB');
    stopMock(m);
  }
});

// --- H4: static consistency oracles ---
scenarios.push({
  name: 'static-audit',
  fn: async () => {
    const src = fs.readFileSync(IDX, 'utf8');
    // tools array region
    const tStart = src.indexOf('const tools = [');
    const tEnd = src.indexOf('\n];', tStart);
    const toolsSrc = src.substring(tStart, tEnd);
    const names = [];
    const nameRe = /name:\s*"([a-z0-9_]+)"/g;
    let mm;
    while ((mm = nameRe.exec(toolsSrc))) names.push(mm[1]);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    record('static: tool names unique (' + names.length + ' tools)', dupes.length === 0, 'dupes=' + JSON.stringify(dupes));
    const missingDesc = [];
    const missingReq = [];
    const entryRe = /function:\s*\{\s*name:\s*"([a-z0-9_]+)"(?:,\s*description:\s*"((?:[^"\\]|\\.)*)")?((?:[^}])*?)\}\s*\}/g;
    while ((mm = entryRe.exec(toolsSrc))) {
      const [, name, desc, rest] = mm;
      if (!desc) missingDesc.push(name);
      const reqMatch = rest.match(/required:\s*\[([^\]]*)\]/);
      if (reqMatch) {
        const reqs = reqMatch[1].split(',').map(s => s.replace(/["'\s]/g, '')).filter(Boolean);
        const propsMatch = rest.match(/properties:\s*\{([\s\S]*?)\},?\s*required/);
        if (propsMatch) {
          const props = [];
          const propRe = /([a-z_0-9]+):\s*\{\s*"type"/g;
          let pm;
          while ((pm = propRe.exec(propsMatch[1]))) props.push(pm[1]);
          for (const rq of reqs) if (!props.includes(rq)) missingReq.push(name + '.' + rq);
        }
      }
    }
    record('static: every tool has a description', missingDesc.length === 0, 'missing=' + JSON.stringify(missingDesc));
    record('static: required fields all declared in properties', missingReq.length === 0, 'violations=' + JSON.stringify(missingReq));
    // env var documentation cross-check (both dot and bracket access)
    const envReads = new Set();
    const envRe = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((mm = envRe.exec(src))) envReads.add(mm[1]);
    const envBrRe = /process\.env\[['"]([A-Za-z_][A-Za-z0-9_()]*)['"]\]/g;
    while ((mm = envBrRe.exec(src))) envReads.add(mm[1]);
    const envExample = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
    const documented = new Set();
    const docRe = /^\s*([A-Z_][A-Z0-9_]*)=/gm;
    while ((mm = docRe.exec(envExample))) documented.add(mm[1]);
    const sysAllow = new Set(['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']);
    const legacyAllow = new Set(['MAX_ATTEMPT_RETRIES', 'ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE']);
    const undocumented = [];
    for (const e of envReads) {
      if (!documented.has(e) && !sysAllow.has(e) && !legacyAllow.has(e)) undocumented.push(e);
    }
    record('static: every config env var is documented in .env.example', undocumented.length === 0, 'undocumented=' + JSON.stringify(undocumented));
    // README documents the core tools
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
    const coreTools = ['read_file', 'write_file', 'edit_file', 'run_command', 'bash_tool', 'powershell_tool',
      'agent_tool', 'task_create_tool', 'skill_tool', 'synthetic_output_tool', 'computer_use',
      'schedule_cron_tool', 'download_tool', 'process_kill_tool', 'list_dir', 'glob_tool', 'grep_tool'];
    const notInReadme = coreTools.filter(t => !readme.includes(t));
    record('static: core tools documented in README', notInReadme.length === 0, 'missing=' + JSON.stringify(notInReadme));
    // no leftover dev markers (TODO.md is a product feature, not a marker)
    const markerSrc = src.replace(/TODO\.md/g, '').replace(/7CODER\.md/g, '');
    const markers = (markerSrc.match(/\b(TODO|FIXME|XXX|HACK)\b/g) || []);
    record('static: no TODO/FIXME/XXX/HACK markers in index.js', markers.length === 0, JSON.stringify(markers));
    const secrets = (src.match(/sk-[a-zA-Z0-9]{16,}/g) || []);
    record('static: no hardcoded API-key-shaped strings', secrets.length === 0, JSON.stringify(secrets));
  }
});

// --- H5: deterministic artifacts across two identical runs ---
scenarios.push({
  name: 'determinism',
  fn: async () => {
    const script = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'same-content' }) } }] },
      { role: 'assistant', content: 'IDEM-DONE' },
      { role: 'assistant', content: 'idem summary' }
    ];
    const cwds = [freshCwd('h5a'), freshCwd('h5b')];
    for (const cwd of cwds) {
      const m = startMock(script);
      await new Promise(r => setTimeout(r, 600));
      await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
      stopMock(m);
    }
    const snapshot = (dir) => {
      const out = {};
      const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(dir, rel))) {
          const r = rel ? rel + '/' + e : e;
          const full = path.join(dir, r);
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            if (e === '.7coder' || e === '.mcp') continue;
            walk(r);
          } else {
            // timestamps / interaction bookkeeping are intentionally non-deterministic
            if (e === '.7coder_last_interaction') continue;
            out[r] = fs.readFileSync(full, 'utf8');
          }
        }
      };
      walk('');
      return out;
    };
    const a = snapshot(cwds[0]);
    const b = snapshot(cwds[1]);
    const keysA = Object.keys(a).sort().join(',');
    const keysB = Object.keys(b).sort().join(',');
    let diffDetail = '';
    if (keysA !== keysB) diffDetail = 'file list differs';
    else for (const k of keysA.split(',')) {
      if (a[k] !== b[k]) { diffDetail = k + ' differs: ' + JSON.stringify(a[k]).substring(0, 60) + ' vs ' + JSON.stringify(b[k]).substring(0, 60); break; }
    }
    record('determinism: two identical runs produce byte-identical workspaces', keysA === keysB && !diffDetail,
      diffDetail || ('files=' + keysA));
  }
});

// --- H6: safety-net failure path - backups dir occupied by a FILE ---
scenarios.push({
  name: 'backup-fail',
  fn: async () => {
    const cwd = freshCwd('h6');
    fs.writeFileSync(path.join(cwd, '.7coder'), 'occupied'); // dir path is a file
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'bf1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'ok.txt', content: 'still writes' }) } }] },
      { role: 'assistant', content: 'BF-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    record('backup-fail: unusable backups dir does NOT block the write', fs.readFileSync(path.join(cwd, 'ok.txt'), 'utf8') === 'still writes' && r.out.includes('BF-DONE'), r.out.substring(0, 150));
    record('backup-fail: no crash (clean exit)', r.code === 0, 'exit=' + r.code);
    stopMock(m);
  }
});

// --- H7: HTTP body quirks ---
scenarios.push({
  name: 'body-quirks',
  fn: async () => {
    const cwd = freshCwd('h7');
    const m = startMock([{ role: 'assistant', content: 'H7-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 310;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const bom = await httpReq(srvPort, 'POST', '/v1/chat/completions', '\uFEFF' + JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }));
      record('body: BOM-prefixed JSON -> clean 500 (parse error surfaced)', bom.status === 500 && bom.body.includes('error'), 'status=' + bom.status);
      const wrongCT = await httpReq(srvPort, 'POST', '/v1/chat/completions', JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }), { 'Content-Type': 'text/plain' });
      record('body: content-type ignored, JSON still processed', wrongCT.status === 200 && wrongCT.body.includes('H7-OK'), 'status=' + wrongCT.status);
      const broken = await httpReq(srvPort, 'POST', '/v1/chat/completions', '{"messages": [oops');
      record('body: truncated JSON -> clean 500', broken.status === 500, 'status=' + broken.status);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- H8: regression tests for the fix-audit findings ---
scenarios.push({
  name: 'audit-fixes',
  fn: async () => {
    // 1) junction + 70-segment depth attack must fail closed (no silent fallback)
    const cwd = freshCwd('h8a');
    const outside = path.join(ROOT, 'h8-outside');
    rmrf(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    spawnSync('cmd', ['/c', 'mklink', '/J', path.join(cwd, 'jdeep'), outside]);
    const deepPath = 'jdeep/' + Array(70).fill(0).map((_, i) => 'd' + i).join('/') + '/x.txt';
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'af1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: deepPath, content: 'escaped' }) } }] },
      { role: 'assistant', content: 'AF-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const res1 = tr(readLog(m.log), 'af1');
    const escaped = fs.existsSync(path.join(outside, 'd0'));
    record('audit: depth-guard exhaustion fails CLOSED (no junction escape)', res1 && /depth exceeded|resolved safely/.test(res1.c) && !escaped, 'result=' + (res1 ? res1.c.substring(0, 60) : 'none') + ' escaped=' + escaped);
    stopMock(m);
    try { rmrf(path.join(cwd, 'jdeep'), { recursive: true, force: true }); } catch (e) {}
    rmrf(outside, { recursive: true, force: true });

    // 2) backup of an OLD-mtime file survives pruning and /undo ordering holds
    const cwd2 = freshCwd('h8b');
    fs.writeFileSync(path.join(cwd2, 'legacy.txt'), 'V0');
    const oldT = new Date('2015-01-01T00:00:00Z');
    fs.utimesSync(path.join(cwd2, 'legacy.txt'), oldT, oldT);
    const padsDir = path.join(cwd2, '.7coder', 'backups');
    fs.mkdirSync(padsDir, { recursive: true });
    for (let i = 0; i < 102; i++) {
      const p = path.join(padsDir, 'pad.' + String(i).padStart(3, '0') + '.txt.bak');
      fs.writeFileSync(p, 'x');
      const t = new Date(Date.now() - (300 - i) * 60000); // newer than 2015, ascending
      fs.utimesSync(p, t, t);
    }
    const m2 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'af2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'legacy.txt', content: 'V1' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'af3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'legacy.txt', content: 'V2' }) } }] },
      { role: 'assistant', content: 'AF2-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r2 = await runCli({
      port: m2.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd2, timeoutMs: 30000,
      stdinSteps: [{ t: 'two writes\n', d: 80 }, { t: '/execute-task-now\n', d: 3500 }, { t: '/undo legacy.txt\n', d: 800 }, { t: '/bye\n', d: 400 }]
    });
    const legacyBaks = fs.readdirSync(padsDir).filter(f => f.startsWith('legacy.txt.'));
    record('audit: old-mtime backup survives pruning', legacyBaks.length >= 1, 'legacy backups=' + legacyBaks.length);
    record('audit: /undo picks newest backup (V1)', r2.out.includes('Restored') && fs.readFileSync(path.join(cwd2, 'legacy.txt'), 'utf8') === 'V1', fs.readFileSync(path.join(cwd2, 'legacy.txt'), 'utf8'));
    stopMock(m2);

    // 3) /btw immediately followed by /execute-task-now (pasted) - note must land
    const cwd3 = freshCwd('h8c');
    const m3 = startMock([
      { role: 'assistant', content: 'BTW-NOTE-SUMMARY' },
      { role: 'assistant', content: 'AF3-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r3 = await runCli({
      port: m3.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd3, timeoutMs: 30000,
      stdinSteps: [
        { t: '/btw remember mango\n', d: 0 }, { t: 'task body\n', d: 0 }, { t: '/execute-task-now\n', d: 3500 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const mains3 = readLog(m3.log).filter(x => x.stream === true);
    const firstUser = mains3.length ? mains3[0].messages.find(x => x.role === 'user') : null;
    record('audit: pasted /btw lands before task starts', r3.out.includes('AF3-DONE') && !!firstUser && String(firstUser.content).includes('BTW-NOTE-SUMMARY') && String(firstUser.content).includes('task body'), firstUser ? String(firstUser.content).substring(0, 80) : 'no main req');
    stopMock(m3);

    // 4) ask_user on a closed readline (server mode) returns skipped instead of hanging
    const cwd4 = freshCwd('h8d');
    const m4 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'af4', type: 'function', function: { name: 'ask_user_question_tool', arguments: JSON.stringify({ question: 'q' }) } }] },
      { role: 'assistant', content: 'LOW' },
      { role: 'assistant', content: 'YES' },
      { role: 'assistant', content: 'AF4-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 320;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m4.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort), PERMISSION_MODE: 'auto' }),
      cwd: cwd4, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const resp = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
      const q = tr(readLog(m4.log), 'af4');
      record('audit: ask_user on closed input returns skipped, request completes', resp.status === 200 && q && q.c.includes('input stream is closed'), 'status=' + resp.status + ' q=' + (q ? q.c.substring(0, 50) : 'none'));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m4);
    }
  }
});

// --- H9: glob directory-aware patterns (A11 fix) ---
scenarios.push({
  name: 'glob-dir',
  fn: async () => {
    const cwd = freshCwd('h9');
    for (const f of ['top.js', 'top.txt', 'src/a.js', 'src/b.ts', 'src/sub/deep.js', 'src/sub/deeper/x.test.js', 'lib/note.TXT']) {
      fs.mkdirSync(path.join(cwd, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(cwd, f), 'x');
    }
    const asks = [
      ['g1', 'src/*.js', ['src/a.js'], ['src/sub/deep.js', 'top.js']],
      ['g2', 'src/**/*.js', ['src/a.js', 'src/sub/deep.js'], []],
      ['g3', '**/*.test.js', ['src/sub/deeper/x.test.js'], []],
      ['g4', '*.js', ['top.js', 'src/a.js', 'src/sub/deep.js', 'src/sub/deeper/x.test.js'], []], // plain pattern: basenames at any depth (pre-existing behavior)
      ['g5', '*.txt', ['top.txt', 'lib' + path.sep + 'note.TXT'], []],
      ['g6', 'src' + path.sep + '*.ts', ['src/b.ts'], []],
      ['g7', 'lib/**', ['lib' + path.sep + 'note.TXT'], []]
    ];
    const script = asks.map(([id, pattern]) => ({
      role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'glob_tool', arguments: JSON.stringify({ pattern }) } }]
    }));
    script.push({ role: 'assistant', content: 'GLOBDIR-DONE' });
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const log = readLog(m.log);
    for (const [id, pattern, must, mustNot] of asks) {
      const res = tr(log, id);
      if (!res) { record('glob-dir: ' + pattern + ' (result present)', false, 'no result'); continue; }
      const sep = s => s.split('/').join(path.sep);
      const lines = res.c.split('\n').filter(Boolean);
      const ok = must.map(sep).every(x => lines.includes(x)) && mustNot.map(sep).every(x => !lines.includes(x));
      record('glob-dir: ' + pattern + ' matches exactly the right set', ok, 'got=' + JSON.stringify(lines));
    }
    stopMock(m);
  }
});

(async () => {
  const t0 = Date.now();
  for (const sc of scenarios) {
    if (RUN_ONLY.length && !RUN_ONLY.includes(sc.name)) continue;
    console.log('--- scenario: ' + sc.name + ' (' + NODE_BIN.substring(0, 40) + ')');
    try { await sc.fn(); } catch (e) { record(sc.name + ' (scenario crashed)', false, e.message); }
  }
  // OPT-11: delete this run's own artifacts (cur-script-*, mock-log-*, w-* workdirs) before exiting.
  try { for (const f of ownArtifacts) { try { fs.unlinkSync(f); } catch (e) {} } } catch (e) {}
  for (const d of ownWorkdirs) rmrf(d);
  const pass = results.filter(r => r.pass).length;
  if (RUN_ONLY.length && results.length === 0) { console.log('WARNING: RUN_ONLY matched 0 scenarios'); process.exit(1); }
  console.log('\n===== SUITE H SUMMARY: ' + pass + '/' + results.length + ' passed in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
  for (const f of results.filter(r => !r.pass)) console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
  process.exit(pass === results.length ? 0 : 1);
})();
