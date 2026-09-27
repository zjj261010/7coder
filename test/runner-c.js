// Suite C: concurrency, protocol variants, escape attacks, real cron firing,
// shutdown semantics, filesystem edges, edit boundaries, soak.
// Usage: node test/runner-c.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const IDX = path.join(__dirname, '..', 'index.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const RUN_ONLY = (process.env.RUN_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
let port = 17950;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  :: ' + String(detail).substring(0, 300)));
}

function startMock(scriptObj, mockFile) {
  port += 1;
  const scriptPath = path.join(ROOT, 'cur-script-' + port + '.json');
  fs.writeFileSync(scriptPath, JSON.stringify(scriptObj || [{ role: 'assistant', content: 'MOCK-DEFAULT' }]));
  const child = spawn(NODE_BIN, [path.join(ROOT, mockFile || 'mock-server.js')], {
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
  const dir = path.join(ROOT, 'w-c-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
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
    const t0 = Date.now();
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => out += d.toString());
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs || 90000);
    p.on('close', code => { clearTimeout(to); resolve({ code, out, elapsedMs: Date.now() - t0 }); });
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
    // a tool message must follow the assistant that called it, or another
    // tool result of the same assistant (multi-tool responses)
    if (roles[i] === 'tool' && (i === 0 || (roles[i - 1] !== 'assistant' && roles[i - 1] !== 'tool'))) return false;
  }
  return true;
}

const scenarios = [];

// --- C1: multiple tool calls in ONE assistant response ---
scenarios.push({
  name: 'multi-tool',
  fn: async () => {
    const cwd = freshCwd('c1');
    const m = startMock([
      { role: 'assistant', content: 'Let me do three things.', tool_calls: [
        { id: 'm1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'AAA' }) } },
        { id: 'm2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'BBB' }) } },
        { id: 'm3', type: 'function', function: { name: 'append_file', arguments: JSON.stringify({ path: 'a.txt', content: '-MORE' }) } }
      ] },
      { role: 'assistant', content: 'MULTITOOL-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    const second = log.find(r => (r.messages || []).filter(x => x.role === 'tool').length === 3);
    record('multi-tool: all 3 results appended in order', !!second && second.messages.filter(x => x.role === 'tool').map(x => x.tool_call_id).join(',') === 'm1,m2,m3', second ? 'order=' + second.messages.filter(x => x.role === 'tool').map(x => x.tool_call_id).join(',') : 'no req with 3 tool results');
    record('multi-tool: pairing stays valid', pairingValid(second ? second.messages : []), '');
    record('multi-tool: file effects all landed', fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8') === 'AAA-MORE' && fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8') === 'BBB', '');
    stopMock(m);
  }
});

// --- C2: protocol variants from a sloppy/malicious server ---
scenarios.push({
  name: 'protocol',
  fn: async () => {
    // content AND tool_calls in the same message
    let cwd = freshCwd('c2a');
    let m = startMock([
      { role: 'assistant', content: 'I will also call a tool.', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: 'PROTO-A-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    let r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    record('protocol: content+tool_calls both honored', r.out.includes('PROTO-A-DONE') && tr(readLog(m.log), 'p1') && tr(readLog(m.log), 'p1').c.includes('42'), '');
    stopMock(m);

    // empty choices array
    cwd = freshCwd('c2b');
    m = startMock([]);
    const rawPath = path.join(ROOT, 'cur-script-' + (port) + '.json');
    fs.writeFileSync(rawPath, JSON.stringify([]));
    // serve empty choices via a raw server
    stopMock(m);
    m = startMock([{ role: 'assistant', content: 'NEVER' }]);
    // replace the mock's script with one that returns empty choices: use chaos malformed instead
    stopMock(m);
    m = startProcess2('malformed-body');
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_RETRIES: '1', PERMISSION_MODE: 'bypass' }, cwd });
    record('protocol: empty/garbage choices -> clean retry error', r.out.includes('Max retries reached') || r.out.includes('Invalid API response'), r.out.substring(0, 120));
    stopMock(m);

    // empty arguments string on a tool call
    cwd = freshCwd('c2c');
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'p2', type: 'function', function: { name: 'read_file', arguments: '' } }] },
      { role: 'assistant', content: 'PROTO-C-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    record('protocol: empty tool arguments -> error surfaced, no crash', tr(readLog(m.log), 'p2') && /Read error|Tool error|EISDIR/i.test(tr(readLog(m.log), 'p2').c), tr(readLog(m.log), 'p2') ? tr(readLog(m.log), 'p2').c : 'no result');
    stopMock(m);

    // emoji in model output passes through without crashing
    cwd = freshCwd('c2d');
    m = startMock([{ role: 'assistant', content: 'UNICODE-OK \u{1F600} done' }]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    record('protocol: emoji in reply does not crash', r.code === 0 && r.out.includes('UNICODE-OK'), r.out.substring(0, 100));
    stopMock(m);
  }
});
// tiny helper: raw one-shot mock returning garbage JSON body
function startProcess2(tag) {
  port += 1;
  const srv = spawn(NODE_BIN, ['-e', 'const http=require("http");http.createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{s.writeHead(200,{"Content-Type":"application/json"});s.end("[]")})}).listen(' + port + ',"127.0.0.1")'], { stdio: 'ignore' });
  return { child: srv, port, log: path.join(ROOT, 'mock-log-' + port + '.jsonl') };
}

// --- C3: junction (symlink) escape attack ---
scenarios.push({
  name: 'escape',
  fn: async () => {
    const cwd = freshCwd('c3');
    const outside = path.join(ROOT, 'c3-outside');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
    const link = path.join(cwd, 'jout');
    const mk = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside]);
    if (mk.status !== 0) { record('escape: junction created (test setup)', false, mk.stderr.toString()); return; }
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'j1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'jout/secret.txt' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'j2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'jout/evil.txt', content: 'pwned' }) } }] },
      { role: 'assistant', content: 'ESCAPE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    record('escape: read through junction BLOCKED', tr(log, 'j1') && tr(log, 'j1').c.includes('Path traversal blocked'), tr(log, 'j1') ? tr(log, 'j1').c : 'no result');
    record('escape: write through junction BLOCKED', tr(log, 'j2') && tr(log, 'j2').c.includes('Path traversal blocked') && !fs.existsSync(path.join(outside, 'evil.txt')), tr(log, 'j2') ? tr(log, 'j2').c : 'no result');
    stopMock(m);
    try { fs.rmSync(link, { recursive: true, force: true }); } catch (e) {}
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// --- C4: cron actually fires repeatedly, run count grows, delete validates id ---
scenarios.push({
  name: 'cron-fire',
  fn: async () => {
    const cwd = freshCwd('c4');
    const m = startMock([
      // a main call that returns tool_calls consumes TWO steps (call + post-tool call),
      // and every task's summary consumes one more
      { role: 'assistant', content: null, tool_calls: [{ id: 'cr1', type: 'function', function: { name: 'schedule_cron_tool', arguments: JSON.stringify({ schedule: '2s', command: 'echo fired >> cronfire.txt' }) } }] },
      { role: 'assistant', content: 'f1a' },
      { role: 'assistant', content: 'f1b' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'cr2', type: 'function', function: { name: 'cron_list_tool', arguments: '{}' } }] },
      { role: 'assistant', content: 'f2a' },
      { role: 'assistant', content: 'f2b' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'cr3', type: 'function', function: { name: 'cron_list_tool', arguments: '{}' } }] },
      { role: 'assistant', content: 'f3a' },
      { role: 'assistant', content: 'f3b' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000,
      stdinSteps: [
        { t: 'cron test\n', d: 100 }, { t: '/execute-task-now\n', d: 2500 },
        { t: 'list crons\n', d: 100 }, { t: '/execute-task-now\n', d: 4500 },
        { t: 'list crons again\n', d: 100 }, { t: '/execute-task-now\n', d: 4000 },
        { t: '/bye\n', d: 500 }
      ]
    });
    const log = readLog(m.log);
    const fireFile = path.join(cwd, 'cronfire.txt');
    const fired = fs.existsSync(fireFile) ? fs.readFileSync(fireFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const runsOf = (id) => {
      const res = tr(log, id);
      const match = res && res.c.match(/runs:\s*(\d+)/);
      return match ? parseInt(match[1], 10) : -1;
    };
    const runs2 = runsOf('cr2');
    const runs3 = runsOf('cr3');
    record('cron: job fires for real while session runs', fired >= 3, 'fileLines=' + fired);
    record('cron: live run count grows between listings', runs2 >= 1 && runs3 > runs2, 'runs@cr2=' + runs2 + ' runs@cr3=' + runs3);
    stopMock(m);
  }
});

// --- C5: task tool edges ---
scenarios.push({
  name: 'task-edges',
  fn: async () => {
    const cwd = freshCwd('c5');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task_create_tool', arguments: '{"command":"rm -rf /"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't2', type: 'function', function: { name: 'task_output_tool', arguments: '{"task_id":"task-nope"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't3', type: 'function', function: { name: 'task_get_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't4', type: 'function', function: { name: 'task_stop_tool', arguments: '{"task_id":"task-nope"}' } }] },
      { role: 'assistant', content: 'TASKEDGE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    record('task-edges: dangerous background command BLOCKED', tr(log, 't1') && tr(log, 't1').c.includes('BLOCKED: Super-dangerous'), tr(log, 't1') ? tr(log, 't1').c : 'no result');
    record('task-edges: bogus task id -> not found (output)', tr(log, 't2') && tr(log, 't2').c.includes('Task not found'), '');
    record('task-edges: no tasks -> not found (get)', tr(log, 't3') && tr(log, 't3').c.includes('Task not found'), '');
    record('task-edges: bogus task id -> not found (stop)', tr(log, 't4') && tr(log, 't4').c.includes('Task not found'), '');
    stopMock(m);
  }
});

// --- C6: /bye must not hang while a background task runs ---
scenarios.push({
  name: 'bye-hang',
  fn: async () => {
    const cwd = freshCwd('c6');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'bg1', type: 'function', function: { name: 'task_create_tool', arguments: JSON.stringify({ command: 'ping -n 30 127.0.0.1', description: 'long' }) } }] },
      { role: 'assistant', content: 'BG-STARTED' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 20000,
      stdinSteps: [
        { t: 'start long task\n', d: 100 }, { t: '/execute-task-now\n', d: 2500 },
        { t: '/bye\n', d: 12000 }
      ]
    });
    record('bye: /bye exits promptly with a 30s task running', r.code === 0 && r.elapsedMs < 17000 && r.out.includes('Goodbye'), 'exit=' + r.code + ' elapsed=' + Math.round(r.elapsedMs / 1000) + 's');
    stopMock(m);
  }
});

// --- C7: HTTP concurrency stress, no cross-talk ---
scenarios.push({
  name: 'stress',
  fn: async () => {
    const cwd = freshCwd('c7');
    const script = [];
    for (let i = 1; i <= 12; i++) script.push({ role: 'assistant', content: 'C7-MARKER-' + i });
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 300;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      // Under concurrency, main + summary calls interleave arbitrarily on the
      // shared mock, so we assert STRUCTURE instead of exact mapping: every
      // client response must be a distinct single marker (no cross-talk,
      // no duplicate assignment, no summary leakage).
      const reqs = [];
      for (let i = 0; i < 6; i++) {
        const isStream = i % 2 === 0;
        reqs.push(isStream
          ? httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'q' + i }] }).then(res => assembleSSE(res.body))
          : httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'q' + i }] }).then(res => { try { return JSON.parse(res.body).choices[0].message.content; } catch (e) { return 'BAD-JSON'; } }));
      }
      const received = await Promise.all(reqs);
      const distinct = new Set(received);
      const allMarkers = received.every(x => /^C7-MARKER-\d+$/.test(x));
      record('stress: 6 mixed concurrent requests, zero cross-talk', distinct.size === 6 && allMarkers, 'got=' + JSON.stringify(received));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- C8: filesystem edges ---
scenarios.push({
  name: 'fs-edges',
  fn: async () => {
    const cwd = freshCwd('c8');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a/b/c/d/e/f/g.txt', content: 'deep' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'f2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'crlf.txt', content: 'a\r\nb\r\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'f3', type: 'function', function: { name: 'read_file', arguments: '{"path":"crlf.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'f4', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'x'.repeat(300) + '.txt', content: 'x' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'f5', type: 'function', function: { name: 'read_file', arguments: '{"path":"bom.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'f6', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'ro.txt', content: 'attempt' }) } }] },
      { role: 'assistant', content: 'FSEDGE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(path.join(cwd, 'bom.txt'), '\uFEFFbom-content');
    fs.writeFileSync(path.join(cwd, 'ro.txt'), 'readonly');
    fs.chmodSync(path.join(cwd, 'ro.txt'), 0o444);
    let r;
    try {
      r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    } finally {
      try { fs.chmodSync(path.join(cwd, 'ro.txt'), 0o666); } catch (e) {}
    }
    const log = readLog(m.log);
    record('fs-edges: deep nested write works', fs.readFileSync(path.join(cwd, 'a/b/c/d/e/f/g.txt'), 'utf8') === 'deep', '');
    record('fs-edges: CRLF content byte-exact roundtrip', tr(log, 'f3') && tr(log, 'f3').c === 'a\r\nb\r\n', tr(log, 'f3') ? JSON.stringify(tr(log, 'f3').c) : 'no result');
    record('fs-edges: oversize filename error surfaced cleanly', tr(log, 'f4') && /error|Error/i.test(tr(log, 'f4').c) && r.out.includes('FSEDGE-DONE'), tr(log, 'f4') ? tr(log, 'f4').c.substring(0, 80) : 'no result');
    record('fs-edges: BOM file reads without crash', tr(log, 'f5') && tr(log, 'f5').c.includes('bom-content'), '');
    record('fs-edges: readonly file write error surfaced, no crash', tr(log, 'f6') && /error/i.test(tr(log, 'f6').c) && r.out.includes('FSEDGE-DONE'), tr(log, 'f6') ? tr(log, 'f6').c.substring(0, 80) : 'no result');
    stopMock(m);
  }
});

// --- C9: edit_file boundaries (separate file per edge to avoid interference) ---
scenarios.push({
  name: 'edit-edges',
  fn: async () => {
    const cwd = freshCwd('c9');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'e1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'n.txt', old_string: 'X', new_string: 'X' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'e2', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'd.txt', old_string: 'TAIL', new_string: '' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'e3', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'r.txt', old_string: 'HEAD', new_string: 'REPLACED-HEAD' }) } }] },
      { role: 'assistant', content: 'EDITEDGE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(path.join(cwd, 'n.txt'), 'HEADXTAIL');
    fs.writeFileSync(path.join(cwd, 'd.txt'), 'HEADTAIL');
    fs.writeFileSync(path.join(cwd, 'r.txt'), 'HEAD');
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    record('edit-edges: no-op edit (old==new) succeeds unchanged', tr(log, 'e1') && tr(log, 'e1').c.includes('[OK] Edited') && fs.readFileSync(path.join(cwd, 'n.txt'), 'utf8') === 'HEADXTAIL', '');
    record('edit-edges: empty new_string deletes', tr(log, 'e2') && fs.readFileSync(path.join(cwd, 'd.txt'), 'utf8') === 'HEAD', tr(log, 'e2') ? tr(log, 'e2').c : 'no result');
    record('edit-edges: whole-token replace', fs.readFileSync(path.join(cwd, 'r.txt'), 'utf8') === 'REPLACED-HEAD', 'final=' + JSON.stringify(fs.readFileSync(path.join(cwd, 'r.txt'), 'utf8')));
    stopMock(m);
  }
});

// --- C10: soak - 4 sequential tasks with repeated compression ---
scenarios.push({
  name: 'soak',
  fn: async () => {
    const cwd = freshCwd('c10');
    const big = 'SOAKPAYLOAD-'.repeat(70); // ~900 chars
    const script = [];
    for (let i = 1; i <= 4; i++) {
      script.push({ role: 'assistant', content: big + 'SOAK-TURN-' + i });
      script.push({ role: 'assistant', content: 'soak summary ' + i });
    }
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const steps = [];
    for (let i = 1; i <= 4; i++) {
      steps.push({ t: 'soak task ' + i + '\n', d: 100 });
      steps.push({ t: '/execute-task-now\n', d: 3500 });
    }
    steps.push({ t: '/bye\n', d: 500 });
    const r = await runCli({ port: m.port, args: [], env: { PERMISSION_MODE: 'bypass', CONTEXT_CHARS: '3000' }, cwd, stdinSteps: steps, timeoutMs: 60000 });
    const log = readLog(m.log);
    const mains = log.filter(x => x.stream === true);
    const compressions = log.filter(x => (x.messages || []).some(mm => String(mm.content || '').includes('[CONTEXT COMPRESSION]')));
    let allPairing = true;
    for (const req of log) if (!pairingValid(req.messages || [])) allPairing = false;
    const lastMain = mains[mains.length - 1];
    const lastSize = JSON.stringify(lastMain ? lastMain.messages : []).length;
    const tasksCompleted = (r.out.match(/7CODER\.md updated with complete summary/g) || []).length;
    record('soak: 4 sequential tasks all complete', tasksCompleted >= 4, 'completed=' + tasksCompleted);
    record('soak: compression engaged', compressions.length >= 1, 'compressed reqs=' + compressions.length);
    record('soak: tool/assistant pairing valid in every request', allPairing, '');
    record('soak: context stays bounded under compression', lastSize < 20000, 'last main req chars=' + lastSize);
    stopMock(m);
  }
});

// --- C11: backups in subdirectories + undo usage ---
scenarios.push({
  name: 'backup-sub',
  fn: async () => {
    const cwd = freshCwd('c11');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'u1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'sub/inner.txt', content: 'V1\n' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'u2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'sub/inner.txt', content: 'V2\n' }) } }] },
      { role: 'assistant', content: 'SUBWRITE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [
        { t: 'two writes\n', d: 100 }, { t: '/execute-task-now\n', d: 3500 },
        { t: '/undo\n', d: 400 }, { t: '/undo never.txt\n', d: 400 },
        { t: '/undo sub/inner.txt\n', d: 800 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const backups = fs.existsSync(path.join(cwd, '.7coder', 'backups')) ? require('child_process').execSync('dir /s /b "' + path.join(cwd, '.7coder', 'backups') + '" 2>nul', { shell: 'cmd.exe' }).toString() : '';
    record('backup-sub: subdir backup created', backups.replace(/\\/g, '/').includes('sub/inner.txt'), backups.substring(0, 120));
    record('backup-sub: /undo usage + missing-file messages', r.out.includes('Usage: /undo') && r.out.includes('No backup found'), '');
    record('backup-sub: /undo restores subdir file to V1', fs.readFileSync(path.join(cwd, 'sub/inner.txt'), 'utf8').includes('V1'), '');
    stopMock(m);
  }
});

// --- C12: protected-file normalization attempts ---
scenarios.push({
  name: 'protect-norm',
  fn: async () => {
    const cwd = freshCwd('c12');
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=NORMTEST\n');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'n1', type: 'function', function: { name: 'read_file', arguments: '{"path":".ENV"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'n2', type: 'function', function: { name: 'read_file', arguments: '{"path":"sub/../.env"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'n3', type: 'function', function: { name: 'write_file', arguments: '{"path":"sub/../.ENV","content":"X"}' } }] },
      { role: 'assistant', content: 'NORM-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    const warnings = (r.out.match(/reading protected file/g) || []).length;
    record('protect-norm: uppercase .ENV still protected (warn)', warnings >= 1 && tr(log, 'n1') && tr(log, 'n1').c.includes('NORMTEST'), 'warns=' + warnings);
    record('protect-norm: dot-dot path to .env still protected', warnings >= 2, 'warns=' + warnings);
    record('protect-norm: mixed-case write BLOCKED in bypass', tr(log, 'n3') && tr(log, 'n3').c.includes('BLOCKED: protected file') && fs.readFileSync(path.join(cwd, '.env'), 'utf8').includes('NORMTEST'), '');
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
  const pass = results.filter(r => r.pass).length;
  console.log('\n===== SUITE C SUMMARY: ' + pass + '/' + results.length + ' passed in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
  for (const f of results.filter(r => !r.pass)) console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
  process.exit(pass === results.length ? 0 : 1);
})();
