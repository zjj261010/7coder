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
      ['adv2: binary file read refused with [BINARY] marker (GAP-3b)', tr(log, 'g7') && tr(log, 'g7').c.indexOf('[BINARY]') === 0 && tr(log, 'g7').c.indexOf('Tool error') < 0, tr(log, 'g7') ? tr(log, 'g7').c.substring(0, 90) : 'no result'],
      ['adv2: empty file reads as (empty file) (GAP-3b)', tr(log, 'g8') && tr(log, 'g8').c === '(empty file)', tr(log, 'g8') ? JSON.stringify(tr(log, 'g8').c) : 'no result'],
      ['adv2: wrong arg type surfaces as tool error', tr(log, 'g9') && /Tool error|Read error/.test(tr(log, 'g9').c), ''],
      ['adv2: edit $& substitution stays literal', fs.readFileSync(path.join(cwd, 'plain.txt'), 'utf8') === '$&$&`x`', fs.readFileSync(path.join(cwd, 'plain.txt'), 'utf8')],
      ['adv2: CJK + spaces path roundtrip (line-numbered full read, GAP-3a)', tr(log, 'g12') && tr(log, 'g12').c.indexOf('\t你好世界-テスト') > 0 && /^ {5}1\t/.test(tr(log, 'g12').c), tr(log, 'g12') ? JSON.stringify(tr(log, 'g12').c) : 'no result']
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
    // AST-R1: the reply must clear the 200-char summary floor, otherwise the
    // light summary call this scenario pins never happens.
    const m = startMock([{ role: 'assistant', content: 'CONTRACT-OK ' + 'contract-detail '.repeat(16) }]);
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
      // AST-R1: one main step per HTTP request - short replies no longer burn
      // a light-model summary step between requests.
      { role: 'assistant', content: 'HX-REPLY-1' },
      { role: 'assistant', content: 'HX-REPLY-2' },
      { role: 'assistant', content: 'HX-REPLY-3' },
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
    // Serialized consumption order (AST-03 gate): A heavy(tcA) -> A final -> B
    // heavy(tcB) -> B final. (AST-R1: no summary-light steps any more - the
    // FINAL replies are short, so summarizeAction skips them.)
    // NOTE: every step must be a full assistant OBJECT - mock-server reads
    // step.content/step.tool_calls, so bare strings yield empty deltas.
    const m = startMock([
      tc('iso1', 'a.txt'),
      { role: 'assistant', content: 'FINAL-A' },
      tc('iso2', 'b.txt'),
      { role: 'assistant', content: 'FINAL-B' }
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


// --- B26: AST-06/AST-07 - server contracts behind the webui session fixes ---
// AST-06: the webui autoSaveSession now FIRST-saves without a `file` field;
//   this pins the server half of that contract: no file -> server mints
//   web-*.json, returns it, and a follow-up save carrying it reuses the name.
//   (The front-end half is browser code - no DOM harness here, review-only.)
// AST-07: business errors must reach the browser as SSE
//   `data: {"error":{"message":...}}` events (headers sent immediately, so
//   still HTTP 200). Two wordings occur: "Max retries reached." (retry-
//   exhausted, index.js throws it at the wrap site) and "upstream error: ..."
//   (in-stream context overflow, rethrown verbatim by the retry gate). The
//   old webui parser only rethrew messages containing 'upstream', so the
//   FIRST wording was swallowed - that is exactly the AST-07 bug.
scenarios.push({
  name: 'webui-firstsave',
  fn: async () => {
    const cwd = freshCwd('b-webui1st');
    const m = startChaos('500'); // every upstream POST fails; server runs MAX_RETRIES=1
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 340;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      // AST-06: first save carries NO file field
      const fs1 = await httpReq(srvPort, 'POST', '/api/sessions/save', { messages: [{ role: 'user', content: 'AST06-Q' }, { role: 'assistant', content: 'AST06-A' }] });
      let minted = '';
      try { minted = JSON.parse(fs1.body).file || ''; } catch (e) {}
      record('webui1st: save without file -> 200 and response carries file', fs1.status === 200 && /^web-.*[.]json$/.test(minted), 'status=' + fs1.status + ' body=' + fs1.body.substring(0, 120));
      record('webui1st: minted session file exists under .7coder/sessions', !!minted && fs.existsSync(path.join(cwd, '.7coder', 'sessions', minted)), minted);
      // follow-up save reusing the minted name updates in place (no second file)
      const fs2 = await httpReq(srvPort, 'POST', '/api/sessions/save', { messages: [{ role: 'user', content: 'AST06-Q' }, { role: 'assistant', content: 'AST06-A2' }], file: minted });
      let reused = '';
      try { reused = JSON.parse(fs2.body).file || ''; } catch (e) {}
      record('webui1st: save with returned file reuses it in place', fs2.status === 200 && reused === minted, 'reused=' + reused);
      // AST-07 wording 1: retry-exhausted failure ("Max retries reached." -
      // deliberately NOT containing 'upstream', the case the old filter ate)
      const bad = await httpReq(srvPort, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hi' }] });
      let errMsg = '';
      for (const line of bad.body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const pl = line.substring(5).trim();
        if (!pl || pl === '[DONE]') continue;
        try { const j = JSON.parse(pl); if (j.error) errMsg = j.error.message || ''; } catch (e) {}
      }
      record('webui1st: retry-exhausted failure reaches client as SSE data:{error} (no upstream substring)', bad.status === 200 && errMsg.indexOf('Max retries reached') >= 0, 'msg=' + JSON.stringify(errMsg) + ' body=' + bad.body.substring(0, 100));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
    // AST-07 wording 2: in-stream context overflow keeps its "upstream error:"
    // prefix end-to-end (retry gate rethrows it verbatim).
    const m2 = startChaos('lmstudio-ctx');
    await new Promise(r => setTimeout(r, 600));
    const srvPort2 = port + 340;
    const srv2 = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m2.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort2) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const bad2 = await httpReq(srvPort2, 'POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hi' }] });
      let errMsg2 = '';
      for (const line of bad2.body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const pl = line.substring(5).trim();
        if (!pl || pl === '[DONE]') continue;
        try { const j = JSON.parse(pl); if (j.error) errMsg2 = j.error.message || ''; } catch (e) {}
      }
      record('webui1st: in-stream overflow reaches client as SSE data:{error} with upstream wording', bad2.status === 200 && errMsg2.indexOf('upstream error') >= 0 && errMsg2.indexOf('context length') >= 0, 'msg=' + JSON.stringify(errMsg2).substring(0, 150));
    } finally {
      try { srv2.kill(); } catch (e) {}
      stopMock(m2);
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
    // AST-R1: session 1's reply is padded past the 200-char summary floor so
    // the summary step below is still consumed and the step order stays put.
    const m = startMock([
      { role: 'assistant', content: 'noted: RESUME-77. ' + 'I will keep this codeword in mind for the rest of the session. '.repeat(5) },
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
      // AST-08: a newline inside a settings value must not inject a new .env line
      const inj = await httpReq(srvPort, 'POST', '/api/settings', { apiKey: 'k\nPERMISSION_MODE=bypass' });
      record('ast08: newline-in apiKey rejected with 400', inj.status === 400, 'status=' + inj.status + ' body=' + inj.body.substring(0, 120));
      const inj2 = await httpReq(srvPort, 'POST', '/api/settings', { endpoint: 'http://x/\nPERMISSION_MODE=bypass' });
      record('ast08: newline-in endpoint rejected with 400', inj2.status === 400, 'status=' + inj2.status);
      const badScheme = await httpReq(srvPort, 'POST', '/api/settings', { endpoint: 'ftp://evil.example/v1' });
      record('ast08: non-http(s) endpoint scheme rejected with 400', badScheme.status === 400, 'status=' + badScheme.status);
      const envAfter = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
      record('ast08: no injected line reached .env', envAfter.indexOf('PERMISSION_MODE') < 0, envAfter.replace(/\n/g, ' | '));
      const cur = JSON.parse((await httpReq(srvPort, 'GET', '/api/settings', null)).body);
      record('ast08: rejected saves leave runtime globals untouched', cur.apiKey === 'key-b' && cur.model === 'model-b', JSON.stringify({ apiKey: cur.apiKey, model: cur.model }));
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
    fs.writeFileSync(path.join(cwd1, 'a.txt'), 'v2'); // give the commit tool something real to stage (the .gitignore side effect is gone)
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

    // AST-04a: .7coder/models.json holds API keys - reading it must require
    // approval (default mode, non-interactive -> declined), not auto-execute.
    const cwd6 = freshCwd('b-ast6');
    fs.mkdirSync(path.join(cwd6, '.7coder'), { recursive: true });
    fs.writeFileSync(path.join(cwd6, '.7coder', 'models.json'), JSON.stringify({ 'profile-x': { endpoint: 'http://127.0.0.1:9/v1', apiKey: 'fake-key-AST04' } }));
    const m6 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'as7', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '.7coder/models.json' }) } }] },
      { role: 'assistant', content: 'AST4-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m6.port, args: ['--prompt', 't'], env: {}, cwd: cwd6, timeoutMs: 60000 }); // default mode
    const as7 = tr(readLog(m6.log), 'as7');
    record('ast04: default-mode read of models.json is declined (HIGH approval), key not leaked', as7 && /declined/i.test(as7.c) && as7.c.indexOf('fake-key-AST04') < 0, 'as7=' + (as7 ? as7.c.substring(0, 120) : 'none'));
    stopMock(m6);

    // AST-04a2: even bypass mode must not WRITE models.json (protected write).
    const cwd6b = freshCwd('b-ast6b');
    fs.mkdirSync(path.join(cwd6b, '.7coder'), { recursive: true });
    fs.writeFileSync(path.join(cwd6b, '.7coder', 'models.json'), '{"keep":true}');
    const m6b = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'as8', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '.7coder/models.json', content: '{"evil":true}' }) } }] },
      { role: 'assistant', content: 'AST4B-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m6b.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd6b, timeoutMs: 60000 });
    const as8 = tr(readLog(m6b.log), 'as8');
    record('ast04: bypass-mode write to models.json is BLOCKED as protected', as8 && as8.c.includes('BLOCKED: protected file') && fs.readFileSync(path.join(cwd6b, '.7coder', 'models.json'), 'utf8') === '{"keep":true}', 'as8=' + (as8 ? as8.c.substring(0, 120) : 'none'));
    stopMock(m6b);

    // AST-04b: git_commit_tool (stage_all default) must never stage .7coder/
    // runtime state (audit.jsonl) into the user's repository.
    const cwd7 = freshCwd('b-ast7');
    spawnSync('git', ['init'], { cwd: cwd7 });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: cwd7 });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: cwd7 });
    fs.writeFileSync(path.join(cwd7, 'code.txt'), 'v1');
    spawnSync('git', ['add', '.'], { cwd: cwd7 });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: cwd7 });
    fs.writeFileSync(path.join(cwd7, 'code.txt'), 'v2');
    fs.mkdirSync(path.join(cwd7, '.7coder'), { recursive: true });
    fs.writeFileSync(path.join(cwd7, '.7coder', 'audit.jsonl'), '{"type":"tool","tool":"write_file","status":"ok"}');
    const m7 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'as9', type: 'function', function: { name: 'git_commit_tool', arguments: JSON.stringify({ message: 'ast04: code change only' }) } }] },
      { role: 'assistant', content: 'AST4C-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m7.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd7, timeoutMs: 60000 });
    const as9 = tr(readLog(m7.log), 'as9');
    const lsOut = spawnSync('git', ['ls-files'], { encoding: 'utf8', cwd: cwd7 });
    const tracked = lsOut.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    record('ast04: git_commit_tool stages no .7coder/ runtime state', as9 && as9.c.includes('[OK] committed') && tracked.every(l => l.indexOf('.7coder/') !== 0), 'as9=' + (as9 ? as9.c.substring(0, 80) : 'none') + ' ls-files=' + tracked.join(','));
    stopMock(m7);
  }
});

// --- B25: AST-05 - a failed download must never destroy an existing dest file ---
scenarios.push({
  name: 'ast-download',
  fn: async () => {
    const cwd = freshCwd('b-astdl');
    const readWs = rel => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch (e) { return '(gone: ' + e.code + ')'; } };
    fs.writeFileSync(path.join(cwd, 'keepme.txt'), 'ORIGINAL');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'dl1', type: 'function', function: { name: 'download_tool', arguments: JSON.stringify({ url: 'http://127.0.0.1:1/x', path: 'keepme.txt' }) } }
      ] },
      { role: 'assistant', content: 'ASTDL-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    // round 1: connection refused -> dest must survive untouched, no residue
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const dl1 = tr(readLog(m.log), 'dl1');
    const residue1 = fs.readdirSync(cwd).filter(f => f.indexOf('.part-') >= 0);
    record('astdl: refused download reports Download error', dl1 && dl1.c.includes('Download error'), 'dl1=' + (dl1 ? dl1.c.substring(0, 100) : 'none'));
    record('astdl: refused download leaves existing dest untouched', readWs('keepme.txt') === 'ORIGINAL', 'content=' + readWs('keepme.txt'));
    record('astdl: no .part- residue after failure', residue1.length === 0, 'residue=' + residue1.join(','));
    // round 2: mock 200 (GET serves a fixed blob without consuming a step)
    const m2 = startMock([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'dl3', type: 'function', function: { name: 'download_tool', arguments: JSON.stringify({ url: 'http://127.0.0.1:' + m.port + '/blob.bin', path: 'out/ok.bin' }) } }
      ] },
      { role: 'assistant', content: 'ASTDL2-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m2.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const dl3 = tr(readLog(m2.log), 'dl3');
    const residue2 = fs.readdirSync(cwd).filter(f => f.indexOf('.part-') >= 0);
    record('astdl: 200 download writes the body verbatim', dl3 && dl3.c.includes('[OK] Downloaded') && readWs(path.join('out', 'ok.bin')) === 'MOCKBLOB-1234567890-MOCKBLOB', 'dl3=' + (dl3 ? dl3.c.substring(0, 100) : 'none') + ' content=' + readWs(path.join('out', 'ok.bin')));
    record('astdl: keepme.txt still ORIGINAL after the successful run', readWs('keepme.txt') === 'ORIGINAL', 'content=' + readWs('keepme.txt'));
    record('astdl: no .part- residue after success', residue2.length === 0, 'residue=' + residue2.join(','));
    stopMock(m); stopMock(m2);
  }
});


// --- AST-R1: summary-call budget (SUMMARY_MODEL / SUMMARY_MAX_TOKENS) and the
// short-reply skip; plus P2-6 EADDRINUSE handling for the HTTP server ---
scenarios.push({
  name: 'summary-budget',
  fn: async () => {
    // ① long reply -> exactly one light summary call, carrying SUMMARY_MODEL
    //    and max_tokens 512 (the mock log records the full request body JSON)
    let cwd = freshCwd('b-sumbudget-long');
    const longReply = 'LONG-REPLY-HEADER ' + 'detail paragraph '.repeat(20); // > 200 chars
    let m = startMock([{ role: 'assistant', content: longReply }]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', SUMMARY_MODEL: 'sum-model-x', SUMMARY_MAX_TOKENS: '512' }, cwd, timeoutMs: 60000 });
    let log = readLog(m.log);
    const summaryCalls = log.filter(x => !('tools' in x));
    record('summary-budget: long reply triggers exactly one light summary call', summaryCalls.length === 1, 'count=' + summaryCalls.length + ' total=' + log.length);
    record('summary-budget: summary call body carries SUMMARY_MODEL + "max_tokens":512', summaryCalls.length === 1 && summaryCalls[0].model === 'sum-model-x' && summaryCalls[0].max_tokens === 512, summaryCalls.length ? JSON.stringify({ model: summaryCalls[0].model, mt: summaryCalls[0].max_tokens }) : 'no summary req');
    stopMock(m);
    // ② short reply (<200 chars) -> no summary light call at all; every logged
    //    request is a main (tools-bearing) call.
    cwd = freshCwd('b-sumbudget-short');
    m = startMock([{ role: 'assistant', content: 'SHORT-REPLY-DONE' }]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    log = readLog(m.log);
    const lightCalls = log.filter(x => !('tools' in x));
    record('summary-budget: short reply skips the summary light call', log.length >= 1 && lightCalls.length === 0, 'total=' + log.length + ' light=' + lightCalls.length);
    stopMock(m);
  }
});

scenarios.push({
  name: 'eaddr',
  fn: async () => {
    const cwd = freshCwd('b-eaddr');
    // Occupy a port with a plain HTTP server, then point --server at it.
    const blocker = http.createServer((req, res) => { res.writeHead(200); res.end('blocker'); });
    await new Promise((resolve, reject) => { blocker.on('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
    const busyPort = blocker.address().port;
    let code = null, out = '';
    try {
      const r = spawnSync(NODE_BIN, [IDX, '--server'], {
        env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:1/v1', MAX_RETRIES: '1', HTTP_PORT: String(busyPort) }),
        cwd, encoding: 'utf8', timeout: 60000
      });
      code = r.status;
      out = String(r.stdout || '') + String(r.stderr || '');
    } finally {
      try { blocker.close(); } catch (e) {}
    }
    record('eaddr: occupied port -> nonzero exit with a HTTP_PORT hint (no raw stack)', code !== 0 && out.indexOf('HTTP_PORT') >= 0 && out.indexOf('EADDRINUSE') < 0, 'code=' + code + ' out=' + out.substring(0, 250));
  }
});


// --- AST-14: bare-string mock steps must stream their content, not empty deltas.
// Before the normalization in mock-server.js/chaos-mock.js, a script step like
// 'STR-STEP-DONE' had no .content/.tool_calls, so the mock emitted empty deltas
// and the client died with "empty streamed response" (error path still wrote
// [DONE]). These scenarios pin the fix at all three step-fetch sites.
scenarios.push({
  name: 'strstep',
  fn: async () => {
    // ① mock-server.js: every step is a bare string (worst case)
    let cwd = freshCwd('b-strstep');
    let m = startMock(['STR-STEP-DONE']);
    await new Promise(r => setTimeout(r, 600));
    let r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', MAX_RETRIES: '1' }, cwd, timeoutMs: 60000 });
    record('strstep: bare-string step streams real reply (mock-server)', r.out.includes('STR-STEP-DONE') && r.out.indexOf('empty streamed response') < 0, r.out.substring(0, 200));
    stopMock(m);

    // ② chaos-mock.js chaos-sse branch: string step + junk SSE lines
    cwd = freshCwd('b-strstep-sse');
    m = startChaos('chaos-sse', ['CHAOS-STR-DONE']);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({
      port: m.port, args: [], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000,
      stdinSteps: [{ t: 'hello\n', d: 100 }, { t: '/execute-task-now\n', d: 3000 }, { t: '/bye\n', d: 400 }]
    });
    record('strstep: bare-string step survives chaos-sse junk lines (chaos-mock)', r.out.includes('CHAOS-STR-DONE') && r.out.indexOf('empty streamed response') < 0, r.out.substring(0, 200));
    stopMock(m);

    // ③ chaos-mock.js serveScript branch (429-then-ok: first POST eats the 429,
    //    the retry reaches the scripted string step)
    cwd = freshCwd('b-strstep-429');
    m = startChaos('429-then-ok', ['CHAOS-SERVE-DONE']);
    await new Promise(r => setTimeout(r, 600));
    r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', MAX_RETRIES: '2' }, cwd, timeoutMs: 60000 });
    record('strstep: bare-string step served after 429 retry (serveScript)', r.out.includes('CHAOS-SERVE-DONE') && r.out.indexOf('empty streamed response') < 0, r.out.substring(0, 200));
    stopMock(m);
  }
});

// --- B26: AST-09 event loop stays responsive during a long command ---
scenarios.push({
  name: 'loopfree',
  fn: async () => {
    const cwd = freshCwd('b-loopfree');
    const pad = 'final reply padded past the summary floor for the budget skip. ';
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'lf1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'ping -n 4 127.0.0.1' }) } }] },
      { role: 'assistant', content: 'LOOPFREE-DONE ' + pad.repeat(5) },
      { role: 'assistant', content: 'lf-summary' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 431;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'k', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', HEAVY_MODEL: 'lf-model', LIGHT_MODEL: 'lf-model', MAX_RETRIES: '1', HTTP_PORT: String(srvPort), PERMISSION_MODE: 'bypass' }),
      cwd, stdio: 'ignore'
    });
    try {
      await new Promise(r => setTimeout(r, 2500));
      // fire the chat request WITHOUT awaiting it - the mock's first reply is
      // a run_command tool call that sleeps ~3s (ping -n 4)
      const chatP = httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
      await new Promise(r => setTimeout(r, 800)); // command is now mid-flight
      const t0 = Date.now();
      const info = await httpReq(srvPort, 'GET', '/api/info', null);
      const infoMs = Date.now() - t0;
      record('loopfree: /api/info answers while a command runs (event loop not blocked)', info.status === 200 && infoMs < 2000, 'status=' + info.status + ' ms=' + infoMs + ' (sync execSync would freeze >=3000ms)');
      const chat = await chatP;
      record('loopfree: long-command chat request completes normally', chat.status === 200 && chat.body.includes('LOOPFREE-DONE'), 'status=' + chat.status);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- B27: AST-10 bounded body reader - immediate 413, no accumulation ---
scenarios.push({
  name: 'bodycap',
  fn: async () => {
    const cwd = freshCwd('b-bodycap');
    const m = startMock([{ role: 'assistant', content: 'BODYCAP-DONE ' + 'bodycap reply padded past the summary floor. '.repeat(5) }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 433;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'k', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', HEAVY_MODEL: 'bc-model', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    const postRaw = (path, bodyStr) => new Promise((resolve, reject) => {
      const data = Buffer.from(bodyStr, 'utf8');
      const req = http.request({ host: '127.0.0.1', port: srvPort, method: 'POST', path,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
        res => { let out = ''; res.on('data', d => out += d); res.on('end', () => resolve({ status: res.statusCode, body: out })); });
      req.on('error', reject);
      req.write(data); req.end();
    });
    try {
      await new Promise(r => setTimeout(r, 2500));
      const big = JSON.stringify({ id: 'x', approved: true, pad: 'a'.repeat(2 * 1024 * 1024) }); // 2MB > 1MB route cap
      const over = await postRaw('/api/approve', big);
      record('bodycap: 2MB POST to /api/approve rejected 413', over.status === 413, 'status=' + over.status);
      const alive = await httpReq(srvPort, 'GET', '/api/info', null);
      record('bodycap: server responsive right after the 413', alive.status === 200, 'status=' + alive.status);
      const small = await postRaw('/api/approve', JSON.stringify({ id: 'nope', approved: true }));
      record('bodycap: small POST still processed (400 unknown id, not 413)', small.status === 400 && /no pending approval/.test(small.body), 'status=' + small.status + ' body=' + small.body.substring(0, 80));
      const chatOver = await postRaw('/v1/chat/completions', JSON.stringify({ messages: [{ role: 'user', content: 'b'.repeat(11 * 1024 * 1024) }] }));
      record('bodycap: 11MB chat body rejected 413', chatOver.status === 413, 'status=' + chatOver.status);
      const chatOk = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
      record('bodycap: normal chat still works after the caps', chatOk.status === 200 && chatOk.body.includes('BODYCAP-DONE'), 'status=' + chatOk.status);
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- AST-10 edge cases beyond the base bodycap scenario:
// (1) utf8 byte total lands at exactly LIMIT+1 with the LAST multibyte char
//     torn across a fragment boundary (catches undercounting when the utf8
//     decoder must carry a partial sequence across reader chunks),
// (2) chunked transfer (no Content-Length) at 2MB,
// (3) a second capped route (/api/sessions/save),
// (4) a request just under the cap must be processed normally, not 413'd.
scenarios.push({
  name: 'bodycap-edge',
  fn: async () => {
    const cwd = freshCwd('b-bodycap-edge');
    const m = startMock([{ role: 'assistant', content: 'BODYCAP-EDGE-DONE' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 436;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'k', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', HEAVY_MODEL: 'bce-model', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    // POST with manual control over fragmentation: the body goes out as raw
    // byte fragments at the given cut offsets, each write awaited (flush
    // callback) with Nagle off so the server's 'data' handler sees separate
    // chunks and its utf8 decoder has to carry partial multibyte sequences
    // across chunk boundaries.
    const postFragmented = (pathName, buf, cuts) => new Promise((resolve, reject) => {
      const to = setTimeout(() => { try { req.destroy(); } catch (e) {} reject(new Error('client timeout waiting for response')); }, 45000);
      const req = http.request({ host: '127.0.0.1', port: srvPort, method: 'POST', path: pathName,
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length } },
        res => { let out = ''; res.on('data', d => out += d); res.on('end', () => { clearTimeout(to); resolve({ status: res.statusCode, body: out }); }); });
      req.on('error', e => { clearTimeout(to); reject(e); });
      req.setNoDelay(true);
      (async () => {
        let prev = 0;
        for (const c of cuts.concat([buf.length])) {
          await new Promise(r => req.write(buf.subarray(prev, c), r));
          prev = c;
        }
        req.end();
      })().catch(e => { clearTimeout(to); reject(e); });
    });
    // POST without Content-Length -> Node sends chunked transfer encoding;
    // still fragmented + flushed so the reader must count across many chunks.
    const postChunked = (pathName, buf, fragSize) => new Promise((resolve, reject) => {
      const to = setTimeout(() => { try { req.destroy(); } catch (e) {} reject(new Error('client timeout waiting for response')); }, 45000);
      const req = http.request({ host: '127.0.0.1', port: srvPort, method: 'POST', path: pathName,
        headers: { 'Content-Type': 'application/json' } },
        res => { let out = ''; res.on('data', d => out += d); res.on('end', () => { clearTimeout(to); resolve({ status: res.statusCode, body: out }); }); });
      req.on('error', e => { clearTimeout(to); reject(e); });
      req.setNoDelay(true);
      (async () => {
        for (let off = 0; off < buf.length; off += fragSize) {
          await new Promise(r => req.write(buf.subarray(off, Math.min(off + fragSize, buf.length)), r));
        }
        req.end();
      })().catch(e => { clearTimeout(to); reject(e); });
    });
    try {
      await new Promise(r => setTimeout(r, 2500));
      const LIMIT = 1024 * 1024; // BODY_LIMIT_DEFAULT (index.js, non-chat routes)

      // (1) '中' = 3 utf8 bytes; pad sized so the whole body is exactly
      // LIMIT+1 bytes. 64KB fragments, with the FINAL cut placed 1 byte into
      // the last '中' (bytes [len-5..len-3]) - everything before it is still
      // <= LIMIT, so the 413 verdict depends on counting the torn char's
      // remaining 2 bytes instead of dropping the partial sequence.
      const head = Buffer.byteLength(JSON.stringify({ id: 'x', approved: true, pad: '' }));
      const nPad = Math.ceil((LIMIT + 1 - head) / 3);
      const tearBody = Buffer.from(JSON.stringify({ id: 'x', approved: true, pad: '中'.repeat(nPad) }), 'utf8');
      const cuts = [];
      for (let off = 65536; off < tearBody.length - 8; off += 65536) cuts.push(off);
      cuts.push(tearBody.length - 4); // splits the last '中' across the final boundary
      const torn = await postFragmented('/api/approve', tearBody, cuts);
      record('bodycap-edge: LIMIT+1 utf8 bytes with last multibyte char torn across fragments still trips 413',
        tearBody.length === LIMIT + 1 && torn.status === 413, 'bytes=' + tearBody.length + ' fragments=' + (cuts.length + 1) + ' status=' + torn.status);
      const alive1 = await httpReq(srvPort, 'GET', '/api/info', null);
      record('bodycap-edge: server responsive after the torn-multibyte 413', alive1.status === 200, 'status=' + alive1.status);

      // (2) no Content-Length -> chunked; 2MB in flushed 64KB writes
      const chunkBody = Buffer.from(JSON.stringify({ id: 'x', approved: true, pad: 'a'.repeat(2 * 1024 * 1024) }), 'utf8');
      const chunked = await postChunked('/api/approve', chunkBody, 65536);
      record('bodycap-edge: 2MB chunked (no Content-Length) POST to /api/approve rejected 413', chunked.status === 413, 'bytes=' + chunkBody.length + ' status=' + chunked.status);
      const alive2 = await httpReq(srvPort, 'GET', '/api/info', null);
      record('bodycap-edge: server responsive after the chunked 413', alive2.status === 200, 'status=' + alive2.status);

      // (3) same cap enforced on a second non-chat route
      const saveOver = await httpReq(srvPort, 'POST', '/api/sessions/save', { messages: [{ role: 'user', content: 'c'.repeat(2 * 1024 * 1024) }] });
      record('bodycap-edge: 2MB POST to /api/sessions/save rejected 413 (second route)', saveOver.status === 413, 'status=' + saveOver.status);
      const alive3 = await httpReq(srvPort, 'GET', '/api/info', null);
      record('bodycap-edge: server responsive after the sessions/save 413', alive3.status === 200, 'status=' + alive3.status);

      // (4) ~900KB < 1MB cap: valid JSON must reach the handler -> 400
      // (unknown id), never 413.
      const under = await httpReq(srvPort, 'POST', '/api/approve', { id: 'nope', approved: true, pad: 'd'.repeat(900 * 1024) });
      record('bodycap-edge: ~900KB (under cap) POST processed normally -> 400 unknown id, not 413',
        under.status === 400 && /no pending approval/.test(under.body), 'status=' + under.status + ' body=' + String(under.body).substring(0, 80));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- B28: GAP-1 real MCP stdio transport (echo server speaks the protocol) ---
scenarios.push({
  name: 'mcp-stdio',
  fn: async () => {
    const cwd = freshCwd('b-mcp');
    fs.mkdirSync(path.join(cwd, '.7coder'), { recursive: true });
    const fwd = (p) => p.split(path.sep).join('/');
    fs.writeFileSync(path.join(cwd, '.7coder', 'mcp.json'), JSON.stringify({
      servers: { echo: { command: process.execPath, args: [fwd(path.join(ROOT, 'mcp-echo-server.js'))], env: { MCP_ECHO_LOG: fwd(path.join(cwd, 'rx.log')) } } }
    }, null, 2));
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'ms1', type: 'function', function: { name: 'mcp_list_tools_tool', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ms2', type: 'function', function: { name: 'mcp_tool', arguments: JSON.stringify({ server: 'echo', tool_name: 'echo', args: { text: 'HELLO-MCP' } }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ms3', type: 'function', function: { name: 'mcp_tool', arguments: JSON.stringify({ server: 'echo', tool_name: 'add', args: { a: 2, b: 3 } }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ms4', type: 'function', function: { name: 'mcp_tool', arguments: JSON.stringify({ server: 'echo', tool_name: 'boom', args: {} }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ms5', type: 'function', function: { name: 'mcp_tool', arguments: JSON.stringify({ server: 'ghost', tool_name: 'x' }) } }] },
      { role: 'assistant', content: 'MCP-B-DONE ' + 'mcp scenario final reply padded past the summary floor for the budget skip. '.repeat(5) }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 120000 });
    const log = readLog(m.log);
    const ms1 = tr(log, 'ms1'), ms2 = tr(log, 'ms2'), ms3 = tr(log, 'ms3'), ms4 = tr(log, 'ms4'), ms5 = tr(log, 'ms5');
    record('mcp: discovery lists server, tools and arg schemas', ms1 && ms1.c.includes('[MCP] configured servers') && ms1.c.includes('echo - Echo the given text back.') && ms1.c.includes('"text"'), ms1 ? ms1.c.substring(0, 150) : 'no result');
    record('mcp: echo tool result round-trips', ms2 && ms2.c === 'ECHO:HELLO-MCP', ms2 ? ms2.c : 'no result');
    record('mcp: add tool computes server-side', ms3 && ms3.c === '5', ms3 ? ms3.c : 'no result');
    record('mcp: isError result surfaces as MCP tool error', ms4 && ms4.c.includes('MCP tool error (echo/boom)') && ms4.c.includes('boom as requested'), ms4 ? ms4.c : 'no result');
    record('mcp: unknown server names the configured ones', ms5 && ms5.c.includes('unknown server "ghost"') && ms5.c.includes('Configured: echo'), ms5 ? ms5.c : 'no result');
    // handshake protocol assertions from the echo server's received-lines log
    const rxPath = path.join(cwd, 'rx.log');
    const rx = fs.existsSync(rxPath) ? fs.readFileSync(rxPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : [];
    const l1 = rx[0], l2 = rx[1];
    record('mcp: handshake sends initialize first with 7coder clientInfo', l1 && l1.method === 'initialize' && l1.params && l1.params.clientInfo && l1.params.clientInfo.name === '7coder' && !!l1.params.protocolVersion, rx.length ? JSON.stringify(l1).substring(0, 120) : 'no rx.log');
    record('mcp: initialized notification follows (no id)', l2 && l2.method === 'notifications/initialized' && l2.id === undefined, rx.length > 1 ? JSON.stringify(l2) : 'missing');
    const lists = rx.filter(x => x.method === 'tools/list').length;
    const calls = rx.filter(x => x.method === 'tools/call').map(x => x.params && x.params.name).join(',');
    record('mcp: tools/list cached (exactly one) and exactly 3 tools/calls reach the server (ghost never spawns)', lists === 1 && rx.filter(x => x.method === 'tools/call').length === 3 && calls === 'echo,add,boom', 'lists=' + lists + ' calls=' + calls);
    stopMock(m);
  }
});

// --- B29: GAP-8 token usage observability (/api/info usage + [USAGE] trailer) ---
scenarios.push({
  name: 'usage-track',
  fn: async () => {
    // (a) server: one non-stream chat, then /api/info must expose usage.prompt >= 100
    const cwd = freshCwd('b-usage');
    const m = startMock([{ role: 'assistant', content: 'USAGE-REPLY-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 430;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const chat = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
      const info = await httpReq(srvPort, 'GET', '/api/info', null);
      let usagePrompt = null, usageTotal = null;
      try { const j = JSON.parse(info.body); if (j.usage) { usagePrompt = j.usage.prompt; usageTotal = j.usage.total; } } catch (e) {}
      record('usage: /api/info exposes usage object with prompt >= 100 after a non-stream chat',
        chat.status === 200 && info.body.includes('usage') && typeof usagePrompt === 'number' && usagePrompt >= 100,
        'chat=' + chat.status + ' prompt=' + JSON.stringify(usagePrompt) + ' total=' + JSON.stringify(usageTotal) + ' info=' + info.body.substring(0, 160));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
    // (b) CLI one-shot task: stdout carries the [USAGE] trailer
    const cwd2 = freshCwd('b-usage-cli');
    const m2 = startMock([{ role: 'assistant', content: 'USAGE-CLI-OK' }]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m2.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd2, timeoutMs: 60000 });
    record('usage: CLI one-shot prints [USAGE] prompt=/completion= trailer', r.out.includes('[USAGE]') && r.out.includes('prompt='), r.out.substring(Math.max(0, r.out.length - 250)));
    stopMock(m2);
  }
});

// --- B30: GAP-10 web_search providers (searxng endpoint + bogus provider error) ---
scenarios.push({
  name: 'search-api',
  fn: async () => {
    // local fake searxng on a random port
    const searx = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [
        { title: 'Searx One', url: 'https://example.com/1' },
        { title: 'Searx Two', url: 'https://example.com/2' }
      ] }));
    });
    const searxPort = await new Promise(resolve => { searx.listen(0, '127.0.0.1', () => resolve(searx.address().port)); });
    try {
      const cwd = freshCwd('b-search');
      const m = startMock([
        { role: 'assistant', content: null, tool_calls: [{ id: 'se1', type: 'function', function: { name: 'web_search_tool', arguments: '{"query":"x"}' } }] },
        { role: 'assistant', content: 'SEARCH-DONE' }
      ]);
      await new Promise(r => setTimeout(r, 600));
      await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', SEARCH_PROVIDER: 'searxng', SEARCH_ENDPOINT: 'http://127.0.0.1:' + searxPort }, cwd, timeoutMs: 60000 });
      const se1 = tr(readLog(m.log), 'se1');
      record('search: searxng provider queries SEARCH_ENDPOINT and returns title/url', se1 && se1.c.includes('Searx One') && se1.c.includes('example.com'), se1 ? se1.c : 'no result');
      stopMock(m);
      // bogus provider -> explicit error naming the legal values (no network fallback)
      const cwd2 = freshCwd('b-search-bogus');
      const m2 = startMock([
        { role: 'assistant', content: null, tool_calls: [{ id: 'se2', type: 'function', function: { name: 'web_search_tool', arguments: '{"query":"x"}' } }] },
        { role: 'assistant', content: 'SEARCH2-DONE' }
      ]);
      await new Promise(r => setTimeout(r, 600));
      await runCli({ port: m2.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass', SEARCH_PROVIDER: 'bogus' }, cwd: cwd2, timeoutMs: 60000 });
      const se2 = tr(readLog(m2.log), 'se2');
      record('search: bogus SEARCH_PROVIDER -> Unknown SEARCH_PROVIDER error listing valid values',
        se2 && se2.c.includes('Unknown SEARCH_PROVIDER') && se2.c.includes('searxng') && se2.c.includes('brave') && se2.c.includes('bing') && se2.c.includes('ddg'),
        se2 ? se2.c : 'no result');
      stopMock(m2);
    } finally {
      try { searx.close(); } catch (e) {}
    }
  }
});

// --- B31: GAP-12 per-task change summary ([CHANGES] trailer) ---
scenarios.push({
  name: 'task-changes',
  fn: async () => {
    const cwd = freshCwd('b-changes');
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'orig\n');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'ch1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'A' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ch2', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'b.txt', old_string: 'orig', new_string: 'edited' }) } }] },
      { role: 'assistant', content: 'CHANGES-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    record('changes: [CHANGES] summary lists both touched files', r.out.includes('[CHANGES]') && r.out.includes('a.txt') && r.out.includes('b.txt'), r.out.substring(Math.max(0, r.out.length - 300)));
    stopMock(m);
  }
});

// --- B32: GAP-5 diagnostics_tool (tsc shim parse + no-toolchain message) ---
scenarios.push({
  name: 'diag',
  fn: async () => {
    const cwd = freshCwd('b-diag');
    fs.mkdirSync(path.join(cwd, 'node_modules', 'typescript', 'bin'), { recursive: true });
    // tsc shim: prints two fixed diagnostics and exits 2 (tsc's real exit code for problems)
    fs.writeFileSync(path.join(cwd, 'node_modules', 'typescript', 'bin', 'tsc'), [
      'console.log("src/a.ts(3,7): error TS2322: Type X is not assignable to Y");',
      'console.log("src/b.ts(1,1): error TS1005: semicolon expected");',
      'process.exit(2);'
    ].join('\n'));
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'dg1', type: 'function', function: { name: 'diagnostics_tool', arguments: '{}' } }] },
      { role: 'assistant', content: 'DIAG-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd, timeoutMs: 60000 });
    const dg1 = tr(readLog(m.log), 'dg1');
    record('diag: project-local tsc shim problems parsed as file:line code msg (exit 2 still yields stdout)',
      dg1 && dg1.c.includes('[DIAG]') && dg1.c.includes('TS2322') && dg1.c.includes('src/a.ts:3') && dg1.c.includes('src/b.ts:1'),
      dg1 ? dg1.c : 'no result');
    stopMock(m);
    // bare workspace without node_modules -> no toolchain message
    const cwd2 = freshCwd('b-diag-bare');
    const m2 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'dg2', type: 'function', function: { name: 'diagnostics_tool', arguments: '{}' } }] },
      { role: 'assistant', content: 'DIAG2-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m2.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd2, timeoutMs: 60000 });
    const dg2 = tr(readLog(m2.log), 'dg2');
    record('diag: bare workspace (no node_modules toolchain) -> clear no-toolchain message',
      dg2 && dg2.c.includes('no toolchain found'), dg2 ? dg2.c : 'no result');
    stopMock(m2);
  }
});

// --- B33: GAP-11 user permission rules + AST-R2 decline reasons ---
scenarios.push({
  name: 'perm-rules',
  fn: async () => {
    // GAP-11 deny: blocks in EVERY mode (checked even before auto-safe)
    const cwd1 = freshCwd('b-perm1');
    fs.mkdirSync(path.join(cwd1, '.7coder'), { recursive: true });
    fs.writeFileSync(path.join(cwd1, '.7coder', 'permissions.json'), JSON.stringify({
      deny: ['read_file(blocked.txt)', 'write_file(forbidden/**)'],
      allow: ['write_file(scratch/**)'],
      protected_extra: ['*.key', 'secretzone/**']
    }));
    fs.writeFileSync(path.join(cwd1, 'blocked.txt'), 'SECRET-DATA');
    const m1 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'pr1', type: 'function', function: { name: 'read_file', arguments: '{"path":"blocked.txt"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'pr2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'forbidden/x.txt', content: 'X' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'pr3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'scratch/free.txt', content: 'S' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'pr4', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'master.key', content: 'K' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'pr5', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'secretzone/deep/plan.txt', content: 'Z' }) } }] },
      { role: 'assistant', content: 'PR-DONE ' + 'perm scenario final reply padded past the summary floor for the budget skip rule. '.repeat(5) }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m1.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd1, timeoutMs: 60000 });
    const l1 = readLog(m1.log);
    const pr1 = tr(l1, 'pr1'), pr2 = tr(l1, 'pr2'), pr3 = tr(l1, 'pr3'), pr4 = tr(l1, 'pr4'), pr5 = tr(l1, 'pr5');
    record('perm: deny rule blocks a normally auto-safe read even in bypass', pr1 && pr1.c.includes('BLOCKED by user permission rule: read_file(blocked.txt)'), pr1 ? pr1.c.substring(0, 120) : 'no result');
    record('perm: deny path glob blocks the write and nothing lands', pr2 && pr2.c.includes('BLOCKED by user permission rule') && !fs.existsSync(path.join(cwd1, 'forbidden', 'x.txt')), pr2 ? pr2.c.substring(0, 120) : 'no result');
    record('perm: allow rule auto-executes a would-be-approved write (no prompt needed)', pr3 && pr3.c.includes('Written: scratch') && fs.existsSync(path.join(cwd1, 'scratch', 'free.txt')), pr3 ? pr3.c : 'no result');
    record('perm: protected_extra glob guards a custom extension', pr4 && pr4.c.includes('BLOCKED: protected file') && !fs.existsSync(path.join(cwd1, 'master.key')), pr4 ? pr4.c.substring(0, 120) : 'no result');
    record('perm: protected_extra dir pattern guards a nested zone', pr5 && pr5.c.includes('BLOCKED: protected file') && !fs.existsSync(path.join(cwd1, 'secretzone', 'deep', 'plan.txt')), pr5 ? pr5.c.substring(0, 120) : 'no result');
    stopMock(m1);

    // allow can NEVER beat the hard rails: allow the .env write, still blocked
    const cwd2 = freshCwd('b-perm2');
    fs.mkdirSync(path.join(cwd2, '.7coder'), { recursive: true });
    fs.writeFileSync(path.join(cwd2, '.7coder', 'permissions.json'), JSON.stringify({ allow: ['write_file(*)'] }));
    fs.writeFileSync(path.join(cwd2, '.env'), 'KEEP=ME\n');
    const m2 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'pr6', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '.env', content: 'HACKED=1' }) } }] },
      { role: 'assistant', content: 'PR2-DONE ' + 'perm hard-rail scenario reply padded past the summary floor for the budget skip. '.repeat(5) }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m2.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd: cwd2, timeoutMs: 60000 });
    const pr6 = tr(readLog(m2.log), 'pr6');
    record('perm: allow(*) cannot override the built-in protected-file rail', pr6 && pr6.c.includes('BLOCKED: protected file') && fs.readFileSync(path.join(cwd2, '.env'), 'utf8').includes('KEEP=ME'), pr6 ? pr6.c.substring(0, 120) : 'no result');
    stopMock(m2);

    // AST-R2: a NO verdict with a reason lands in the audit log
    const cwd3 = freshCwd('b-perm3');
    const m3 = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'pr7', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'X' }) } }] },
      { role: 'assistant', content: '{"safe": false, "reason": "writes outside the source tree are not allowed here"}' }, // light model says NO + why
      { role: 'assistant', content: 'PR3-DONE ' + 'perm ast-r2 scenario reply padded past the summary floor for the budget skip. '.repeat(5) }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m3.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'auto' }, cwd: cwd3, timeoutMs: 60000 });
    const pr7 = tr(readLog(m3.log), 'pr7');
    record('perm: structured decline carries the reason to the model', pr7 && pr7.c.includes('Auto-approval declined') && pr7.c.includes('Reason: writes outside the source tree'), pr7 ? pr7.c.substring(0, 160) : 'no result');
    const auditPath3 = path.join(cwd3, '.7coder', 'audit.jsonl');
    let reasonLogged = '(no audit)';
    if (fs.existsSync(auditPath3)) {
      const entries = fs.readFileSync(auditPath3, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      const dec = entries.find(e => e.type === 'approval_decline');
      if (dec) reasonLogged = dec.reason || '(empty reason)';
    }
    record('perm: decline reason lands as approval_decline audit entry', reasonLogged.indexOf('writes outside the source tree') === 0, 'reason=' + reasonLogged);
    stopMock(m3);
  }
});

// ====================== RUNNER ======================
S.runAll(scenarios);
