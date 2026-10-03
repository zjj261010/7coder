// Suite F: performance budgets, end-to-end user journey, crash recovery,
// client-disconnect resilience, strict OpenAI schema conformance,
// endpoint variants, key-brute-force, sub-agent long-conversation behavior.
// Usage: node test/runner-f.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// OPT-4: duplicated helpers now live in test/_shared.js (single implementation).
const S = require('./_shared').create({ suite: 'F', wsPrefix: 'w-f-' });
const { ROOT, IDX, NODE_BIN, RUN_ONLY, record, startProcessAt, freshCwd, runCli, httpReq, stopMock, readLog, toolResults, tr, rmrf } = S;
let port = 18250;
function startMock(scriptObj) { port += 1; return startProcessAt(port, 'mock-server.js', scriptObj); }
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

const scenarios = [];

// --- F1: performance budgets ---
scenarios.push({
  name: 'perf',
  fn: async () => {
    const cwd = freshCwd('f1');
    // AST-R1: padded past the 200-char summary floor so each of the 20 REPL
    // tasks below still fires its summary call and prints the update line.
    const m = startMock([{ role: 'assistant', content: 'PERF-OK ' + 'perf scenario reply padded past the summary floor. '.repeat(6) }]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    record('perf: cold startup + one-shot task under 4s', r.elapsedMs < 4000 && r.out.includes('PERF-OK'), 'elapsed=' + r.elapsedMs + 'ms firstOut=' + r.firstOutMs + 'ms');
    // stream first-byte latency via HTTP
    const srvPort = port + 270;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r2 => setTimeout(r2, 2500));
    try {
      const t0 = Date.now();
      let firstChunkMs = null;
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srvPort, method: 'POST', path: '/v1/chat/completions',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] })) } },
          res => {
            res.on('data', d => { if (firstChunkMs === null) firstChunkMs = Date.now() - t0; });
            res.on('end', resolve);
          });
        req.on('error', reject);
        req.write(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }));
        req.end();
      });
      record('perf: SSE first chunk under 2s (mock upstream)', firstChunkMs !== null && firstChunkMs < 2000, 'firstChunk=' + firstChunkMs + 'ms');
      // 20 sequential tasks, all complete, total time bounded
      const steps = [];
      for (let i = 0; i < 20; i++) { steps.push({ t: 'task ' + i + '\n', d: 60 }); steps.push({ t: '/execute-task-now\n', d: 550 }); }
      steps.push({ t: '/bye\n', d: 400 });
      const t1 = Date.now();
      const r20 = await runCli({
        port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd: freshCwd('f1b'), stdinSteps: steps, timeoutMs: 120000
      });
      const done20 = (r20.out.match(/7CODER\.md updated with complete summary/g) || []).length;
      const total = Date.now() - t1;
      record('perf: 20 sequential REPL tasks all complete under 25s', done20 >= 20 && total < 25000, 'completed=' + done20 + ' total=' + Math.round(total / 1000) + 's');
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- F2: end-to-end user journey: bootstrap project, fail test, fix, pass ---
scenarios.push({
  name: 'e2e-journey',
  fn: async () => {
    const cwd = freshCwd('f2');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'j1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'test.js', content: 'if (1 + 1 !== 3) { console.error("FAIL: math broken"); process.exit(1); } console.log("all tests passed");' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'j2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node test.js' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'j3', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'test.js', old_string: '1 + 1 !== 3', new_string: '1 + 1 !== 2' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'j4', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node test.js' }) } }] },
      { role: 'assistant', content: 'E2E-COMPLETE: project works' },
      { role: 'assistant', content: 'journey summary' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 'make a project that passes'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const log = readLog(m.log);
    const failRun = tr(log, 'j2');
    const passRun = tr(log, 'j4');
    record('journey: real test execution failed first', failRun && failRun.c.includes('FAIL: math broken'), failRun ? failRun.c.substring(0, 60) : 'no result');
    record('journey: edit fixed the logic', fs.readFileSync(path.join(cwd, 'test.js'), 'utf8').includes('1 + 1 !== 2'), '');
    record('journey: real test execution passed after fix', passRun && passRun.c.includes('all tests passed'), passRun ? passRun.c.substring(0, 60) : 'no result');
    record('journey: full loop completed', r.out.includes('E2E-COMPLETE') && r.code === 0, '');
    stopMock(m);
  }
});

// --- F3: crash mid-task -> clean recovery ---
scenarios.push({
  name: 'crash-recovery',
  fn: async () => {
    const cwd = freshCwd('f3');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'sl', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":60000}' } }] },
      { role: 'assistant', content: 'NEVER' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    // start REPL task and SIGKILL mid-tool
    const p = spawn(NODE_BIN, [IDX], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', PERMISSION_MODE: 'bypass' }),
      cwd
    });
    p.stdin.write('long task\n');
    await new Promise(r => setTimeout(r, 100));
    p.stdin.write('/execute-task-now\n');
    await new Promise(r => setTimeout(r, 3000));
    p.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 500));
    const mdBefore = fs.existsSync(path.join(cwd, '7CODER.md')) ? fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8') : null;
    record('crash: kill mid-task leaves 7CODER.md absent or intact (no partial file)', mdBefore === null || mdBefore.split('\n').filter(Boolean).every(l => l.startsWith('- ')), mdBefore ? mdBefore.substring(0, 60) : 'absent');
    // fresh process completes a task in the same workspace
    const m2 = startMock([
      { role: 'assistant', content: 'RECOVERED-OK' },
      { role: 'assistant', content: 'recovery summary' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m2.port, args: ['--prompt', 'recover'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    record('crash: fresh process works in the same workspace', r.out.includes('RECOVERED-OK') && r.code === 0, '');
    stopMock(m2);
    stopMock(m);
  }
});

// --- F4: sub-agent long conversation compresses inside the sub-agent (A4) ---
scenarios.push({
  name: 'subagent-long',
  fn: async () => {
    const cwd = freshCwd('f4');
    const big = 'BIGSUB-'.repeat(780); // ~5460 chars per tool result (capped at 3000)
    // Deterministic step order: main1 -> agent_tool; sub main1 -> sb0 tool; sub
    // main2 -> sb1 tool; then compression's light call fires before sub main3
    // (total ~13k > CONTEXT_CHARS 6000); sub main3 -> digest filler; main2 ->
    // F4-DONE; main summary. Fillers absorb any drift.
    const script = [
      { role: 'assistant', content: null, tool_calls: [{ id: 's0', type: 'function', function: { name: 'agent_tool', arguments: JSON.stringify({ name: 'digger', task: 'dig through files' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'sb0', type: 'function', function: { name: 'read_file', arguments: '{"path":"big0.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'sb1', type: 'function', function: { name: 'read_file', arguments: '{"path":"big1.txt"}' } }] },
      { role: 'assistant', content: 'dig filler' },
      { role: 'assistant', content: 'F4-DONE' },
      { role: 'assistant', content: 'F4-DONE' },
      { role: 'assistant', content: 'f4 summary' },
      { role: 'assistant', content: 'f4 filler' }
    ];
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(path.join(cwd, 'big0.txt'), big);
    fs.writeFileSync(path.join(cwd, 'big1.txt'), big);
    const r = await runCli({ port: m.port, args: ['--prompt', 'dig'], env: { PERMISSION_MODE: 'bypass', MAX_TOOL_RESULT_CHARS: '3000', CONTEXT_CHARS: '6000' }, cwd, timeoutMs: 60000 });
    const log = readLog(m.log);
    let pairing = true;
    for (const req of log) {
      const roles = (req.messages || []).map(x => x.role);
      for (let i = 0; i < roles.length; i++) {
        if (roles[i] === 'tool' && (i === 0 || (roles[i - 1] !== 'assistant' && roles[i - 1] !== 'tool'))) pairing = false;
      }
    }
    const compReqs = log.filter(x => (x.messages || []).some(mm => String(mm.content || '').includes('[CONTEXT COMPRESSION]')));
    record('subagent-long: sub-agent completes and returns its answer to main', tr(log, 's0') && tr(log, 's0').c.startsWith('Sub-agent'), tr(log, 's0') ? tr(log, 's0').c.substring(0, 60) : 'no result');
    record('subagent-long: compression fires INSIDE the sub-agent (A4 fixed)', compReqs.length >= 1 && compReqs.some(x => (x.messages || []).length >= 4), 'comp reqs=' + compReqs.length);
    record('subagent-long: pairing valid through nested conversation', pairing, '');
    record('subagent-long: context bounded under compression', log.every(x => JSON.stringify(x.messages || []).length < 20000), '');
    stopMock(m);
  }
});

// --- F5: client disconnect mid-stream -> server survives ---
scenarios.push({
  name: 'disconnect',
  fn: async () => {
    const cwd = freshCwd('f5');
    const script = [];
    for (let i = 0; i < 4; i++) script.push({ role: 'assistant', content: 'F5-REPLY-' + i });
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 280;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: srvPort, method: 'POST', path: '/v1/chat/completions',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] })) } },
          res => { res.once('data', () => { req.destroy(); resolve(); }); });
        req.on('error', () => resolve());
        req.write(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }));
        req.end();
      });
      await new Promise(r => setTimeout(r, 1200));
      const after = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'still alive' }] });
      record('disconnect: client abort mid-stream, server still serves', after.status === 200 && after.body.includes('F5-REPLY'), 'status=' + after.status);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- F5b: aborted stream cancels the run (no summary for a ghost client) ---
scenarios.push({
  name: 'disconnect-cancel',
  fn: async () => {
    const cwd = freshCwd('f5b');
    // long sleep tool so the abort lands mid-task; the run would normally
    // complete and write a summary afterwards
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'sl', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":4000}' } }] },
      { role: 'assistant', content: 'F5B-LATE' },
      { role: 'assistant', content: 'F5B summary' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 285;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: srvPort, method: 'POST', path: '/v1/chat/completions',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] })) } },
          res => { res.once('data', () => { req.destroy(); resolve(); }); });
        req.on('error', () => resolve());
        req.write(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }));
        req.end();
      });
      await new Promise(r => setTimeout(r, 9000)); // let the sleep finish + cancellation stop the run
      const md = fs.existsSync(path.join(cwd, '7CODER.md')) ? fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8') : null;
      record('disconnect-cancel: aborted run writes NO 7CODER.md summary', md === null || !md.includes('F5B summary'), md ? md.substring(0, 60) : 'absent (correct)');
      const after = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'alive' }] });
      record('disconnect-cancel: server healthy after cancellation', after.status === 200, 'status=' + after.status);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- F6: strict OpenAI schema conformance ---
scenarios.push({
  name: 'schema',
  fn: async () => {
    const cwd = freshCwd('f6');
    const m = startMock([{ role: 'assistant', content: 'SCHEMA-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 290;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const plain = JSON.parse((await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] })).body);
      record('schema: non-stream response fields conform', plain.object === 'chat.completion' && typeof plain.created === 'number'
        && Array.isArray(plain.choices) && plain.choices[0].index === 0 && plain.choices[0].message.role === 'assistant'
        && plain.choices[0].finish_reason === 'stop' && typeof plain.id === 'string' && plain.id.startsWith('chatcmpl-'), JSON.stringify(plain).substring(0, 120));
      const sse = (await httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] })).body;
      const lines = sse.split('\n').filter(l => l.startsWith('data:')).map(l => l.substring(5).trim());
      const lastData = lines[lines.length - 2];
      const chunks = lines.slice(0, -1).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      record('schema: SSE terminates with [DONE] exactly', lines[lines.length - 1] === '[DONE]', '');
      record('schema: chunk objects conform (object/delta/finish_reason)',
        chunks.length >= 2 && chunks.every(c => c.object === 'chat.completion.chunk' && c.choices && c.choices[0].index === 0)
        && chunks[chunks.length - 1].choices[0].finish_reason === 'stop', '');
      record('schema: content fully delivered across chunks', assembleSSE(sse) === 'SCHEMA-OK', '');
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- F7: OPENAI_ENDPOINT variants ---
scenarios.push({
  name: 'endpoint-variants',
  fn: async () => {
    // trailing slashes must be normalized
    const cwd = freshCwd('f7');
    const m2 = startMock([{ role: 'assistant', content: 'SLASH-OK-2' }]);
    await new Promise(r => setTimeout(r, 600));
    const p = spawn(NODE_BIN, [IDX, '--prompt', 't'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m2.port + '/v1///', MAX_RETRIES: '1', PERMISSION_MODE: 'bypass' }),
      cwd
    });
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => out += d.toString());
    await new Promise(resolve => p.on('close', resolve));
    record('endpoint: trailing slashes normalized', out.includes('SLASH-OK-2'), out.substring(0, 150));
    stopMock(m2);
  }
});

// --- F8: bad-key brute force then good key ---
scenarios.push({
  name: 'key-brute',
  fn: async () => {
    const cwd = freshCwd('f8');
    const m = startMock([{ role: 'assistant', content: 'F8-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 300;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort), HTTP_API_KEY: 'good-key' }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      let all401 = true;
      for (let i = 0; i < 5; i++) {
        const res = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'Bearer wrong' + i });
        if (res.status !== 401) all401 = false;
      }
      record('key: 5 bad keys all 401', all401, '');
      const good = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'Bearer good-key' });
      record('key: valid key works after brute-force attempts (no lockout corruption)', good.status === 200 && good.body.includes('F8-OK'), 'status=' + good.status);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// ====================== RUNNER ======================
S.runAll(scenarios);
