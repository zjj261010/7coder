// Suite F: performance budgets, end-to-end user journey, crash recovery,
// client-disconnect resilience, strict OpenAI schema conformance,
// endpoint variants, key-brute-force, sub-agent long-conversation behavior.
// Usage: node test/runner-f.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
// Child processes use the isolated shared harness.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pairingValid } = require('./_protocol');
const FCrash = require('./_f-crash-fixture');

// OPT-4: duplicated helpers now live in test/_shared.js (single implementation).
const S = require('./_shared').create({ suite: 'F', wsPrefix: 'w-f-' });
const { spawn, spawnSync, ROOT, IDX, NODE_BIN, RUN_ONLY, record, startProcessAt, freshCwd, runCli, httpReq, stopMock, readLog, toolResults, tr, rmrf } = S;
let port = 18250;
function startMock(scriptObj, env) { port += 1; return startProcessAt(port, 'mock-server.js', scriptObj, env); }
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
      // OP5-5: a task whose summary is identical to the previous one now ends
      // with 'summary unchanged - dedup' instead of a fresh write - both lines
      // prove the task's summary step ran, so count either.
      const done20 = (r20.out.match(/7CODER\.md updated with complete summary|summary unchanged - dedup/g) || []).length;
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

// --- F3: actual force-close while sleep is admitted, then same-workspace restart ---
scenarios.push({
  name: 'crash-recovery',
  fn: async () => {
    const cwd = freshCwd('f3'), file = path.join(cwd, '7CODER.md');
    fs.writeFileSync(file, FCrash.notes); fs.writeFileSync(file + '.7coder-prev', FCrash.previous);
    const m = startMock(FCrash.script, { MOCK_STRICT: '1' });
    const env = { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1',
      HEAVY_MODEL: FCrash.main, LIGHT_MODEL: FCrash.summary, SUMMARY_MODEL: FCrash.summary, PERMISSION_MODE: 'bypass',
      MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false',
      EXECUTION_TIMEOUT_MS: '90000', AUDIT_LOG: 'true' };
    let child, closed = false, output = '', code, signal;
    const begin = process.hrtime();
    async function until(predicate, label, allowClosed = false) {
      const end = Date.now() + 10000;
      while (Date.now() < end) { if (await predicate()) return; if (closed && !allowClosed) throw Error('F3 closed early: ' + output.slice(-2000)); await new Promise(resolve => setTimeout(resolve, 15)); }
      console.error(label + ': ' + output.slice(-2000));
      throw Error(label);
    }
    try {
      await until(async () => { if (m.child.exitCode !== null) throw Error('F3 mock exited'); try { return (await httpReq(m.port, 'GET', '/', null)).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'F3 mock not ready');
      child = spawn(NODE_BIN, [IDX], { cwd, env: Object.assign({}, process.env, env) });
      for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', value => { output = (output + value).slice(-16384); }); }
      child.stdin.on('error', () => {}); child.once('close', (value, why) => { code = value; signal = why; closed = true; });
      await until(() => output.includes('Commands:'), 'F3 REPL not ready');
      child.stdin.write(FCrash.crashPrompt + '\n/execute-task-now\n');
      await until(() => FCrash.admitted(readLog(m.log), output), 'F3 sleep dispatch not observed');
      record('crash: exact first model call reaches sleep dispatch before any completion', FCrash.admitted(readLog(m.log), output), '');
      const forced = child.kill('SIGKILL');
      await until(() => closed, 'F3 actual force-close unconfirmed', true);
      const elapsed = process.hrtime(begin), elapsedMs = elapsed[0] * 1000 + elapsed[1] / 1e6;
      record('crash: retained Agent handle acknowledges force and closes abnormally before natural sleep end', FCrash.forcedClose(forced, closed, code, signal, elapsedMs), 'exit=' + code + ' signal=' + signal + ' ms=' + Math.round(elapsedMs));
      record('crash: interrupted task preserves primary and distinct previous notes byte-for-byte',
        fs.readFileSync(file).equals(Buffer.from(FCrash.notes)) && fs.readFileSync(file + '.7coder-prev').equals(Buffer.from(FCrash.previous)) &&
        readLog(m.log).length === 1 && !readLog(path.join(cwd, '.7coder', 'audit.jsonl')).some(row => row.type === 'tool'), 'no completed tool or summary before restart');
      const recovered = await runCli({ port: m.port, args: ['--prompt', FCrash.recoverPrompt], env, cwd, timeoutMs: 15000 });
      record('crash: fresh process in same workspace completes exact new task and summary without old pending tool',
        FCrash.recovered(readLog(m.log)) && recovered.code === 0 && recovered.out.split(FCrash.reply).length === 2 &&
        !/MOCK_PROTOCOL|\[ERROR\]|Error writing to 7CODER|recovery required|EXECUTION_DEADLINE/.test(recovered.out), 'exit=' + recovered.code + ' requests=' + readLog(m.log).length);
      record('crash: restart commits one complete summary with byte-exact preceding notes backup',
        fs.readFileSync(file).equals(Buffer.from(FCrash.document)) && fs.readFileSync(file + '.7coder-prev').equals(Buffer.from(FCrash.notes)), '');
    } finally {
      if (child && !closed) { child.kill('SIGKILL'); await until(() => closed, 'F3 cleanup close unconfirmed', true); }
      stopMock(m);
    }
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
    const pairing = log.length > 0 && log.every(req => pairingValid(req.messages));
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
