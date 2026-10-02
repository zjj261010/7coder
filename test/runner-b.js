// Suite B: adversarial / fault-injection / session-semantics tests for 7coder.
// Complements runner.js (suite A) with dimensions A does not cover.
// Usage: node test/runner-b.js
//   RUN_ONLY=chaos,session ...  limit scenarios
//   NODE_BIN=path\to\node.exe   run against another runtime (e.g. Node 13)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// OPT-4: duplicated helpers now live in test/_shared.js (single implementation).
const S = require('./_shared').create({ suite: 'B', wsPrefix: 'w-b-' });
const { ROOT, IDX, NODE_BIN, RUN_ONLY, record, startProcessAt, freshCwd, runCli, httpReq, stopMock, readLog, toolResults, tr, rmrf } = S;
let port = 17850;
function startProcess(mockFile, scriptObj, extraEnv) { port += 1; return startProcessAt(port, mockFile, scriptObj, extraEnv); }
const startMock = (s) => startProcess('mock-server.js', s);
const startChaos = (fault, s) => startProcess('chaos-mock.js', s, { FAULT_MODE: fault });

// ====================== SCENARIOS ======================
const scenarios = [];

scenarios.push({
  name: 'chaos',
  fn: async () => {
    // 500 -> retries exhausted
    let m = startChaos('500');
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({ port: m.port, args: ['--prompt', 't', '-p'], env: { MAX_RETRIES: '1', PERMISSION_MODE: 'bypass' }, cwd: freshCwd('b-chaos500') });
    record('chaos: upstream 500 -> clean max-retries error, nonzero exit, no crash', r.code === 1 && r.out.includes('Max retries reached'), 'code=' + r.code + ' ' + r.out.substring(0, 120));
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

// --- B22: brief_tool summary location (DS-15: .7coder/summaries, not root) ---
scenarios.push({
  name: 'brief-loc',
  fn: async () => {
    const cwd = freshCwd('b-briefloc');
    fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'sub', 'alpha-one.txt'), 'A');
    fs.writeFileSync(path.join(cwd, 'sub', 'beta-two.md'), 'B');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'bl1', type: 'function', function: { name: 'brief_tool', arguments: '{"folder":"sub"}' } }] },
      { role: 'assistant', content: 'BRIEF-LOC-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    const newSum = path.join(cwd, '.7coder', 'summaries', 'sub.summary');
    const content = fs.existsSync(newSum) ? fs.readFileSync(newSum, 'utf8') : '';
    const bl1 = tr(log, 'bl1') ? tr(log, 'bl1').c : '';
    record('brief: summary written to .7coder/summaries/sub.summary', fs.existsSync(newSum), bl1 || 'no result');
    record('brief: summary lists both files in sub', content.includes('alpha-one.txt') && content.includes('beta-two.md'), JSON.stringify(content.substring(0, 150)));
    record('brief: no sub.summary dumped in workspace root', !fs.existsSync(path.join(cwd, 'sub.summary')), fs.existsSync(path.join(cwd, 'sub.summary')) ? 'root sub.summary exists!' : '');
    record('brief: tool result reports the new summaries path', bl1.includes('.7coder') && bl1.includes('summaries') && bl1.includes('sub.summary'), bl1 || 'no result');
    stopMock(m);
  }
});


// --- B23: per-request approval isolation (P0-3: concurrent streams must not
// cross-wire or lose approvals; ids carry per-request prefixes) ---
scenarios.push({
  name: 'approval-iso',
  fn: async () => {
    const cwd = freshCwd('b-appriso');
    const tc = (id, file) => ({ role: 'assistant', content: null, tool_calls: [{ id: id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'ISO-' + file }) } }] });
    // Serialized consumption order (AST-03 gate): A heavy(tcA) -> A final -> A
    // summary-light -> B heavy(tcB) -> B final -> B summary-light.
    // NOTE: every step must be a full assistant OBJECT - mock-server reads
    // step.content/step.tool_calls, so bare strings yield empty deltas.
    const m = startMock([
      tc('iso1', 'a.txt'),
      { role: 'assistant', content: 'FINAL-A' },
      { role: 'assistant', content: 'X' },
      tc('iso2', 'b.txt'),
      { role: 'assistant', content: 'FINAL-B' },
      { role: 'assistant', content: 'X2' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 421;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'k', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', HEAVY_MODEL: 'iso-model', LIGHT_MODEL: 'iso-model', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    const openStream = () => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srvPort, method: 'POST', path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' } },
        res => { const s = { text: '' }; res.setEncoding('utf8'); res.on('data', d => s.text += d); resolve(s); });
      req.on('error', reject);
      req.write(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'iso test' }] }));
      req.end();
    });
    const waitFor = async (obj, needle, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (obj.text.includes(needle)) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return obj.text.includes(needle);
    };
    const idIn = (obj) => { const mm = obj.text.match(/"approval_request":\{"id":"([^"]+)"/); return mm ? mm[1] : null; };
    try {
      await new Promise(r => setTimeout(r, 2500));
      // AST-03 request gate: chat requests serialize, so the second stream
      // QUEUES while the first one waits for its approval. Isolation is still
      // per-request: each stream sees only its own approval id/prefix, and
      // approving one never touches the other.
      const sA = await openStream();
      const gotA = await waitFor(sA, 'approval_request', 15000);
      const idA = idIn(sA);
      const sB = await openStream();
      await new Promise(r => setTimeout(r, 1200));
      record('iso: queued stream B gets no approval while A holds the gate', gotA && !sB.text.includes('approval_request') && !sB.text.includes('[DONE]'), 'gotA=' + gotA + ' tailB=' + sB.text.substring(sB.text.length - 80));
      const okA = await httpReq(srvPort, 'POST', '/api/approve', { id: idA, approved: true });
      const doneA = await waitFor(sA, '[DONE]', 20000);
      const gotB = await waitFor(sB, 'approval_request', 20000); // B starts only after A finished
      const idB = idIn(sB);
      record('iso: approving A completes A, then B runs and gets its own approval', okA.status === 200 && doneA && gotB, 'status=' + okA.status + ' doneA=' + doneA + ' gotB=' + gotB + ' tailB=' + sB.text.substring(Math.max(0, sB.text.length - 300)));
      record('iso: approval ids differ and carry per-request prefixes', !!idA && !!idB && idA !== idB && /^apr-[a-z0-9]{6}-/.test(idA) && /^apr-[a-z0-9]{6}-/.test(idB), 'idA=' + idA + ' idB=' + idB);
      const okB = await httpReq(srvPort, 'POST', '/api/approve', { id: idB, approved: true });
      const doneB = await waitFor(sB, '[DONE]', 20000);
      record('iso: approving B then completes B', okB.status === 200 && doneB, 'status=' + okB.status + ' doneB=' + doneB);
      record('iso: both writes actually executed', fs.existsSync(path.join(cwd, 'a.txt')) && fs.existsSync(path.join(cwd, 'b.txt')), 'a=' + fs.existsSync(path.join(cwd, 'a.txt')) + ' b=' + fs.existsSync(path.join(cwd, 'b.txt')));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

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
      { role: 'assistant', content: null, tool_calls: [{ id: 'au4', type: 'function', function: { name: 'run_command', arguments: '{"command":"echo check Bearer sk-audit-secret-12345"}' } }] },
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
    const au4 = entries.find(e => e.tool === 'run_command' && JSON.stringify(e.args || {}).includes('echo check'));
    record('audit: secrets redacted in args preview (Bearer/sk- tokens masked)', au4 && JSON.stringify(au4.args).includes('Bearer ***') && !JSON.stringify(au4.args).includes('sk-audit-secret-12345'), au4 ? JSON.stringify(au4.args) : 'no echo-check entry');
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
    // regression 1: tool_calls must be stripped from saved assistant turns
    fs.writeFileSync(sess, JSON.stringify({ savedAt: 'x', messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'text + call', tool_calls: [{ id: 'x1', function: { name: 'write_file', arguments: '{}' } }] }
    ] }));
    const r4 = await runCli({
      port: m.port, args: ['--resume'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 30000,
      stdinSteps: [{ t: '/bye\n', d: 400 }]
    });
    const saved4 = JSON.parse(fs.readFileSync(sess, 'utf8'));
    const leaked = saved4.messages.some(x => x.tool_calls);
    record('resume: tool_calls stripped from saved turns (pairing-safe)', !leaked, 'leaked=' + leaked);
    // regression 2: /clear deletes the session file
    const r5 = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 30000,
      stdinSteps: [{ t: '/clear\n', d: 300 }, { t: '/bye\n', d: 400 }]
    });
    record('resume: /clear removes the saved session', !fs.existsSync(sess), 'file exists after clear');
    stopMock(m);
  }
});


// --- B17: run_tests_tool structured parsing (D2) ---
scenarios.push({
  name: 'tests-runner',
  fn: async () => {
    const cwd = freshCwd('b-tests');
    fs.writeFileSync(path.join(cwd, 'fake-runner.js'), [
      'console.log("Tests: 1 failed, 3 passed, 4 total");',
      'console.log("FAIL sum.test.js");',
      'console.log("not ok 1 adds numbers");',
      'process.exit(1);'
    ].join('\n'));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 't', scripts: { test: 'node fake-runner.js' } }));
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'ts1', type: 'function', function: { name: 'run_tests_tool', arguments: JSON.stringify({ command: 'node fake-runner.js' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ts2', type: 'function', function: { name: 'run_tests_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ts3', type: 'function', function: { name: 'run_tests_tool', arguments: JSON.stringify({ command: 'echo no-summary-output' }) } }] },
      { role: 'assistant', content: 'TS-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 120000 });
    const log = readLog(m.log);
    const ts1 = tr(log, 'ts1');
    record('tests: explicit command parsed (3 passed / 1 failed / failure lines)', ts1 && ts1.c.includes('3 passed, 1 failed') && ts1.c.includes('FAIL sum.test.js') && ts1.c.includes('not ok 1'), ts1 ? ts1.c.substring(0, 150) : 'no result');
    const ts2 = tr(log, 'ts2');
    record('tests: auto-detect via package.json scripts.test', ts2 && ts2.c.includes('3 passed, 1 failed'), ts2 ? ts2.c.substring(0, 120) : 'no result');
    const ts3 = tr(log, 'ts3');
    record('tests: no-summary output uses real newlines (no literal backslash-n text)', ts3 && ts3.c.includes('[TESTS] command finished') && ts3.c.includes('\n') && !ts3.c.includes("'\\n'"), ts3 ? JSON.stringify(ts3.c.substring(0, 140)) : 'no result');
    stopMock(m);
  }
});


// --- B18: git integration (D1: status/diff/commit, real repo) ---
scenarios.push({
  name: 'git-integration',
  fn: async () => {
    const cwd = freshCwd('b-git');
    spawnSync('git', ['init'], { cwd });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd });
    spawnSync('git', ['config', 'user.name', 't'], { cwd });
    fs.writeFileSync(path.join(cwd, 'app.txt'), 'v1' + String.fromCharCode(10));
    spawnSync('git', ['add', '.'], { cwd });
    spawnSync('git', ['commit', '-m', 'init'], { cwd });
    fs.writeFileSync(path.join(cwd, 'app.txt'), 'v2' + String.fromCharCode(10));
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'n' + String.fromCharCode(10));
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'gs1', type: 'function', function: { name: 'git_status_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'gs2', type: 'function', function: { name: 'git_diff_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'gs3', type: 'function', function: { name: 'git_commit_tool', arguments: JSON.stringify({ message: 'feat: bump app to v2' }) } }] },
      { role: 'assistant', content: 'GIT-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: [], env: { PERMISSION_MODE: 'default' }, cwd, timeoutMs: 120000, stdinSteps: [ { t: 'do git work\n', d: 80 }, { t: '/execute-task-now\n', d: 2500 }, { t: 'y\n', d: 15000 }, { t: '/bye\n', d: 500 } ] });
    const log = readLog(m.log);
    const gs1 = tr(log, 'gs1');
    record('git: status shows branch + dirty counts (auto-safe, no approval needed in default mode)', gs1 && gs1.c.includes('[GIT] branch') && gs1.c.includes('untracked:1'), gs1 ? gs1.c.substring(0, 120) : 'no result');
    const gs2 = tr(log, 'gs2');
    record('git: diff shows the v1->v2 change', gs2 && gs2.c.includes('-v1') && gs2.c.includes('+v2'), gs2 ? gs2.c.substring(0, 120) : 'no result');
    const gs3 = tr(log, 'gs3');
    const committed = spawnSync('git', ['log', '-1', '--oneline'], { encoding: 'utf8', cwd });
    const snapRefs = spawnSync('git', ['for-each-ref', 'refs/7coder/snapshots'], { encoding: 'utf8', cwd });
    record('git: commit created with requested message + snapshot recorded', gs3 && gs3.c.includes('[OK] committed') && committed.stdout.includes('feat: bump app to v2') && gs3.c.includes('snapshot') && snapRefs.stdout.trim() !== '', 'gs3=' + (gs3 ? gs3.c.substring(0, 100) : 'none') + ' log=' + committed.stdout.trim() + ' refs=' + (snapRefs.stdout.trim() || '(empty)'));
    // non-repo path
    const m2 = startMock([{ role: 'assistant', content: null, tool_calls: [{ id: 'gs4', type: 'function', function: { name: 'git_status_tool', arguments: '{}' } }] }, { role: 'assistant', content: 'NR-DONE' }]);
    await new Promise(r => setTimeout(r, 600));
    const os = require('os');
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'b-git-norepo-'));
    await runCli({ port: m2.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'default' }, cwd: cwd2, timeoutMs: 60000 });
    const gs4 = tr(readLog(m2.log), 'gs4');
    record('git: non-repo workspace -> clear error', gs4 && gs4.c.includes('Not a git repository'), gs4 ? gs4.c : 'no result');
    stopMock(m); stopMock(m2);
  }
});


// --- B19: web UI features - reasoning stream, sessions API, open endpoint ---
scenarios.push({
  name: 'ui-features',
  fn: async () => {
    const cwd = freshCwd('b-ui');
    const m = startMock([
      { role: 'assistant', reasoning: 'THINK-A then THINK-B', content: 'UI-ANSWER' },
      { role: 'assistant', content: 'UI-2' },
      { role: 'assistant', content: 'UI-3' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 390;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      // reasoning passthrough
      const st = await httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
      let content = '', reasoning = '';
      for (const line of st.body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const pl = line.substring(5).trim();
        if (!pl || pl === '[DONE]') continue;
        try { const j = JSON.parse(pl); const d = j.choices[0].delta; if (d.reasoning) reasoning += d.reasoning; if (d.content) content += d.content; } catch (e) {}
      }
      record('ui: reasoning deltas streamed as delta.reasoning', reasoning === 'THINK-A then THINK-B', JSON.stringify(reasoning));
      record('ui: content still assembled alongside reasoning', content === 'UI-ANSWER', JSON.stringify(content));
      // sessions api: seed two files directly (REPL save format)
      const sdir = path.join(cwd, '.7coder', 'sessions');
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(path.join(sdir, 's1.json'), JSON.stringify({ savedAt: '2026-01-01T00:00:00Z', messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'SEED-ONE' },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'dangling-tool-msg' }
      ] }));
      fs.writeFileSync(path.join(sdir, 's2.json'), JSON.stringify({ savedAt: '2026-01-02T00:00:00Z', messages: [
        { role: 'user', content: 'SEED-TWO' },
        { role: 'assistant', content: 'ok2' }
      ] }));
      const list = JSON.parse((await httpReq(srvPort, 'GET', '/api/sessions', null)).body);
      record('sessions: GET lists both saved sessions newest first', list.sessions.length === 2 && list.sessions[0].file === 's2.json', JSON.stringify(list.sessions));
      const loadResp = await httpReq(srvPort, 'POST', '/api/sessions/load', { file: 's1.json' });
      console.log('LOAD-DBG status=' + loadResp.status + ' body=' + loadResp.body.substring(0, 200));
      const load = JSON.parse(loadResp.body);
      const hasTool = load.messages.some(x => x.role === 'tool');
      record('sessions: load returns sanitized user/assistant turns', load.messages.length === 2 && !hasTool && load.messages[0].content === 'SEED-ONE', JSON.stringify(load.messages).substring(0, 120));
      const save = JSON.parse((await httpReq(srvPort, 'POST', '/api/sessions/save', { messages: [{ role: 'user', content: 'web-save-test' }, { role: 'assistant', content: 'ok' }, { role: 'tool', content: 'x' }] })).body);
      record('sessions: save stores sanitized web conversation', save.ok && save.turns === 2, JSON.stringify(save));
      // in-place: saving again with the returned file name overwrites, not duplicates
      const first = JSON.parse((await httpReq(srvPort, 'POST', '/api/sessions/save', { messages: [{ role: 'user', content: 'first-turn' }] })).body);
      const second = JSON.parse((await httpReq(srvPort, 'POST', '/api/sessions/save', { messages: [{ role: 'user', content: 'second-turn' }], file: first.file })).body);
      record('sessions: in-place save updates the same record', first.file === second.file && second.turns === 1, JSON.stringify({ f1: first.file, f2: second.file }));

      const trav = await httpReq(srvPort, 'POST', '/api/sessions/load', { file: '../../index.js' });
      record('sessions: path traversal in file name rejected', trav.status === 400, 'status=' + trav.status);
      // open endpoint (dry run - no window spawned)
      const openDry = JSON.parse((await httpReq(srvPort, 'POST', '/api/open', { target: 'workspace', dry: true })).body);
      record('open: dry run validates target', openDry.ok === true, JSON.stringify(openDry));
      const openBad = await httpReq(srvPort, 'POST', '/api/open', { target: 'desktop' });
      record('open: invalid target -> 400', openBad.status === 400, 'status=' + openBad.status);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});


// --- B20: settings + models-config API (runtime endpoint/key/model config) ---
scenarios.push({
  name: 'settings-api',
  fn: async () => {
    const cwd = freshCwd('b-set');
    const mockA = startMock([{ role: 'assistant', content: 'FROM-MOCK-A' }]);
    const mockB = startMock([{ role: 'assistant', content: 'FROM-MOCK-B' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 395;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'key-a', OPENAI_ENDPOINT: 'http://127.0.0.1:' + mockA.port + '/v1', HEAVY_MODEL: 'model-a', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      // Pre-seed a .env with a comment + unmanaged key; POST /api/settings
      // must rewrite it in place without dropping either (OPT-8c).
      fs.writeFileSync(path.join(cwd, '.env'), '# KEEP-ME-COMMENT\nTEMP_X=1\n');
      const cfg = JSON.parse((await httpReq(srvPort, 'GET', '/api/settings', null)).body);
      record('set: GET /api/settings returns current endpoint/key/model', cfg.endpoint.indexOf(':' + mockA.port) >= 0 && cfg.apiKey === 'key-a' && cfg.model === 'model-a', JSON.stringify(cfg));
      const sw = JSON.parse((await httpReq(srvPort, 'POST', '/api/settings', { endpoint: 'http://127.0.0.1:' + mockB.port + '/v1', apiKey: 'key-b', model: 'model-b' })).body);
      record('set: POST /api/settings switches runtime globals', sw.ok === true && sw.model === 'model-b', JSON.stringify(sw));
      const def = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
      record('set: default chat now routes to the NEW endpoint/model', def.status === 200 && def.body.includes('FROM-MOCK-B') && def.body.includes('"model":"model-b"'), def.body.substring(0, 100));
      const mc = JSON.parse((await httpReq(srvPort, 'POST', '/api/models-config', { profiles: { 'profile-c': { endpoint: 'http://127.0.0.1:' + mockA.port + '/v1', apiKey: 'key-c' } } })).body);
      record('set: models-config writes + reloads profiles', mc.ok === true && mc.models.indexOf('profile-c') >= 0, JSON.stringify(mc));
      const profChat = await httpReq(srvPort, 'POST', '/v1/chat/completions', { model: 'PROFILE-C', messages: [{ role: 'user', content: 'x' }] });
      record('set: profiled model chat routes via models.json', profChat.status === 200 && profChat.body.includes('FROM-MOCK-A'), profChat.body.substring(0, 80));
      const envFile = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
      record('set: persisted to workspace .env (restart-safe)', envFile.includes('OPENAI_ENDPOINT=http://127.0.0.1:' + mockB.port + '/v1') && envFile.includes('HEAVY_MODEL=model-b') && envFile.includes('OPENAI_API_KEY=key-b'), envFile.replace(/\n/g, ' | '));
      record('set: comments preserved when .env is rewritten by POST /api/settings', envFile.includes('# KEEP-ME-COMMENT'), envFile.replace(/\n/g, ' | '));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(mockA); stopMock(mockB);
    }
  }
});


// --- B21: parallel read-only tool execution (D6) ---
scenarios.push({
  name: 'parallel-tools',
  fn: async () => {
    const cwd = freshCwd('b-parallel');
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'beta');
    fs.writeFileSync(path.join(cwd, 'c.txt'), 'gamma');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'p1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } },
        { id: 'p2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) } },
        { id: 'p3', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'c.txt' }) } },
        { id: 'p4', type: 'function', function: { name: 'list_dir', arguments: '{}' } }
      ] },
      { role: 'assistant', content: 'PARALLEL-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const t0 = Date.now();
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const elapsed = Date.now() - t0;
    const log = readLog(m.log);
    const results = toolResults(log).filter(t => ['p1','p2','p3','p4'].indexOf(t.id) >= 0);
    record('parallel: all 4 read-only results collected', results.length === 4 && results.every(t => t.c.length > 0), 'count=' + results.length);
    record('parallel: results in correct order (matches tool_call order)', results.map(t => t.id).join(',') === 'p1,p2,p3,p4', 'order=' + results.map(t => t.id).join(','));
    record('parallel: content correct per call', results[0] && results[0].c.includes('alpha') && results[1] && results[1].c.includes('beta') && results[2] && results[2].c.includes('gamma'), '');
    record('parallel: reply generated after parallel batch', r.out.includes('PARALLEL-DONE'), '');
    stopMock(m);
  }
});

// --- B24: AST security round (AST-01/02/03/11 negative assertions) ---
scenarios.push({
  name: 'ast-security',
  fn: async () => {
    // AST-01: git path / commit message must never be shell-parsed
    const cwd1 = freshCwd('b-ast1');
    for (const g of [['init'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '.'], ['commit', '-m', 'init']]) {
      try { spawnSync('git', g, { cwd: cwd1 }); } catch (e) {}
    }
    fs.writeFileSync(path.join(cwd1, 'a.txt'), 'v1');
    try { spawnSync('git', ['add', '.'], { cwd: cwd1 }); spawnSync('git', ['commit', '-m', 'base'], { cwd: cwd1 }); } catch (e) {}
    const m1 = startMock([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'as1', type: 'function', function: { name: 'git_diff_tool', arguments: JSON.stringify({ path: 'x" & echo PWNED-AST1 > pwned1.txt' }) } },
        { id: 'as2', type: 'function', function: { name: 'git_commit_tool', arguments: JSON.stringify({ message: 'feat & echo PWNED-AST1B > pwned2.txt' }) } }
      ] },
      { role: 'assistant', content: 'AST1-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m1.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd1, timeoutMs: 60000 });
    const l1 = readLog(m1.log);
    const as1 = tr(l1, 'as1'), as2 = tr(l1, 'as2');
    record('ast01: injected diff path executes no shell (no marker)', !fs.existsSync(path.join(cwd1, 'pwned1.txt')), as1 ? as1.c.substring(0, 100) : 'no result');
    const lastMsg = spawnSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8', cwd: cwd1 });
    record('ast01: commit message stays a literal argument (no marker, message verbatim)', !fs.existsSync(path.join(cwd1, 'pwned2.txt')) && as2 && as2.c.includes('[OK] committed') && lastMsg.stdout.includes('echo PWNED-AST1B'), 'as2=' + (as2 ? as2.c.substring(0, 80) : 'none') + ' last=' + lastMsg.stdout.trim());
    stopMock(m1);

    // AST-02: '7coder.md/../.env' must NOT reach the auto-execute branch
    const cwd2 = freshCwd('b-ast2');
    const m2 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'as3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '7coder.md/../.env', content: 'HACKED=1' }) } }] },
      { role: 'assistant', content: 'AST2-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m2.port, args: ['--prompt', 't'], env: {}, cwd: cwd2, timeoutMs: 60000 }); // default mode
    const as3 = tr(readLog(m2.log), 'as3');
    record('ast02: traversal-disguised .env write is declined in default mode (no file written)', as3 && /declined|BLOCKED/.test(as3.c) && !fs.existsSync(path.join(cwd2, '.env')), 'as3=' + (as3 ? as3.c.substring(0, 100) : 'none'));
    stopMock(m2);
    const cwd2b = freshCwd('b-ast2b');
    const m2b = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'as3b', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '7coder.md/../.env', content: 'HACKED=1' }) } }] },
      { role: 'assistant', content: 'AST2B-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m2b.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd2b, timeoutMs: 60000 });
    const as3b = tr(readLog(m2b.log), 'as3b');
    record('ast02: bypass mode blocks the same write as protected', as3b && as3b.c.includes('BLOCKED: protected file') && !fs.existsSync(path.join(cwd2b, '.env')), 'as3b=' + (as3b ? as3b.c.substring(0, 100) : 'none'));
    stopMock(m2b);

    // AST-03: an always-rejecting light model must also reject the workflow plan
    const cwd3 = freshCwd('b-ast3');
    const m3 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'as4', type: 'function', function: { name: 'workflow_tool', arguments: JSON.stringify({ steps: [{ tool: 'write_file', args: { path: 'out-ast3.txt', content: 'X' } }] }) } }] },
      { role: 'assistant', content: 'NO' }, // light model rejects the plan
      { role: 'assistant', content: 'AST3-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m3.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'auto' }, cwd: cwd3, timeoutMs: 60000 });
    const as4 = tr(readLog(m3.log), 'as4');
    record('ast03: auto mode declines the workflow plan itself when the light model says NO', as4 && as4.c.includes('Auto-approval declined') && !fs.existsSync(path.join(cwd3, 'out-ast3.txt')), 'as4=' + (as4 ? as4.c.substring(0, 100) : 'none'));
    stopMock(m3);

    // AST-11a: a List error step must stop the workflow (regex unification)
    const cwd4 = freshCwd('b-ast4');
    const m4 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'as5', type: 'function', function: { name: 'workflow_tool', arguments: JSON.stringify({ steps: [
        { tool: 'list_dir', args: { path: 'missing-dir-ast11' } },
        { tool: 'write_file', args: { path: 'after-ast11.txt', content: 'x' } }
      ] }) } }] },
      { role: 'assistant', content: 'AST11-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m4.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd4, timeoutMs: 60000 });
    const as5 = tr(readLog(m4.log), 'as5');
    record('ast11: List error stops the workflow (no silent continue)', as5 && as5.c.includes('stopped after failed step 1') && !fs.existsSync(path.join(cwd4, 'after-ast11.txt')), 'as5=' + (as5 ? as5.c.substring(0, 120) : 'none'));
    stopMock(m4);

    // AST-11b: denial-mode rejection must audit as blocked, not ok
    const cwd5 = freshCwd('b-ast5');
    const m5 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'as6', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'ok-ast11b.txt', content: 'x' }) } }] },
      { role: 'assistant', content: 'AST11B-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m5.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'denial' }, cwd: cwd5, timeoutMs: 60000 });
    const auditPath5 = path.join(cwd5, '.7coder', 'audit.jsonl');
    let denialStatus = '(no audit)';
    if (fs.existsSync(auditPath5)) {
      const entries = fs.readFileSync(auditPath5, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      const e5 = entries.find(e => e.tool === 'write_file');
      if (e5) denialStatus = e5.status;
    }
    record('ast11: denial-mode rejection audits as blocked (was ok)', denialStatus === 'blocked', 'status=' + denialStatus);
    stopMock(m5);
  }
});


// ====================== RUNNER ======================
S.runAll(scenarios);
