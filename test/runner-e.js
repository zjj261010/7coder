// Suite E: streaming UTF-8 integrity, fuzzing invariants, sub-agent permission
// downgrade, real MCP /invoke flow, real process kill, HTTP keep-alive and
// 100-turn histories, 7CODER.md concurrent consistency, worktree spaces.
// Usage: node test/runner-e.js   (RUN_ONLY=..., NODE_BIN=... as in the other suites)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// OPT-4: duplicated helpers now live in test/_shared.js (single implementation).
const S = require('./_shared').create({ suite: 'E', wsPrefix: 'w-e-' });
const { ROOT, IDX, NODE_BIN, RUN_ONLY, record, startProcessAt, freshCwd, runCli, httpReq, stopMock, readLog, toolResults, tr, rmrf } = S;
let port = 18150;
function startMock(scriptObj, customFile, extraEnv) { port += 1; return startProcessAt(port, null, scriptObj, extraEnv, customFile); }
function pairingValid(messages) {
  const roles = messages.map(x => x.role);
  for (let i = 0; i < roles.length; i++) {
    if (roles[i] === 'tool' && (i === 0 || (roles[i - 1] !== 'assistant' && roles[i - 1] !== 'tool'))) return false;
  }
  return true;
}

// ====================== SCENARIOS ======================
const scenarios = [];

// --- E1: streaming with a multibyte UTF-8 char split across TCP chunks ---
scenarios.push({
  name: 'stream-utf8',
  fn: async () => {
    const cwd = freshCwd('e1');
    port += 1;
    const splitPort = port;
    const srv = spawn(NODE_BIN, ['-e', `
      const http = require('http');
      http.createServer((q, s) => {
        let b = '';
        q.on('data', c => b += c);
        q.on('end', () => {
          const line = 'data: ' + JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: '前置-中文完整性-测试-後置' }, finish_reason: null }] }) + '\\n\\n';
          const buf = Buffer.from(line + 'data: [DONE]\\n\\n', 'utf8');
          const cjkBytes = Buffer.from('中', 'utf8');
          // split ONE BYTE INTO the multibyte char - the real-world TCP truncation case
          const splitAt = buf.indexOf(cjkBytes[0]) + 1;
          s.writeHead(200, { 'Content-Type': 'text/event-stream' });
          s.write(buf.slice(0, splitAt));
          setTimeout(() => {
            s.write(buf.slice(splitAt));
            s.end();
          }, 80);
        });
      }).listen(${splitPort}, '127.0.0.1');
    `], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 800));
    const m = startMock([{ role: 'assistant', content: 'E1-NEVER' }]);
    stopMock(m); // not used; keep port accounting simple
    const r = await runCli({
      port: splitPort, args: ['-m=', 'bypass'], env: { PERMISSION_MODE: 'bypass' }, cwd,
      stdinSteps: [{ t: 'task\n', d: 100 }, { t: '/execute-task-now\n', d: 4000 }, { t: '/bye\n', d: 400 }]
    });
    srv.kill();
    record('stream-utf8: CJK split across TCP chunks survives intact',
      r.out.includes('前置-中文完整性-测试-後置') && !r.out.includes('\uFFFD'),
      JSON.stringify(r.out.substring(r.out.indexOf('7coder is'), r.out.indexOf('7coder is') + 200)));
  }
});

// --- E2: fuzzing - 60 random tool calls, four invariants ---
scenarios.push({
  name: 'fuzz',
  fn: async () => {
    const cwd = freshCwd('e2');
    // deterministic LCG so failures reproduce
    let seed = 424242;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const weirdStrings = ['', 'normal.txt', '你好/文件.txt', 'a\\b\\c', '../../up.txt', 'x'.repeat(500), '{"nested":true}', 'CON', '*.txt', '-flag', '  spaces  ', '\t'];
    const tools = ['read_file', 'write_file', 'append_file', 'edit_file', 'glob_tool', 'grep_tool', 'list_dir', 'brief_tool', 'prompt_from_file', 'sleep_tool', 'todo_write_tool', 'notebook_edit_tool', 'skill_tool', 'read_mcp_resource_tool', 'download_tool', 'process_list_tool', 'cron_list_tool', 'tool_search_tool'];
    const mutators = [
      () => ({}),
      () => ({ path: pick(weirdStrings) }),
      () => ({ path: pick(weirdStrings), content: pick(weirdStrings) }),
      () => ({ path: 42 }),
      () => ({ pattern: pick(weirdStrings), path: pick(weirdStrings) }),
      () => ({ path: pick(weirdStrings), old_string: pick(weirdStrings), new_string: null }),
      () => ({ url: pick(['', 'http://127.0.0.1:1/x', 'ftp://bad']), path: pick(weirdStrings) }),
      () => ({ skill_name: pick(['ok-name', '../evil', '', 'x'.repeat(100)]) }),
      () => ({ command: undefined }),
      () => ({ task_id: null }),
      () => ({ resource_id: '../../.env' }),
      () => ({ ms: 'not-a-number' })
    ];
    const script = [];
    for (let i = 0; i < 60; i++) {
      const tool = pick(tools);
      const argsObj = pick(mutators)();
      script.push({ role: 'assistant', content: null, tool_calls: [{ id: 'fz' + i, type: 'function', function: { name: tool, arguments: JSON.stringify(argsObj) } }] });
    }
    script.push({ role: 'assistant', content: 'FUZZ-SURVIVED' });
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const t0 = Date.now();
    const r = await runCli({ port: m.port, args: ['--prompt', 'fuzz'], env: { PERMISSION_MODE: 'bypass', MAX_TOOL_STEPS: '80' }, cwd, timeoutMs: 120000 });
    const elapsed = Date.now() - t0;
    const log = readLog(m.log);
    const all = toolResults(log);
    const allStrings = all.every(t => typeof t.c === 'string');
    let pairing = true;
    for (const req of log) if (!pairingValid(req.messages || [])) pairing = false;
    const results60 = ['fz0', 'fz59'].every(id => all.some(t => t.id === id));
    record('fuzz: process survives 60 mutated tool calls', r.out.includes('FUZZ-SURVIVED') && r.code === 0, r.out.substring(0, 120));
    record('fuzz: every tool result is a string', allStrings && results60, 'results=' + all.length);
    record('fuzz: message pairing valid in every request', pairing, '');
    record('fuzz: bounded execution (< 90s for 60 calls)', elapsed < 90000, 'elapsed=' + Math.round(elapsed / 1000) + 's');
    stopMock(m);
  }
});

// --- E3: sub-agent permission downgrade (default main -> auto sub) ---
scenarios.push({
  name: 'subagent-downgrade',
  fn: async () => {
    // A8: agent_tool approval is now deterministic (no light steps for
    // classify/explain); the sub-agent's append_file still hits the light
    // model once for auto-approval.
    const cwd = freshCwd('e3');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'ag1', type: 'function', function: { name: 'agent_tool', arguments: JSON.stringify({ name: 'worker', task: 'append a line' }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'ag2', type: 'function', function: { name: 'append_file', arguments: JSON.stringify({ path: 'sub.txt', content: 'SUBWORK' }) } }] },
      { role: 'assistant', content: 'YES' },
      { role: 'assistant', content: 'SUB-FINISHED' },
      { role: 'assistant', content: 'E3-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({
      port: m.port, args: [], cwd,
      stdinSteps: [
        { t: 'delegate\n', d: 100 }, { t: '/execute-task-now\n', d: 4000 },
        { t: 'y\n', d: 4000 },
        { t: '/bye\n', d: 500 }
      ]
    });
    const prompts = (r.out.match(/Execute agent_tool/g) || []).length;
    const subPrompts = (r.out.match(/Execute append_file/g) || []).length;
    record('subagent: main approval asked exactly once', prompts === 1, 'prompts=' + prompts);
    record('subagent: sub-agent tools run WITHOUT re-approval (auto downgrade)', subPrompts === 0 && fs.existsSync(path.join(cwd, 'sub.txt')), 'subPrompts=' + subPrompts);
    record('subagent: sub-agent work landed and result returned', r.out.includes('E3-DONE') && fs.readFileSync(path.join(cwd, 'sub.txt'), 'utf8') === 'SUBWORK', '');
    stopMock(m);
  }
});

// --- E4: agent_tool declined in non-interactive default mode ---
scenarios.push({
  name: 'agent-noninteractive',
  fn: async () => {
    const cwd = freshCwd('e4');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'ag3', type: 'function', function: { name: 'agent_tool', arguments: JSON.stringify({ name: 'w', task: 't' }) } }] },
      { role: 'assistant', content: 'E4-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    const r = await runCli({ port: m.port, args: ['--prompt', 't'], cwd });
    record('subagent: declined cleanly in non-interactive default mode', tr(readLog(m.log), 'ag3') && tr(readLog(m.log), 'ag3').c.includes('User declined') && r.out.includes('E4-DONE'), tr(readLog(m.log), 'ag3') ? tr(readLog(m.log), 'ag3').c : 'no result');
    stopMock(m);
  }
});

// --- E5: real MCP /invoke flow ---
scenarios.push({
  name: 'mcp-invoke',
  fn: async () => {
    const cwd = freshCwd('e5');
    port += 1;
    const mcpPort = port;
    const srv = spawn(NODE_BIN, ['-e', 'const http=require("http");http.createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{ if(q.url==="/invoke"){s.writeHead(200,{"Content-Type":"application/json"});s.end(JSON.stringify({result:"MCP-INVOKE-OK",echo:JSON.parse(b||"{}")}))}else{s.writeHead(404);s.end()}})}).listen(' + mcpPort + ',"127.0.0.1")'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 700));
    const deadPort = mcpPort + 50;
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'mc1', type: 'function', function: { name: 'mcp_tool', arguments: JSON.stringify({ tool_name: 'echo', args: { hello: 'world' }, mcp_url: 'http://127.0.0.1:' + mcpPort }) } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'mc2', type: 'function', function: { name: 'mcp_tool', arguments: JSON.stringify({ tool_name: 'echo', mcp_url: 'http://127.0.0.1:' + deadPort }) } }] },
      { role: 'assistant', content: 'E5-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const ok = tr(readLog(m.log), 'mc1');
    const err = tr(readLog(m.log), 'mc2');
    record('mcp: /invoke round-trip returns server result', ok && ok.c.includes('MCP-INVOKE-OK') && ok.c.includes('hello'), ok ? ok.c.substring(0, 80) : 'no result');
    record('mcp: dead server -> clean error string', err && err.c.includes('MCP external error'), err ? err.c.substring(0, 80) : 'no result');
    srv.kill();
    stopMock(m);
  }
});

// --- E6: prompt_from_file ---
scenarios.push({
  name: 'prompt-file',
  fn: async () => {
    const cwd = freshCwd('e6');
    fs.writeFileSync(path.join(cwd, 'TODO.md'), 'THE-PROMPT-CONTENT');
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'pf1', type: 'function', function: { name: 'prompt_from_file', arguments: '{"file":"TODO.md"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'pf2', type: 'function', function: { name: 'prompt_from_file', arguments: '{"file":"missing.md"}' } }] },
      { role: 'assistant', content: 'E6-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const log = readLog(m.log);
    record('prompt_from_file: reads file content', tr(log, 'pf1') && tr(log, 'pf1').c === 'THE-PROMPT-CONTENT', tr(log, 'pf1') ? tr(log, 'pf1').c : 'no result');
    record('prompt_from_file: missing file -> clean error', tr(log, 'pf2') && tr(log, 'pf2').c.includes('not found'), '');
    stopMock(m);
  }
});

// --- E7: process_kill_tool kills a real process ---
scenarios.push({
  name: 'kill-real',
  fn: async () => {
    const cwd = freshCwd('e7');
    const heart = path.join(cwd, 'heartbeat.txt');
    const sleeper = spawn(NODE_BIN, ['-e', 'const fs=require("fs");const i=setInterval(()=>{fs.appendFileSync(' + JSON.stringify(heart) + ', Date.now()+"\\n")},150)'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 800));
    const beatsBefore = fs.existsSync(heart) ? fs.readFileSync(heart, 'utf8').trim().split('\n').length : 0;
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'k1', type: 'function', function: { name: 'process_kill_tool', arguments: JSON.stringify({ pid: sleeper.pid }) } }] },
      { role: 'assistant', content: 'E7-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    await new Promise(r => setTimeout(r, 700));
    const beats1 = fs.existsSync(heart) ? fs.readFileSync(heart, 'utf8').trim().split('\n').length : 0;
    await new Promise(r => setTimeout(r, 700));
    const beats2 = fs.existsSync(heart) ? fs.readFileSync(heart, 'utf8').trim().split('\n').length : 0;
    record('kill: real process terminated by PID', beatsBefore >= 2 && beats1 >= beatsBefore && beats1 === beats2, 'beats1=' + beats1 + ' beats2=' + beats2 + ' (equal = dead) result=' + (tr(readLog(m.log), 'k1') ? tr(readLog(m.log), 'k1').c.substring(0, 40) : 'no result'));
    try { sleeper.kill(); } catch (e) {}
    stopMock(m);
  }
});

// --- E8: HTTP keep-alive, client model ignored, 100-turn history, tool-role dropped ---
scenarios.push({
  name: 'http-adv',
  fn: async () => {
    const cwd = freshCwd('e8');
    const script = [];
    for (let i = 0; i < 4; i++) script.push({ role: 'assistant', content: 'E8-REPLY-' + i });
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 240;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort), HEAVY_MODEL: 'heavy-e8' }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      const agent = new http.Agent({ keepAlive: true });
      const r1 = await httpReq(srvPort, 'POST', '/v1/chat/completions', { model: 'client-says-what', messages: [{ role: 'user', content: 'one' }] }, null, agent);
      const r2 = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'two' }] }, null, agent);
      record('keepalive: two requests on one connection both 200', r1.status === 200 && r2.status === 200, r1.status + '/' + r2.status);
      record('contract: response echoes client model; default falls back to server model', JSON.parse(r1.body).model === 'client-says-what' && JSON.parse(r2.body).model === 'heavy-e8', JSON.parse(r1.body).model + ' / ' + JSON.parse(r2.body).model);
      // 100-turn history + a stray tool-role message
      const msgs = [];
      for (let i = 0; i < 50; i++) { msgs.push({ role: 'user', content: 'u' + i }); msgs.push({ role: 'assistant', content: 'a' + i }); }
      msgs.push({ role: 'tool', tool_call_id: 'x', content: 'stray' });
      msgs.push({ role: 'user', content: 'final question' });
      const big = await httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: msgs }, null, agent);
      const lastReq = readLog(m.log).find(x => (x.messages || []).length >= 101);
      record('httpx: 100-turn history accepted', big.status === 200, 'status=' + big.status);
      record('httpx: history preserved, stray tool-role dropped, first turn seeded', lastReq && lastReq.messages.length >= 101 && !lastReq.messages.some(x => x.role === 'tool') && String((lastReq.messages.find(x => x.role === 'user') || {}).content || '').startsWith('u0'), lastReq ? 'len=' + lastReq.messages.length + ' roles=' + JSON.stringify(lastReq.messages.reduce((a, m) => { a[m.role] = (a[m.role] || 0) + 1; return a; }, {})) : 'no req');
      agent.destroy();
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- E9: 7CODER.md concurrent final consistency ---
scenarios.push({
  name: 'summary-race',
  fn: async () => {
    const cwd = freshCwd('e9');
    const script = [];
    for (let i = 0; i < 4; i++) script.push({ role: 'assistant', content: 'RACE-REPLY-' + i });
    const m = startMock(script);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 250;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort) }),
      cwd, stdio: 'ignore'
    });
    await new Promise(r => setTimeout(r, 2500));
    try {
      await Promise.all([
        httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'a' }] }),
        httpReq(srvPort, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'b' }] })
      ]);
      const md = fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8');
      const lines = md.split('\n').filter(Boolean);
      const validLog = lines.every(l => l.startsWith('<!-- 7coder:auto-log') || l.startsWith('- '));
      record('summary-race: concurrent writes leave a valid marker/bullet log', lines.length >= 4 && validLog, JSON.stringify(md.substring(0, 120)));
    } finally {
      try { srv.kill(); } catch (e) {}
      stopMock(m);
    }
  }
});

// --- E10: worktree path with spaces ---
scenarios.push({
  name: 'worktree-space',
  fn: async () => {
    const cwd = freshCwd('e10');
    spawnSync('git', ['init'], { cwd });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd });
    spawnSync('git', ['config', 'user.name', 't'], { cwd });
    fs.writeFileSync(path.join(cwd, 's.txt'), 'x\n');
    spawnSync('git', ['add', '.'], { cwd });
    spawnSync('git', ['commit', '-m', 'i'], { cwd });
    const m = startMock([
      { role: 'assistant', content: null, tool_calls: [{ id: 'wt1', type: 'function', function: { name: 'enter_worktree_tool', arguments: JSON.stringify({ path: 'wt dir/two' }) } }] },
      { role: 'assistant', content: 'E10-DONE' }
    ]);
    await new Promise(r => setTimeout(r, 600));
    await runCli({ port: m.port, args: ['--prompt', 't'], env: { PERMISSION_MODE: 'bypass' }, cwd });
    const res = tr(readLog(m.log), 'wt1');
    record('worktree: path with spaces creates worktree', res && res.c.includes('Entered worktree') && fs.existsSync(path.join(cwd, 'wt dir/two')), res ? res.c.substring(0, 60) : 'no result');
    spawnSync('git', ['worktree', 'prune'], { cwd });
    stopMock(m);
  }
});

// --- E11: 0.0.0.0 bind warns without API key, still reachable locally ---
scenarios.push({
  name: 'bind-warn',
  fn: async () => {
    const cwd = freshCwd('e11');
    const m = startMock([{ role: 'assistant', content: 'unused' }]);
    await new Promise(r => setTimeout(r, 600));
    const srvPort = port + 260;
    const srv = spawn(NODE_BIN, [IDX, '--server'], {
      env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:' + m.port + '/v1', MAX_RETRIES: '1', HTTP_PORT: String(srvPort), HTTP_BIND: '0.0.0.0' }),
      cwd, stdio: ['ignore', 'pipe', 'pipe']
    });
    let sout = '';
    srv.stdout.on('data', d => sout += d.toString());
    srv.stderr.on('data', d => sout += d.toString());
    await new Promise(r => setTimeout(r, 2500));
    let reachable = false;
    try { reachable = (await httpReq(srvPort, 'GET', '/v1/models', null)).status === 200; } catch (e) {}
    record('bind: non-loopback without key prints loud warning', sout.includes('anyone on the network'), sout.substring(0, 150));
    record('bind: 0.0.0.0 bind still serves locally (documented escape hatch)', reachable, 'reachable=' + reachable);
    srv.kill();
    stopMock(m);
  }
});

// ====================== RUNNER ======================
S.runAll(scenarios);
