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
const FJourney = require('./_f-journey-fixture');
const FSubagent = require('./_f-subagent-fixture');
const FDisconnect = require('./_f-disconnect-fixture');
const FPerf = require('./_f-perf-fixture');
const { create: createEndpoint, parseSSE } = require('./_endpoint');

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
    const m = startMock(FPerf.startupScript, { MOCK_STRICT: '1' });
    let roundsMock, H, child, closed = false, code, output = '';
    const env = { PERMISSION_MODE: 'bypass', HEAVY_MODEL: FPerf.main, LIGHT_MODEL: FPerf.summary, SUMMARY_MODEL: FPerf.summary,
      MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false',
      AUDIT_LOG: 'true', CONTEXT_CHARS: '200000', EXECUTION_TIMEOUT_MS: '10000' };
    const elapsed = start => { const delta = process.hrtime(start); return delta[0] * 1000 + delta[1] / 1e6; };
    async function until(predicate, label, allowClosed) {
      const start = process.hrtime();
      while (elapsed(start) < 10000) { if (await predicate()) return; if (closed && !allowClosed) throw Error('F1 closed early: ' + output.slice(-2000)); await new Promise(r => setTimeout(r, 10)); }
      throw Error(label + ': ' + output.slice(-2000));
    }
    async function ready(mock) { await until(async () => { if (mock.child.exitCode !== null) throw Error('F1 fixture exited'); try { return (await httpReq(mock.port, 'GET', '/', null)).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'F1 fixture readiness'); }
    try {
      await ready(m);
      const cold = await runCli({ port: m.port, args: ['--prompt', FPerf.coldPrompt], env, cwd: freshCwd('f1-cold'), timeoutMs: 10000 });
      record('perf: actual cold CLI completes exact short reply with exit zero under 4s', cold.code === 0 && cold.out.split(FPerf.coldReply).length === 2 && FPerf.within(cold.elapsedMs, 4000), 'elapsed=' + cold.elapsedMs + 'ms exit=' + cold.code);
      H = createEndpoint({ suite: 'F1-http', endpoint: 'http://127.0.0.1:' + m.port, key: '', model: FPerf.main, permissionMode: 'bypass' });
      await H.start(freshCwd('f1-http'));
      let firstBodyMs = null;
      const stream = await new Promise((resolve, reject) => {
        const start = process.hrtime(), body = JSON.stringify({ stream: true, messages: [{ role: 'user', content: FPerf.httpPrompt }] });
        let response, text = '', settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { if (response) response.destroy(); req.destroy(); reject(error); } else resolve(value); };
        const req = http.request({ host: '127.0.0.1', port: H.port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
          response = res; res.setEncoding('utf8');
          res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 65536) { finish(Error('F1 stream budget')); return; }
            if (firstBodyMs === null && text.split('\n').some(line => { try { const event = JSON.parse(line.slice(6)); return line.startsWith('data: ') && event.choices[0].delta.content && FPerf.httpReply.startsWith(event.choices[0].delta.content); } catch (e) { return false; } })) firstBodyMs = elapsed(start);
          });
          res.on('error', finish); res.on('aborted', () => finish(Error('F1 stream aborted')));
          res.on('end', () => { try { if (res.statusCode !== 200) throw Error('F1 HTTP ' + res.statusCode); finish(null, parseSSE(text)); } catch (e) { finish(e); } });
        });
        const timer = setTimeout(() => finish(Error('F1 stream deadline')), 5000); req.on('error', finish); req.end(body);
      });
      record('perf: first actual assistant content under 2s with complete exact SSE and DONE', FPerf.within(firstBodyMs, 2000) && stream.content === FPerf.httpReply && stream.tools.length === 0, 'firstBody=' + firstBodyMs + 'ms');
      record('perf: cold and HTTP stages consume exactly their own two model requests', FPerf.startup(readLog(m.log)), '');
      await H.stop(); H.S.cleanup(); H = null;

      roundsMock = startMock(FPerf.script, { MOCK_STRICT: '1' }); await ready(roundsMock);
      const cwd = freshCwd('f1-rounds'), file = path.join(cwd, '7CODER.md'), runtime = path.join(cwd, '.7coder', 'runtime.jsonl');
      const start = process.hrtime();
      child = spawn(NODE_BIN, [IDX], { cwd, env: Object.assign({}, process.env, env, { OPENAI_API_KEY: 'fixture', OPENAI_ENDPOINT: 'http://127.0.0.1:' + roundsMock.port + '/v1' }) });
      for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
      child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', value => { code = value; closed = true; });
      await until(() => output.includes('Commands:'), 'F1 REPL readiness');
      for (let i = 0; i < FPerf.count; i++) {
        child.stdin.write(FPerf.tasks[i] + '\n/execute-task-now\n');
        await until(() => readLog(runtime).filter(row => row.scope === 'cli-task').length >= i + 1, 'F1 round ' + (i + 1) + ' terminal');
        if (readLog(runtime).some(row => row.scope === 'cli-task' && row.status !== 'ok')) throw Error('F1 actual task failure: ' + output.slice(-2000));
      }
      child.stdin.end('/bye\n'); await until(() => closed, 'F1 normal REPL close', true);
      const total = elapsed(start), log = readLog(roundsMock.log);
      record('perf: twenty unique REPL tasks preserve full main history and exact summary requests', FPerf.transcript(log), 'requests=' + log.length);
      record('perf: twenty terminal successes and each complete reply exactly once before exit zero', FPerf.terminal(readLog(runtime)) && FPerf.output(output, code), 'exit=' + code);
      record('perf: final worklog contains all twenty exact independent summaries', fs.readFileSync(file, 'utf8') === FPerf.document(20), '');
      record('perf: previous worklog snapshot contains exactly the first nineteen summaries', fs.readFileSync(file + '.7coder-prev', 'utf8') === FPerf.document(19), '');
      record('perf: actual startup plus twenty gated tasks and normal close under 25s', FPerf.within(total, 25000), 'total=' + Math.round(total) + 'ms');
    } finally {
      if (child && !closed) { child.kill(); await until(() => closed, 'F1 cleanup close unconfirmed', true); }
      if (H) { await H.stop(); H.S.cleanup(); }
      stopMock(roundsMock);
      stopMock(m);
    }
  }
});

// --- F2: exact create/fail/edit/pass journey with real commands ---
scenarios.push({
  name: 'e2e-journey',
  fn: async () => {
    const cwd = freshCwd('f2'), fixture = FJourney.create(NODE_BIN);
    const m = startMock(fixture.script, { MOCK_STRICT: '1' });
    try {
      const end = Date.now() + 5000;
      let ready = false;
      while (Date.now() < end) {
        if (m.child.exitCode !== null) throw Error('F2 mock exited before ready');
        try { if ((await httpReq(m.port, 'GET', '/', null)).status === 200) { ready = true; break; } }
        catch (e) { if (e.code !== 'ECONNREFUSED') throw e; }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      if (!ready) throw Error('F2 mock readiness deadline');
      const r = await runCli({ port: m.port, args: ['--prompt', fixture.prompt], env: { PERMISSION_MODE: 'bypass',
        HEAVY_MODEL: fixture.model, LIGHT_MODEL: 'f-journey-unused-summary', SUMMARY_MODEL: 'f-journey-unused-summary',
        MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false',
        AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '10000' }, cwd, timeoutMs: 20000 });
      const log = readLog(m.log), audit = readLog(path.join(cwd, '.7coder', 'audit.jsonl'));
      record('journey: strict five-request chain keeps exact commands, edits and cumulative results', fixture.transcript(log), 'requests=' + log.length);
      record('journey: unique write/fail/edit/pass IDs have authoritative ok/error/ok/ok audit', fixture.audit(audit), '');
      record('journey: actual first test fails with exact stderr and numeric exit 1', fixture.failure(log, audit, readLog(path.join(cwd, '.7coder', 'runtime.jsonl'))), String(fixture.result(log, 1)));
      record('journey: exact fixed file is published by one successful replacement', fs.readFileSync(path.join(cwd, 'test.js'), 'utf8') === fixture.fixed &&
        fixture.result(log, 0) === 'Written: test.js' && fixture.result(log, 2) === '[OK] Edited test.js (1 replacement(s))', '');
      record('journey: actual second test succeeds with only expected complete stdout', fixture.passed(log), String(fixture.result(log, 3)));
      // The expected first test error is a real tool failure, not a CLI failure.
      record('journey: one final reply and real CLI close0 follow failure recovery without auxiliary calls',
        r.code === 0 && r.out.split(fixture.done).length === 2 && !/MOCK_PROTOCOL|EXECUTION_DEADLINE|Error writing to 7CODER/.test(r.out) &&
        !fs.existsSync(path.join(cwd, '7CODER.md')), 'exit=' + r.code);
    } finally { stopMock(m); }
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

// --- F4: exact parent/child isolation and complete child-history compression ---
scenarios.push({
  name: 'subagent-long',
  fn: async () => {
    const cwd = freshCwd('f4'), fixture = FSubagent;
    const evidenceOnly = process.env.F_SUBAGENT_EVIDENCE_ONLY === '1';
    fixture.files.forEach((value, i) => fs.writeFileSync(path.join(cwd, 'big' + i + '.txt'), value));
    const m = startMock(fixture.script, { MOCK_STRICT: '1' });
    try {
      const end = Date.now() + 5000; let ready = false;
      while (Date.now() < end) {
        if (m.child.exitCode !== null) throw Error('F4 mock exited before ready');
        try { if ((await httpReq(m.port, 'GET', '/', null)).status === 200) { ready = true; break; } }
        catch (e) { if (e.code !== 'ECONNREFUSED') throw e; }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      if (!ready) throw Error('F4 mock readiness deadline');
      const r = await runCli({ port: m.port, args: ['--prompt', fixture.prompt], env: { PERMISSION_MODE: 'bypass',
        HEAVY_MODEL: fixture.main, LIGHT_MODEL: fixture.light, SUMMARY_MODEL: 'f-subagent-unused-action-summary', MAX_RETRIES: '1',
        DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false',
        AUDIT_LOG: 'true', MAX_TOOL_RESULT_CHARS: '3000', CONTEXT_CHARS: '3500', EXECUTION_TIMEOUT_MS: '12000' }, cwd, timeoutMs: 20000 });
      const log = readLog(m.log);
      const diagnostic = JSON.stringify(log.map(request => ({ model: request.model, stream: request.stream,
        messages: request.messages.map(message => ({ role: message.role, chars: typeof message.content === 'string' ? message.content.length : null,
          head: String(message.content).slice(0, 90), tail: String(message.content).slice(-35), ids: (message.tool_calls || []).map(call => call.id) })) })));
      record('subagent-long: exact six-request parent/child/compressor transcript keeps task, complete old read and kept read',
        fixture.transcript(log), diagnostic);
      if (!evidenceOnly) {
      record('subagent-long: nested reads and parent result have exactly three unique successful audit identities',
        fixture.audit(readLog(path.join(cwd, '.7coder', 'audit.jsonl'))), '');
      record('subagent-long: one real child compression finishes and returns only its answer to parent',
        (r.out.match(/\[CTX\] Context compressed:/g) || []).length === 1 &&
        r.out.includes('Sub-agent "digger" finished') && r.out.split(fixture.done).length === 2 && r.code === 0, r.out.slice(-1800));
      record('subagent-long: fixture source files remain exact and no unrelated action summary is written',
        fixture.files.every((value, i) => fs.readFileSync(path.join(cwd, 'big' + i + '.txt'), 'utf8') === value) &&
        !fs.existsSync(path.join(cwd, '7CODER.md')) && !/MOCK_PROTOCOL|EXECUTION_DEADLINE|\[ERROR\]/.test(r.out), r.out.slice(-900));
      } else S.info('subagent-long: scenario reconstructed only failed transcript evidence; previous three assertions NOT RUN');
      S.info('subagent-long: complete retained read and known compression boundary verified; no claim that the full system/schema fit 3500 units');
    } finally { stopMock(m); }
  }
});

// --- F5/F5b: disconnect only after real body/tool admission, then reuse Agent ---
for (const [scenario, kind] of [['disconnect', 'partial'], ['disconnect-cancel', 'tool']]) scenarios.push({
  name: scenario,
  fn: async () => {
    const cwd = freshCwd('f5-' + kind), fixture = await FDisconnect.start(kind);
    const agent = createEndpoint({ suite: 'F-disconnect-' + kind, endpoint: fixture.endpoint, key: '', model: FDisconnect.model, permissionMode: 'bypass' });
    let client, admitted;
    const info = async () => JSON.parse((await agent.api('/api/info', null, 1000)).body);
    async function until(predicate, label) {
      const end = Date.now() + 6000;
      while (Date.now() < end) { if (client && client.state.error) throw client.state.error; if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
      throw Error('F5 ' + kind + ' deadline: ' + label);
    }
    try {
      await agent.start(cwd);
      client = FDisconnect.openStream(agent.port, kind);
      await until(async () => FDisconnect.observed(client.state.body, kind) && FDisconnect.active(admitted = await info(), kind), 'real output/tool admission');
      record('disconnect/' + kind + ': exact unfinished SSE and live task/tool counters precede abort',
        client.state.status === 200 && !client.state.closed && FDisconnect.observed(client.state.body, kind) && FDisconnect.active(admitted, kind), '');
      const begin = process.hrtime(); client.abort();
      await until(async () => client.state.closed && (kind !== 'partial' || fixture.upstreamAborted()) && FDisconnect.idle(await info()), 'closed transport and zero core/queue budgets');
      const elapsed = process.hrtime(begin), ms = elapsed[0] * 1000 + elapsed[1] / 1e6;
      record('disconnect/' + kind + ': actual client close and cancellation settle before natural completion',
        client.state.aborted && client.state.closed && ms < 5000 && (kind !== 'partial' || fixture.upstreamAborted()), 'ms=' + Math.round(ms));
      const beforeNext = await info();
      record('disconnect/' + kind + ': authoritative cancellation and all task/tool/admission/summary counters reach zero',
        FDisconnect.idle(beforeNext) && FDisconnect.cancellation(readLog(path.join(cwd, '.7coder', 'audit.jsonl')), readLog(path.join(cwd, '.7coder', 'runtime.jsonl')), kind), JSON.stringify(beforeNext.runtime));
      record('disconnect/' + kind + ': abort creates no summary or extra model requests',
        fixture.log.length === 1 && !fs.existsSync(path.join(cwd, '7CODER.md')), 'requests=' + fixture.log.length);
      const next = JSON.parse((await agent.api('/v1/chat/completions', { messages: [{ role: 'user', content: FDisconnect.next(kind) }] }, 8000)).body);
      record('disconnect/' + kind + ': same live Agent completes exact next JSON task',
        next.choices[0].message.role === 'assistant' && next.choices[0].message.content === FDisconnect.done && !next.choices[0].message.tool_calls, '');
      await until(async () => FDisconnect.idle(await info()), 'next task resources settled');
      record('disconnect/' + kind + ': two strict complete requests retain separate histories without ghost work',
        FDisconnect.transcript(fixture.log, kind) && !fs.existsSync(path.join(cwd, '7CODER.md')), 'requests=' + fixture.log.length);
    } catch (error) {
      console.error('F5 fixture diagnostics: ' + JSON.stringify({ kind, client: client && client.state, requests: fixture.log.map(body => ({ model: body.model, stream: body.stream, users: body.messages.filter(m => m.role === 'user').map(m => m.content) })) }).slice(-3500));
      throw error;
    } finally {
      if (client) client.abort();
      try { await agent.stop(); }
      finally { agent.S.cleanup(); await fixture.close(); }
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
