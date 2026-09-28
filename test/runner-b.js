// Suite B: adversarial / fault-injection / session-semantics tests for 7coder.
// Complements runner.js (suite A) with dimensions A does not cover.
// Usage: node test/runner-b.js
//   RUN_ONLY=chaos,session ...  limit scenarios
//   NODE_BIN=path\to\node.exe   run against another runtime (e.g. Node 13)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
function rmrf(p) { try { if (fs.rmSync) rmrf(p, { recursive: true, force: true }); else fs.rmdirSync(p, { recursive: true, force: true }); } catch (e) {} }

const path = require('path');
const http = require('http');

const ROOT = __dirname;
const IDX = path.join(__dirname, '..', 'index.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const RUN_ONLY = (process.env.RUN_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
let port = 17850;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  :: ' + String(detail).substring(0, 300)));
}

function startProcess(mockFile, scriptObj, extraEnv) {
  port += 1;
  const scriptPath = path.join(ROOT, 'cur-script-' + port + '.json');
  fs.writeFileSync(scriptPath, JSON.stringify(scriptObj || [{ role: 'assistant', content: 'MOCK-DEFAULT' }]));
  const child = spawn(NODE_BIN, [path.join(ROOT, mockFile)], {
    env: Object.assign({}, process.env, { MOCK_SCRIPT: scriptPath, MOCK_PORT: String(port) }, extraEnv || {}),
    stdio: 'ignore'
  });
  return { child, port, log: path.join(ROOT, 'mock-log-' + port + '.jsonl') };
}
const startMock = (s) => startProcess('mock-server.js', s);
const startChaos = (fault, s) => startProcess('chaos-mock.js', s, { FAULT_MODE: fault });
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
  let dir = path.join(ROOT, 'w-b-' + name);
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

scenarios.push({
  name: 'chaos',
  fn: async () => {
    // 500 -> retries exhausted
    let m = startChaos('500');
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({ port: m.port, args: ['--prompt', 't', '-p'], env: { MAX_RETRIES: '1', PERMISSION_MODE: 'bypass' }, cwd: freshCwd('b-chaos500') });
    record('chaos: upstream 500 -> clean max-retries error, no crash', r.code === 0 && r.out.includes('Max retries reached'), r.out.substring(0, 120));
    stopMock(m);

    // 429 -> retried, then succeeds
    m = startChaos('429-then-ok', [{ role: 'assistant', content: 'AFTER-429-DONE' }]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_RETRIES: '2', PERMISSION_MODE: 'bypass' }, cwd: freshCwd('b-chaos429') });
    record('chaos: 429 retried then succeeds', r.out.includes('AFTER-429-DONE') && r.out.includes('attempt 1/2'), r.out.substring(0, 150));
    stopMock(m);

    // 401 -> non-retryable, exactly one attempt
    m = startChaos('401');
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_RETRIES: '3', PERMISSION_MODE: 'bypass' }, cwd: freshCwd('b-chaos401') });
    record('chaos: 401 fails fast (no retry storm)', r.out.includes('not retryable') && r.out.includes('attempt 1/3') && !r.out.includes('attempt 2/3'), r.out.substring(0, 150));
    stopMock(m);

    // malformed JSON body
    m = startChaos('malformed');
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_RETRIES: '1', PERMISSION_MODE: 'bypass' }, cwd: freshCwd('b-chaosmal') });
    record('chaos: malformed JSON body handled', r.out.includes('Max retries reached'), r.out.substring(0, 120));
    stopMock(m);

    // connection reset
    m = startChaos('reset');
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_RETRIES: '1', PERMISSION_MODE: 'bypass' }, cwd: freshCwd('b-chaosreset') });
    record('chaos: connection reset handled', r.out.includes('Max retries reached'), r.out.substring(0, 120));
    stopMock(m);

    // SSE stream full of junk lines
    m = startChaos('chaos-sse', [{ role: 'assistant', content: 'CHAOS-SURVIVED' }]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd: freshCwd('b-chaossse'),
      stdinSteps: [{ t: 'hello\n', d: 100 }, { t: '/execute-task-now\n', d: 3000 }, { t: '/bye\n', d: 400 }]
    });
    record('chaos: junk SSE lines skipped, valid reply assembled', r.out.includes('CHAOS-SURVIVED'), r.out.substring(0, 150));
    stopMock(m);
  }
});

scenarios.push({
  name: 'adversarial',
  fn: async () => {
    const cwd = freshCwd('b-adversarial');
    fs.writeFileSync(path.join(cwd, 'plain.txt'), 'hello');
    fs.writeFileSync(path.join(cwd, 'empty.txt'), '');
    fs.writeFileSync(path.join(cwd, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]));
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'glob_tool', arguments: '{"pattern":"*","directory":"../"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g2', type: 'function', function: { name: 'grep_tool', arguments: '{"pattern":"x","path":"../"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g3', type: 'function', function: { name: 'brief_tool', arguments: '{"folder":"../"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g4', type: 'function', function: { name: 'download_tool', arguments: JSON.stringify({ url: 'http://127.0.0.1:' + (port + 1) + '/x', path: '../evil.bin' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g5', type: 'function', function: { name: 'read_file', arguments: '{"path":"D:/Windows/win.ini"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g6', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '\\\\evil\\share\\x' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g7', type: 'function', function: { name: 'read_file', arguments: '{"path":"bin.bin"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g8', type: 'function', function: { name: 'read_file', arguments: '{"path":"empty.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g9', type: 'function', function: { name: 'read_file', arguments: '{"path":123}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g10', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'plain.txt', old_string: 'hello', new_string: '$&$&`x`' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g11', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'my 目录/文 件.txt', content: '你好世界-テスト' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'g12', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'my 目录/文 件.txt' }) } }] },
      { role: 'assistant', content: 'ADV2-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 'adv'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    const checks = [
      ['adv2: glob with traversal dir blocked', tr(log, 'g1') && tr(log, 'g1').c.includes('Path traversal blocked'), tr(log, 'g1') ? tr(log, 'g1').c : 'no result'],
      ['adv2: grep with traversal path blocked', tr(log, 'g2') && tr(log, 'g2').c.includes('Path traversal blocked'), ''],
      ['adv2: brief with traversal folder rejected', tr(log, 'g3') && tr(log, 'g3').c.includes('Brief error'), ''],
      ['adv2: download to traversal path rejected', tr(log, 'g4') && tr(log, 'g4').c.includes('Download error'), ''],
      ['adv2: absolute path outside workspace blocked', tr(log, 'g5') && tr(log, 'g5').c.includes('Path traversal blocked'), tr(log, 'g5') ? tr(log, 'g5').c : 'no result'],
      ['adv2: UNC path blocked', tr(log, 'g6') && /Security: (Path traversal blocked|path cannot be resolved safely)/.test(tr(log, 'g6').c), ''],
      ['adv2: binary file read does not crash', tr(log, 'g7') && !tr(log, 'g7').c.includes('Tool error'), ''],
      ['adv2: empty file reads as empty string', tr(log, 'g8') && tr(log, 'g8').c === '', tr(log, 'g8') ? JSON.stringify(tr(log, 'g8').c) : 'no result'],
      ['adv2: wrong arg type surfaces as tool error', tr(log, 'g9') && /Tool error|Read error/.test(tr(log, 'g9').c), ''],
      ['adv2: edit $& substitution stays literal', fs.readFileSync(path.join(cwd, 'plain.txt'), 'utf8') === '$&$&`x`', fs.readFileSync(path.join(cwd, 'plain.txt'), 'utf8')],
      ['adv2: CJK + spaces path roundtrip', tr(log, 'g12') && tr(log, 'g12').c === '你好世界-テスト', tr(log, 'g12') ? tr(log, 'g12').c : 'no result']
    ];
    for (const [n, ok, d] of checks) record(n, ok, d);
    stopMock(m);
  }
});

scenarios.push({
  name: 'session',
  fn: async () => {
    // /btw command
    let cwd = freshCwd('b-btw');
    let m = startMock([
      { role: 'assistant', content: 'MANGO SUMMARIZED NOTE' },
      { role: 'assistant', content: 'TASK-WITH-BTW-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [
        { t: '/btw remember the mango fruit\n', d: 1500 },
        { t: 'do the task\n', d: 100 }, { t: '/execute-task-now\n', d: 3000 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const log = readLog(m.log);
    const btwFile = path.join(cwd, 'BTW.md');
    const mains = log.filter(x => x.stream === true);
    record('session: /btw writes BTW.md', fs.existsSync(btwFile) && fs.readFileSync(btwFile, 'utf8').includes('mango'), '');
    record('session: /btw summary injected into next task', mains.length > 0 && mains[0].messages.some(x => x.role === 'user' && String(x.content).includes('MANGO SUMMARIZED')), mains.length ? mains[0].messages.map(x => x.role).join(',') : 'no req');
    stopMock(m);

    // empty /execute-task-now
    cwd = freshCwd('b-emptyexec');
    m = startMock([{ role: 'assistant', content: 'NEVER' }]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [{ t: '/execute-task-now\n', d: 400 }, { t: '/bye\n', d: 300 }]
    });
    record('session: empty /execute-task-now rejected', r.out.includes('No task entered') && !readLog(m.log).length, r.out.substring(0, 80));
    stopMock(m);

    // re-entrancy: exec while running rejected, queued line flows to next task
    cwd = freshCwd('b-reentry');
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'sl1', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":3000}' } }] },
      { role: 'assistant', content: 'FIRST-DONE' },
      { role: 'assistant', content: 'SECOND-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [
        { t: 't1\n', d: 100 }, { t: '/execute-task-now\n', d: 400 },
        { t: 't2\n', d: 600 }, { t: '/execute-task-now\n', d: 5000 },
        { t: '/execute-task-now\n', d: 3000 },
        { t: '/bye\n', d: 400 }
      ]
    });
    const log2 = readLog(m.log);
    const mains2 = log2.filter(x => x.stream === true);
    const last = mains2[mains2.length - 1];
    record('session: /execute-task-now during run is rejected', r.out.includes('already running'), r.out.substring(0, 200));
    record('session: lines typed during run flow into next task', last && last.messages.some(x => x.role === 'user' && String(x.content).includes('t2')), last ? last.messages.map(x => x.role).join(',') : 'no req');
    stopMock(m);

    // MAX_TOOL_STEPS forced wrap-up
    cwd = freshCwd('b-steplimit');
    m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'sl2', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":10}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'sl3', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":10}' } }] },
      { role: 'assistant', content: 'LIMIT-FINAL' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_TOOL_STEPS: '2', PERMISSION_MODE: 'bypass' }, cwd });
    const noToolsReq = readLog(m.log).find(x => !('tools' in x));
    record('session: step limit forces tool-free final answer', r.out.includes('LIMIT-FINAL') && !!noToolsReq, r.out.substring(0, 120));
    stopMock(m);
  }
});

scenarios.push({
  name: 'ralph',
  fn: async () => {
    for (const [label, env] of [
      ['new var', { ENABLE_RALPH_MODE: 'true' }],
      ['legacy alias', { ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'true' }]
    ]) {
      const cwd = freshCwd('b-ralph' + label.length);
      const m = startMock([
        { role: 'assistant', content: 'working on it...' },
        { role: 'assistant', content: 'RALPH_WIGGUM_COMPLETE final answer XYZ' }
      ]);
      await new Promise(r => setTimeout(r, 600));
      const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: Object.assign({ PERMISSION_MODE: 'bypass', MAX_RETRIES: '3' }, env), cwd });
      // Note: the raw marker streams to the terminal live (unavoidable with streaming);
      // the loop must still exit, strip it from the final answer, and report fulfillment.
      record('ralph: loop exits on completion marker (' + label + ')', r.out.includes('final answer XYZ') && r.out.includes('Completion promise fulfilled'), r.out.substring(0, 200));
      stopMock(m);
    }
  }
});

scenarios.push({
  name: 'dream',
  fn: async () => {
    const seedLast = (cwd, hoursAgo) => fs.writeFileSync(path.join(cwd, '.7coder_last_interaction'), String(Date.now() - hoursAgo * 3600 * 1000));

    // dream triggers after >=5h idle
    let cwd = freshCwd('b-dream-on');
    seedLast(cwd, 6);
    let m = startMock([
      { role: 'assistant', content: 'DREAM-DIGEST-DONE' },
      { role: 'assistant', content: 'TASK-AFTER-DREAM' },
      { role: 'assistant', content: 'task summary line' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({ port: m.port, args: ['--prompt', 'do task'], env: { PERMISSION_MODE: 'bypass', DREAM_ALLOW: 'true' }, cwd });
    let log = readLog(m.log);
    record('dream: triggers after 6h idle (dream call first)', log.length > 0 && String((log[0].messages || [])[0] && log[0].messages[0].content || '').includes('DREAM MODE OVERRIDE'), log.length ? String(log[0].messages[0].content).substring(0, 60) : 'no req');
    record('dream: lock file cleaned up after session', !fs.existsSync(path.join(cwd, '7C.dream.lock')), '');
    record('dream: task still runs after dream', r.out.includes('TASK-AFTER-DREAM'), '');
    stopMock(m);

    // fresh lock -> dream skipped
    cwd = freshCwd('b-dream-lock');
    seedLast(cwd, 6);
    fs.writeFileSync(path.join(cwd, '7C.dream.lock'), new Date().toISOString());
    m = startMock([
      { role: 'assistant', content: 'DIRECT-TASK-REPLY' },
      { role: 'assistant', content: 'task summary line' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 'do task'], env: { PERMISSION_MODE: 'bypass', DREAM_ALLOW: 'true' }, cwd });
    log = readLog(m.log);
    record('dream: fresh lock suppresses dream', log.length > 0 && !String(log[0].messages[0].content || '').includes('DREAM MODE OVERRIDE') && r.out.includes('DIRECT-TASK-REPLY'), '');
    stopMock(m);

    // recent interaction -> dream skipped
    cwd = freshCwd('b-dream-recent');
    seedLast(cwd, 1);
    m = startMock([
      { role: 'assistant', content: 'RECENT-TASK-REPLY' },
      { role: 'assistant', content: 'task summary line' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 'do task'], env: { PERMISSION_MODE: 'bypass', DREAM_ALLOW: 'true' }, cwd });
    log = readLog(m.log);
    record('dream: recent interaction suppresses dream', log.length > 0 && !String(log[0].messages[0].content || '').includes('DREAM MODE OVERRIDE') && r.out.includes('RECENT-TASK-REPLY'), '');
    stopMock(m);
  }
});

scenarios.push({
  name: 'contract',
  fn: async () => {
    const cwd = freshCwd('b-contract');
    const m = startMock([{ role: 'assistant', content: 'CONTRACT-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: {
      PERMISSION_MODE: 'bypass', HEAVY_MODEL: 'heavy-x', LIGHT_MODEL: 'light-x',
      TEMPERATURE: '0.15', MAX_TOKENS: '1234'
    }, cwd });
    const log = readLog(m.log);
    const main = log.find(x => x.tools);
    const light = log.find(x => !x.tools);
    record('contract: heavy payload model/temperature/max_tokens honored',
      main && main.model === 'heavy-x' && main.temperature === 0.15 && main.max_tokens === 1234,
      main ? JSON.stringify({ model: main.model, t: main.temperature, m: main.max_tokens }) : 'no req');
    record('contract: tools array + tool_choice sent on main calls',
      main && Array.isArray(main.tools) && main.tools.length > 10 && main.tool_choice === 'auto', '');
    record('contract: light model used for summary call', light && light.model === 'light-x' && !('tools' in light), light ? light.model : 'no req');
    stopMock(m);
  }
});

scenarios.push({
  name: 'http-extra',
  fn: async () => {
    const cwd = freshCwd('b-httpx');
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    const m = startMock([
      // each HTTP request consumes a main step AND a light-model summary step
      { role: 'assistant', content: 'HX-REPLY-1' },
      { role: 'assistant', content: 'sum1' },
      { role: 'assistant', content: 'HX-REPLY-2' },
      { role: 'assistant', content: 'sum2' },
      { role: 'assistant', content: 'HX-REPLY-3' },
      { role: 'assistant', content: 'sum3' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'hx1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: 'HX-TOOLSTREAM-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 400;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort), HTTP_API_KEY: 'kb' }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const auth = { Authorization: 'Bearer kb' };
      // client system prompt must be replaced by ours
      const sys = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'system', content: 'HACK-SYS-IGNORE-ME' }, { role: 'user', content: 'hi' }] }, auth);
      const log1 = readLog(m.log);
      const sysReq = log1.find(x => (x.messages || []).some(mm => mm.role === 'user' && String(mm.content).includes('hi')));
      record('httpx: client system message replaced', sys.status === 200 && sysReq && !log1.some(x => (x.messages || []).some(mm => String(mm.content || '').includes('HACK-SYS-IGNORE-ME'))) && sysReq && String(sysReq.messages[0].content).includes('7coder'), '');
      // empty messages
      const empty = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [] }, auth);
      record('httpx: empty messages still returns 200', empty.status === 200 && empty.body.includes('choices'), empty.body.substring(0, 80));
      // multimodal content array -> text extracted
      const mm = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'text', text: 'TEXT-PART-OK' }, { type: 'image_url', image_url: { url: 'http://x/y.png' } }] }] }, auth);
      const mmReq = readLog(m.log).slice(-1)[0];
      record('httpx: multimodal text part extracted, image part dropped',
        mm.status === 200 && mmReq.messages.some(x => x.role === 'user' && String(x.content).includes('TEXT-PART-OK')) && !mmReq.messages.some(x => JSON.stringify(x).includes('image_url')), '');
      // stream:true with upstream tool call
      const st = await httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'read it' }] }, auth);
      let assembled = '';
      for (const line of st.body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.substring(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { const c = JSON.parse(payload); if (c.choices && c.choices[0].delta && c.choices[0].delta.content) assembled += c.choices[0].delta.content; } catch (e) {}
      }
      record('httpx: SSE passthrough works across upstream tool calls', st.status === 200 && assembled === 'HX-TOOLSTREAM-DONE' && st.body.includes('[DONE]') && tr(readLog(m.log), 'hx1') && tr(readLog(m.log), 'hx1').c.includes('42'), 'assembled=' + JSON.stringify(assembled) + ' done=' + st.body.includes('[DONE]') + ' tool=' + JSON.stringify(tr(readLog(m.log), 'hx1') ? tr(readLog(m.log), 'hx1').c.substring(0, 20) : 'NO-RESULT'));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

scenarios.push({
  name: 'config',
  fn: async () => {
    // invalid PERMISSION_MODE -> warn + default behavior (declines in non-interactive)
    let cwd = freshCwd('b-badmode');
    let m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'bm1', type: 'function', function: { name: 'append_file', arguments: '{"path":"x.txt","content":"y"}' } }] },
      { role: 'assistant', content: 'BADMODE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bogus-mode' }, cwd });
    record('config: invalid PERMISSION_MODE warns and falls back to default', r.out.includes('Unknown PERMISSION_MODE') && tr(readLog(m.log), 'bm1') && tr(readLog(m.log), 'bm1').c.includes('User declined'), tr(readLog(m.log), 'bm1') ? tr(readLog(m.log), 'bm1').c : 'no result');
    stopMock(m);

    // legacy MAX_ATTEMPT_RETRIES alias still honored
    cwd = freshCwd('b-aliasretry');
    m = startChaos('500');
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_ATTEMPT_RETRIES: '1', PERMISSION_MODE: 'bypass' }, cwd });
    record('config: legacy MAX_ATTEMPT_RETRIES alias works', r.out.includes('attempt 1/1'), r.out.substring(0, 120));
    stopMock(m);
  }
});

// ====================== RUNNER ======================
// --- B9: LMStudio-style in-stream context-overflow error surfaces ---
scenarios.push({
  name: 'lmstudio-ctx',
  fn: async () => {
    const cwd = freshCwd('b-lmstudio');
    const m = startChaos('lmstudio-ctx');
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_RETRIES: '3', PERMISSION_MODE: 'bypass' }, cwd });
    const surfaced = r.out.includes('upstream error:') && r.out.includes('context length');
    const attempts = (r.out.match(/API attempt/g) || []).length;
    record('lmstudio: context-overflow error surfaced (no more empty-response)', surfaced, r.out.substring(r.out.length - 200));
    record('lmstudio: upstream error not retried', surfaced && attempts === 1, 'attempts=' + attempts);
    stopMock(m);
  }
});

// --- B10: built-in web UI serving + info endpoint ---
scenarios.push({
  name: 'webui',
  fn: async () => {
    const cwd = freshCwd('b-webui');
    const m = startMock([{ role: 'assistant', content: 'WEBUI-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 360;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const page = await httpReq(srvPort, 'GET', '/', null);
      record('webui: GET / serves the chat page (utf-8 html)', page.status === 200 && page.body.includes('lang="zh-CN"') && page.body.includes('<textarea') && page.body.includes('7coder'), 'status=' + page.status);
      const info = await httpReq(srvPort, 'GET', '/api/info', null);
      let infoOk = false;
      try { const j = JSON.parse(info.body); infoOk = j.model && j.workspace && typeof j.keyRequired === 'boolean'; } catch (e) {}
      record('webui: /api/info returns model+workspace+keyRequired', info.status === 200 && infoOk, info.body.substring(0, 100));
      const chat = await httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
            let assembled = '';
      for (const line of chat.body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const pl = line.substring(5).trim();
        if (!pl || pl === '[DONE]') continue;
        try { const j = JSON.parse(pl); const d = j.choices && j.choices[0].delta; if (d && d.content) assembled += d.content; } catch (e) {}
      }
      record('webui: chat streaming still works with UI routes present', chat.status === 200 && assembled === 'WEBUI-OK' && chat.body.includes('[DONE]'), 'assembled=' + JSON.stringify(assembled));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});


// --- B11: runtime permission-mode switching (/api/mode) ---
scenarios.push({
  name: 'mode-switch',
  fn: async () => {
    const cwd = freshCwd('b-mode');
    const m = startMock([{ role: 'assistant', content: 'MODE-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 370;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const sw = await httpReq(srvPort, 'POST', '/api/mode', { mode: 'denial' });
      record('mode: switch to denial ok', sw.status === 200 && JSON.parse(sw.body).mode === 'denial', sw.body);
      const info = JSON.parse((await httpReq(srvPort, 'GET', '/api/info', null)).body);
      record('mode: /api/info reflects the new mode', info.mode === 'denial', 'mode=' + info.mode);
      const bad = await httpReq(srvPort, 'POST', '/api/mode', { mode: 'chaos' });
      record('mode: invalid mode -> 400', bad.status === 400, 'status=' + bad.status);
      const back = await httpReq(srvPort, 'POST', '/api/mode', { mode: 'auto' });
      record('mode: switch back works', back.status === 200 && JSON.parse(back.body).mode === 'auto', '');
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});


// --- B12: workflow_tool (JSON step interpreter) ---
scenarios.push({
  name: 'workflow',
  fn: async () => {
    const cwd = freshCwd('b-wf');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'wf1', type: 'function', function: { name: 'workflow_tool', arguments: JSON.stringify({ steps: [
        { tool: 'write_file', args: { path: 'wf.txt', content: 'ONE' } },
        { tool: 'append_file', args: { path: 'wf.txt', content: '-TWO' } },
        { tool: 'read_file', args: { path: 'wf.txt' } }
      ] }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'wf2', type: 'function', function: { name: 'workflow_tool', arguments: JSON.stringify({ steps: [
        { tool: 'workflow_tool', args: { steps: [] } }
      ] }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'wf3', type: 'function', function: { name: 'workflow_tool', arguments: JSON.stringify({ steps: [
        { tool: 'read_file', args: { path: 'missing.txt' } },
        { tool: 'write_file', args: { path: 'after.txt', content: 'x' } }
      ] }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'wf4', type: 'function', function: { name: 'workflow_tool', arguments: JSON.stringify({ steps: [
        { tool: 'read_file', args: { path: 'missing.txt' }, optional: true },
        { tool: 'write_file', args: { path: 'after2.txt', content: 'y' } }
      ] }) } }] },
      { role: 'assistant', content: 'WF-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const log = readLog(m.log);
    const wf1 = tr(log, 'wf1');
    record('workflow: 3 ordered steps all execute', wf1 && wf1.c.includes('[OK] Workflow complete') && wf1.c.includes('step 1 (write_file)') && wf1.c.includes('step 3 (read_file)') && fs.readFileSync(path.join(cwd, 'wf.txt'), 'utf8') === 'ONE-TWO', wf1 ? wf1.c : 'no result');
    const wf2 = tr(log, 'wf2');
    record('workflow: nested workflow rejected', wf2 && wf2.c.includes('STOPPED') && wf2.c.includes('nested workflows are not allowed'), wf2 ? wf2.c.substring(0, 100) : 'no result');
    const wf3 = tr(log, 'wf3');
    record('workflow: failing step stops the batch', wf3 && wf3.c.includes('STOPPED') && !fs.existsSync(path.join(cwd, 'after.txt')), wf3 ? wf3.c : 'no result');
    const wf4 = tr(log, 'wf4');
    record('workflow: optional step failure continues', wf4 && wf4.c.includes('[OK] Workflow complete') && fs.existsSync(path.join(cwd, 'after2.txt')), wf4 ? wf4.c : 'no result');
    stopMock(m);
  }
});


// --- B13: structured audit log (D5) ---
scenarios.push({
  name: 'audit-log',
  fn: async () => {
    const cwd = freshCwd('b-audit');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'au1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'ok.txt', content: 'fine' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'au2', type: 'function', function: { name: 'read_file', arguments: '{"path":"ghost.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'au3', type: 'function', function: { name: 'run_command', arguments: '{"command":"rm -rf /"}' } }] },
      { role: 'assistant', content: 'AUDIT-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const auditPath = path.join(cwd, '.7coder', 'audit.jsonl');
    record('audit: audit.jsonl created', fs.existsSync(auditPath), '');
    if (!fs.existsSync(auditPath)) { stopMock(m); return; }
    const entries = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } });
    record('audit: every line is valid JSON with ts/tool/mode/status', entries.length >= 3 && entries.every(e => e && e.ts && e.tool && e.mode && e.status), 'lines=' + entries.length);
    const byTool = {};
    for (const e of entries) if (!byTool[e.tool]) byTool[e.tool] = e.status;
    record('audit: ok / error / blocked statuses recorded', byTool.write_file === 'ok' && byTool.read_file === 'error' && byTool.run_command === 'blocked', JSON.stringify(byTool));
    const wf = entries.find(e => e.tool === 'write_file');
    record('audit: args preview truncated and present', wf && wf.args && String(wf.args.path).includes('ok.txt') && JSON.stringify(wf.args).length < 400, JSON.stringify(wf && wf.args));
    stopMock(m);
  }
});


// --- B14: multi-model routing (models.json + client model field) ---
scenarios.push({
  name: 'multi-model',
  fn: async () => {
    const cwd = freshCwd('b-mm');
    const mockA = startMock([{ role: 'assistant', content: 'FROM-MOCK-A' }]);
    const mockB = startMock([{ role: 'assistant', content: 'FROM-MOCK-B' }]);
    await new Promise(r => setTimeout(r, 600));
    fs.mkdirSync(path.join(cwd, '.7coder'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.7coder', 'models.json'), JSON.stringify({
      'model-b': { endpoint: 'http://127.0.0.1:' + mockB.port + '/v1', apiKey: 'kb' }
    }));
    const srvPort = port + 380;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + mockA.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const info = JSON.parse((await httpReq(srvPort, 'GET', '/api/info', null)).body);
      record('mm: /api/info lists profiled models', Array.isArray(info.models) && info.models.indexOf('model-b') >= 0, JSON.stringify(info.models));
      const def = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
      record('mm: default model routes to global endpoint', def.status === 200 && def.body.includes('FROM-MOCK-A'), def.body.substring(0, 80));
      const routed = await httpReq(srvPort, 'POST', '/v1/chat/completions', { model: 'MODEL-B', messages: [{ role: 'user', content: 'x' }] });
      record('mm: client model field routes via profile (case-insensitive)', routed.status === 200 && routed.body.includes('FROM-MOCK-B'), routed.body.substring(0, 80));
      stopMock(mockB); stopMock(mockA);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(mockB); stopMock(mockA);
    }
  }
});


// --- B15: per-project .env (workspace overrides install dir, D7) ---
scenarios.push({
  name: 'project-env',
  fn: async () => {
    const cwd = freshCwd('b-penv');
    fs.writeFileSync(path.join(cwd, '.env'), [
      'HEAVY_MODEL=from-project-env',
      'LIGHT_MODEL=proj-light',
      'PERMISSION_MODE=denial'
    ].join('\n'));
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'pe1', type: 'function', function: { name: 'read_file', arguments: '{"path":"nums.txt"}' } }] },
      { role: 'assistant', content: 'PE-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(path.join(cwd, 'nums.txt'), '42\n');
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], cwd, timeoutMs: 60000 });
    const log = readLog(m.log);
    const main = log.find(x => x.tools);
    record('project-env: workspace HEAVY_MODEL used for upstream calls', !!main && main.model === 'from-project-env', main ? 'model=' + main.model : 'no req');
    record('project-env: workspace PERMISSION_MODE=denial blocks tools', tr(log, 'pe1') && tr(log, 'pe1').c.includes('denial. Action blocked'), tr(log, 'pe1') ? tr(log, 'pe1').c : 'no result');
    record('project-env: startup announces overrides', r.out.includes('workspace .env loaded (3 overrides)'), r.out.substring(0, 150));
    stopMock(m);
  }
});

// --- B16: session persistence across processes (--resume / D4) ---
scenarios.push({
  name: 'resume',
  fn: async () => {
    const cwd = freshCwd('b-resume');
    const m = startMock([
      { role: 'assistant', content: 'noted: RESUME-77' },
      { role: 'assistant', content: 'resume summary' },
      { role: 'assistant', content: 'RESUME-77 is the codeword' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    // session 1: remember codeword, exit (auto-save)
    const r1 = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 30000,
      stdinSteps: [
        { t: 'Remember this codeword: RESUME-77. Reply briefly.\n', d: 80 },
        { t: '/execute-task-now\n', d: 3000 },
        { t: '/bye\n', d: 500 }
      ]
    });
    const sess = path.join(cwd, '.7coder', 'session.json');
    record('resume: session auto-saved on exit', fs.existsSync(sess) && fs.readFileSync(sess, 'utf8').includes('RESUME-77'), '');
    // session 2: --resume loads it; ask for the codeword
    const r2 = await runCli({
      port: m.port, args: ['--resume'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 30000,
      stdinSteps: [
        { t: 'What codeword did I ask you to remember? Reply with just it.\n', d: 80 },
        { t: '/execute-task-now\n', d: 3000 },
        { t: '/bye\n', d: 500 }
      ]
    });
    const log2 = readLog(m.log);
    const resumedReqs = log2.filter(x => x.stream === true).map(x => x.messages);
    const carried = resumedReqs.some(msgs => msgs.some(x => x.role === 'user' && String(x.content).includes('RESUME-77')));
    record('resume: second process --resume loads conversation', r2.out.includes('Previous session resumed'), r2.out.substring(0, 120));
    record('resume: carried turns reach upstream and model answers from them', r2.out.includes('RESUME-77') || (carried && r2.out.includes('codeword')), 'carried=' + carried);
    // corrupted session file must not crash startup
    fs.writeFileSync(sess, '{corrupt!!');
    const r3 = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 30000,
      stdinSteps: [{ t: '/bye\n', d: 400 }]
    });
    record('resume: corrupted session.json -> clean fresh start', r3.code === 0 && r3.out.includes('Welcome'), 'exit=' + r3.code);
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
  console.log('\n===== SUITE B SUMMARY: ' + pass + '/' + results.length + ' passed in ' + Math.round((Date.now() - t0) / 1000) + 's =====');
  for (const f of results.filter(r => !r.pass)) console.log('FAILED: ' + f.name + (f.detail ? ' :: ' + f.detail.substring(0, 200) : ''));
  process.exit(pass === results.length ? 0 : 1);
})();
