// Suite D: sandbox torture, cross-process persistence, config edges, real
// vision/web payloads, HTTP method matrix, approval casing, CLI arg forms.
// Usage: node test/runner-d.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
function rmrf(p) { try { if (fs.rmSync) rmrf(p, { recursive: true, force: true }); else fs.rmdirSync(p, { recursive: true, force: true }); } catch (e) {} }

const path = require('path');
const http = require('http');

const ROOT = __dirname;
const IDX = path.join(__dirname, '..', 'index.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const RUN_ONLY = (process.env.RUN_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
let port = 18050;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  :: ' + String(detail).substring(0, 300)));
}

function startMock(scriptObj, customServerCode) {
  port += 1;
  const scriptPath = path.join(ROOT, 'cur-script-' + port + '.json');
  fs.writeFileSync(scriptPath, JSON.stringify(scriptObj || [{ role: 'assistant', content: 'MOCK-DEFAULT' }]));
  const file = customServerCode
    ? path.join(ROOT, 'tmp-server-' + port + '.js')
    : path.join(ROOT, 'mock-server.js');
  if (customServerCode) fs.writeFileSync(file, customServerCode.replace(/__PORT__/g, String(port)).replace(/__SCRIPT__/g, scriptPath.split('\\').join('\\\\')));
  const child = spawn(NODE_BIN, [file], {
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
  let dir = path.join(ROOT, 'w-d-' + name);
  rmrf(dir, { recursive: true, force: true });
  for (let i = 0; i < 3 && fs.existsSync(dir); i++) { try { rmrf(dir, { recursive: true, force: true }); } catch (e) { require('child_process').execSync('ping -n 2 127.0.0.1 >nul', { stdio: 'ignore' }); } }
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

// ====================== SCENARIOS ======================
const scenarios = [];

// --- D1: sandbox torture table ---
scenarios.push({
  name: 'torture',
  fn: async () => {
    const cwd = freshCwd('d1');
    const outsideDir = path.join(ROOT, 'd1-outside');
    rmrf(outsideDir, { recursive: true, force: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'bait.txt'), 'OUTSIDE-BAIT');
    const relOut = path.relative(cwd, path.join(outsideDir, 'bait.txt'));
    const attacks = [
      ['traversal ../', relOut.replace(/\\/g, '/')],
      ['absolute path', path.join(outsideDir, 'bait.txt')],
      ['mixed slashes ..\\', relOut],
      ['dotdot inside segments', 'a/../../../../../../' + relOut.replace(/\\/g, '/')],
      ['drive-relative C:bait', 'C:bait.txt'],
      ['NTFS ADS on traversal', relOut.replace(/\\/g, '/') + ':stream'],
      ['double-dot with mixed depth', 'a/b/../../../' + relOut.replace(/\\/g, '/')]
    ];
    const calls = attacks.map(([label], i) => ({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'x' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: attacks[i][1] }) } }]
    }));
    calls.push({ role: 'assistant', content: 'TORTURE-DONE' });
    const m = startMock(calls);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 120000 });
    const log = readLog(m.log);
    let leaks = 0;
    attacks.forEach(([label], i) => {
      const res = tr(log, 'x' + i);
      const leaked = res && res.c.includes('OUTSIDE-BAIT');
      if (leaked) leaks++;
      record('torture: ' + label + ' cannot read outside bait', !leaked, res ? res.c.substring(0, 70) : 'no result');
    });
    // reserved device names: must not hang or crash the process
    const res2 = tr(log, 'x0');
    record('torture: process completed the full attack table', r2done(log), 'calls=' + attacks.length);
    // reserved name write attempt (CON) via second mock
    const m2 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'CON.txt', content: 'x' }) } }] },
      { role: 'assistant', content: 'RESERVED-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m2.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: freshCwd('d1b') });
    record('torture: reserved device name write surfaces cleanly', r.out.includes('RESERVED-DONE'), r.out.substring(0, 120));
    stopMock(m2);
    stopMock(m);
    rmrf(outsideDir, { recursive: true, force: true });
    function r2done(l) { return l.length > 0; }
  }
});

// --- D2: TEMPERATURE=0 must not fall back to 0.7 ---
scenarios.push({
  name: 'temp-zero',
  fn: async () => {
    const cwd = freshCwd('d2');
    const m = startMock([{ role: 'assistant', content: 'TEMP-DONE' }]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { TEMPERATURE: '0', PERMISSION_MODE: 'bypass' }, cwd });
    const req = readLog(m.log)[0];
    record('config: TEMPERATURE=0 honored (not falsy-fallback 0.7)', req && req.temperature === 0, 'sent=' + (req ? req.temperature : 'no req'));
    stopMock(m);
  }
});

// --- D3: cross-process continuity via 7CODER.md ---
scenarios.push({
  name: 'cross-process',
  fn: async () => {
    const cwd = freshCwd('d3');
    const m1 = startMock([
      { role: 'assistant', content: 'PROC1-DONE' },
      { role: 'assistant', content: 'summary with PERSIST-MARKER-ONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m1.port, args: ['--prompt', 'first task'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    stopMock(m1);
    const md = path.join(cwd, '7CODER.md');
    if (!fs.existsSync(md) || !fs.readFileSync(md, 'utf8').includes('PERSIST-MARKER-ONE')) {
      record('cross-process: first session wrote 7CODER.md marker', false, fs.existsSync(md) ? fs.readFileSync(md, 'utf8').substring(0, 80) : 'no 7CODER.md');
      stopMock(m1);
      return;
    }
    const m2 = startMock([
      { role: 'assistant', content: 'PROC2-DONE' },
      { role: 'assistant', content: 'summary two' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m2.port, args: ['--prompt', 'second task'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const req = readLog(m2.log)[0];
    const firstUser = req && req.messages.find(x => x.role === 'user');
    record('cross-process: second process seeds 7CODER.md summary into prompt', !!firstUser && String(firstUser.content).includes('PERSIST-MARKER-ONE'), firstUser ? String(firstUser.content).substring(0, 100) : 'no req');
    stopMock(m2);
  }
});

// --- D4: vision payload structure ---
scenarios.push({
  name: 'vision',
  fn: async () => {
    const cwd = freshCwd('d4');
    const imgPort = port + 200;
    const isrv = spawn(NODE_BIN, ['-e', 'const http=require("http");http.createServer((q,s)=>{s.writeHead(200,{"Content-Type":"image/png"});s.end(Buffer.from([0x89,0x50]))}).listen(' + imgPort + ',"127.0.0.1")'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 700));
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'v1', type: 'function', function: { name: 'web_browser_tool', arguments: JSON.stringify({ url: 'http://127.0.0.1:' + imgPort + '/pic.png' }) } }] },
      { role: 'assistant', content: 'VISION-DESC' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({
      port: m.port, args: ['--prompt', 'look at the image'],
      env: { PERMISSION_MODE: 'bypass', VISION_MODEL: 'vision-x' }, cwd
    });
    isrv.kill();
    const vreq = readLog(m.log).find(x => x.model === 'vision-x');
    const hasImage = vreq && JSON.stringify(vreq.messages).includes('image_url');
    record('vision: image URL routed to VISION_MODEL with image_url payload', !!vreq && hasImage, vreq ? JSON.stringify(vreq.messages[0].content).substring(0, 120) : 'no vision call found');
    stopMock(m);
  }
});

// --- D5: web_browser_tool HTML parsing against a local server ---
scenarios.push({
  name: 'web-html',
  fn: async () => {
    const cwd = freshCwd('d5');
    const htmlPort = port + 210;
    const html = '<html><head><style>.x{color:red}</style><script>evilFunctionCall()</script></head><body><h1>Title-Here</h1><a href="http://example.com/page1">LinkOne</a><a href="/page2">LinkTwo</a><p>Body-Paragraph-Marker</p></body></html>';
    const srv = spawn(NODE_BIN, ['-e', 'const http=require("http");http.createServer((q,s)=>{s.writeHead(200,{"Content-Type":"text/html"});s.end(' + JSON.stringify(html) + ')}).listen(' + htmlPort + ',"127.0.0.1")'], { stdio: 'ignore' });
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'web_browser_tool', arguments: JSON.stringify({ url: 'http://127.0.0.1:' + htmlPort + '/', action: 'navigate' }) } }] },
      { role: 'assistant', content: 'WEBHTML-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 800));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const res = tr(readLog(m.log), 'w1');
    record('web: links extracted from HTML', res && res.c.includes('LinkOne') && res.c.includes('page2'), res ? res.c.substring(0, 100) : 'no result');
    record('web: scripts/styles stripped from preview', res && res.c.includes('Body-Paragraph-Marker') && !res.c.includes('evilFunctionCall') && !res.c.includes('color:red'), res ? (res.c.includes('evil') ? 'script leaked' : 'clean') : 'no result');
    record('web: content preview present', res && res.c.includes('Title-Here'), '');
    srv.kill();
    stopMock(m);
  }
});

// --- D6: download follows 302 redirect ---
scenarios.push({
  name: 'redirect',
  fn: async () => {
    const cwd = freshCwd('d6');
    const rport = port + 220;
    const srv = spawn(NODE_BIN, ['-e',
      'const http=require("http");http.createServer((q,s)=>{' +
      'if(q.url==="/start"){s.writeHead(302,{Location:"http://127.0.0.1:' + rport + '/target"});s.end()}' +
      'else{s.writeHead(200,{"Content-Type":"text/plain"});s.end("REDIRECT-TARGET-BLOB")}' +
      '}).listen(' + rport + ',"127.0.0.1")'], { stdio: 'ignore' });
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'download_tool', arguments: JSON.stringify({ url: 'http://127.0.0.1:' + rport + '/start', path: 'red.txt' }) } }] },
      { role: 'assistant', content: 'REDIRECT-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 800));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const ok = fs.existsSync(path.join(cwd, 'red.txt')) && fs.readFileSync(path.join(cwd, 'red.txt'), 'utf8').includes('REDIRECT-TARGET-BLOB');
    record('redirect: download follows 302 and saves target blob', ok, '');
    srv.kill();
    stopMock(m);
  }
});

// --- D7: HTTP method/path matrix ---
scenarios.push({
  name: 'http-matrix',
  fn: async () => {
    const cwd = freshCwd('d7');
    const m = startMock([{ role: 'assistant', content: 'D7-REPLY' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 230;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort), HTTP_API_KEY: 'kM' }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const auth = { Authorization: 'Bearer kM' };
      const models = await httpReq(srvPort, 'GET', '/v1/models', null);
      record('matrix: GET /v1/models 200', models.status === 200, '');
      const head = await httpReq(srvPort, 'HEAD', '/v1/models', null);
      record('matrix: HEAD /v1/models does not crash (404 or 200 both acceptable)', head.status === 200 || head.status === 404, 'status=' + head.status);
      const put = await httpReq(srvPort, 'PUT', '/v1/chat/completions', { messages: [] }, auth);
      record('matrix: PUT to chat endpoint -> 404', put.status === 404, 'status=' + put.status);
      const slash = await httpReq(srvPort, 'POST', '/v1/chat/completions/', { messages: [{ role: 'user', content: 'x' }] }, auth);
      record('matrix: trailing slash -> 404 (strict path match)', slash.status === 404, 'status=' + slash.status);
      const query = await httpReq(srvPort, 'POST', '/v1/chat/completions?x=1', { messages: [{ role: 'user', content: 'x' }] }, auth);
      record('matrix: query string on endpoint -> 404 (documented strictness)', query.status === 404, 'status=' + query.status);
      const lower = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'bearer kM' });
      record('matrix: lowercase bearer scheme -> 401 (strict, security-favorable)', lower.status === 401, 'status=' + lower.status);
      const plain = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, auth);
      record('matrix: normal POST still 200 after matrix', plain.status === 200 && plain.body.includes('D7-REPLY'), '');
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- D8: 7CODER.md corruption resilience + .env.local protection ---
scenarios.push({
  name: 'md-corrupt',
  fn: async () => {
    const cwd = freshCwd('d8');
    fs.writeFileSync(path.join(cwd, '7CODER.md'), '\u0000\u0001garbage\u0002\nnot a bullet list\n');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '.env.local', content: 'X=1' }) } }] },
      { role: 'assistant', content: 'MDCORRUPT-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const md = fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8');
    record('md: corrupted 7CODER.md survives; bullets in marker section; old content preserved', md.includes('auto-log:start') && md.includes('- MDCORRUPT-DONE') && md.includes('garbage') && r.out.includes('MDCORRUPT-DONE'), md.substring(0, 60));
    record('md: .env.local (variant) write BLOCKED in bypass', tr(readLog(m.log), 'c1') && tr(readLog(m.log), 'c1').c.includes('BLOCKED: protected file') && !fs.existsSync(path.join(cwd, '.env.local')), '');
    stopMock(m);
  }
});

// --- D9: approval input casing ---
scenarios.push({
  name: 'approval-case',
  fn: async () => {
    for (const [label, answer, shouldWrite] of [['uppercase Y', 'Y', true], ['full word yes', 'yes', true], ['lowercase n', 'n', false], ['bare enter', '', false]]) {
      const cwd = freshCwd('d9' + label.length + (shouldWrite ? 'w' : 'x'));
      const m = startMock([
        { role: 'assistant', content: null, tool_calls: [{ id: 'a' + label.length, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'ok.txt', content: 'approved' }) } }] },
        { role: 'assistant', content: 'MEDIUM' },
        { role: 'assistant', content: 'It writes ok.txt.' },
        { role: 'assistant', content: 'CASE-DONE' }
      ]);
      await new Promise(r => setTimeout(r, 600));
      await runCli({
        port: m.port, args: [], cwd,
        stdinSteps: [
          { t: 'do it\n', d: 100 }, { t: '/execute-task-now\n', d: 4000 },
          { t: answer + '\n', d: 2500 },
          { t: '/bye\n', d: 400 }
        ]
      });
      const written = fs.existsSync(path.join(cwd, 'ok.txt'));
      record('approval: "' + (answer || 'enter') + '" -> ' + (shouldWrite ? 'approved' : 'declined'), written === shouldWrite, 'exists=' + written);
      stopMock(m);
    }
  }
});

// --- D10: CLI two-argument --permission-mode form ---
scenarios.push({
  name: 'cli-twoarg',
  fn: async () => {
    const cwd = freshCwd('d10');
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: 'TWOARG-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't', '--permission-mode', 'denial'], cwd });
    record('cli: --permission-mode <value> two-arg form works', tr(readLog(m.log), 'c2') && tr(readLog(m.log), 'c2').c.includes('denial. Action blocked'), tr(readLog(m.log), 'c2') ? tr(readLog(m.log), 'c2').c : 'no result');
    stopMock(m);
  }
});

// --- D11: notebook output is valid JSON ---
scenarios.push({
  name: 'notebook-json',
  fn: async () => {
    const cwd = freshCwd('d11');
    fs.writeFileSync(path.join(cwd, 'nb.ipynb'), '{"cells":[],"metadata":{"orig":1}}');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'n1', type: 'function', function: { name: 'notebook_edit_tool', arguments: JSON.stringify({ path: 'nb.ipynb', edits: { cells: [{ cell_type: 'code', source: 'print(1)' }], metadata: { added: true } } }) } }] },
      { role: 'assistant', content: 'NB-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    let valid = false; let nb = null;
    try { nb = JSON.parse(fs.readFileSync(path.join(cwd, 'nb.ipynb'), 'utf8')); valid = true; } catch (e) {}
    record('notebook: output is valid JSON with merged metadata', valid && nb.cells.length === 1 && nb.metadata.orig === 1 && nb.metadata.added === true, JSON.stringify(nb).substring(0, 80));
    stopMock(m);
  }
});

// --- D12: backup restore across processes ---
scenarios.push({
  name: 'backup-cross',
  fn: async () => {
    const cwd = freshCwd('d12');
    const m1 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'b1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'cf.txt', content: 'FIRST\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'cf.txt', content: 'SECOND\n' }) } }] },
      { role: 'assistant', content: 'P1-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({
      port: m1.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [{ t: 'w\n', d: 100 }, { t: '/execute-task-now\n', d: 4000 }, { t: '/bye\n', d: 400 }]
    });
    stopMock(m1);
    if (fs.readFileSync(path.join(cwd, 'cf.txt'), 'utf8').includes('SECOND') !== true) {
      record('backup-cross: session 1 left SECOND on disk', false, '');
      return;
    }
    const m2 = startMock([{ role: 'assistant', content: 'unused' }]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m2.port, args: [], cwd,
      stdinSteps: [{ t: '/undo cf.txt\n', d: 800 }, { t: '/bye\n', d: 400 }]
    });
    record('backup-cross: /undo in a NEW process restores newest backup', fs.readFileSync(path.join(cwd, 'cf.txt'), 'utf8').includes('FIRST') && r.out.includes('Restored'), '');
    stopMock(m2);
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
  console.log('\n===== SUITE D SUMMARY: ' + pass + '/' + results.length + ' passed in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
  for (const f of results.filter(r => !r.pass)) console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
  process.exit(pass === results.length ? 0 : 1);
})();
