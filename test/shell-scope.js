const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const S = require('./_shared').create({ suite: 'shell-scope' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set(), recorded = [];
let fixture, checks = 0;
const deadline = setTimeout(() => { console.error('SHELL/SCOPE deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
async function until(predicate, label) {
  const end = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() >= end) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
(async () => {
  try {
    const ctx = vm.createContext({ Buffer, console: { log() {}, warn() {} }, agentDepth: 0, workflowStepDepth: 0,
      PERMISSION_MODE: 'bypass', subAgentModeOverride: null, systemPrompt: 'fixture', DANGER_MODE: true, ENABLE_HTTP_SERVER: true,
      tools: [{ function: { name: 'bash_tool' } }, { function: { name: 'read_file' } }],
      findBash() { throw Error('HTTP must not resolve bash'); }, getPersistentShell() { throw Error('HTTP must not acquire shell'); } });
    vm.runInContext(cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
      cut('async function runSubAgent(', 'function pruneTasks()') +
      cut('function shellSessionKey()', 'function createPersistentShell(') +
      'const persistentShells=new Map();' + cut('function disposePersistentShell(', '// Converts a glob pattern') +
      'async function bash(args,cancelled) { const name="bash_tool";\n' + cut("  if (name === 'bash_tool') {", "  if (name === 'powershell_tool') {") + '\n}' +
      'async function workflow(args,cancelled) { const name="workflow_tool",conversation=[],approvalBridge=null,modelContext={};\n' +
      cut("  if (name === 'workflow_tool') {", '// ====================== TEST RUNNER PARSING') + '\n}' +
      'this.shells=persistentShells;', ctx);
    const blocked = await ctx.bash({ persistent: true, command: 'must not execute' });
    check('HTTP persistent request is blocked before lookup even in danger mode', blocked.status === 'blocked' && blocked.data.exitCode === null && blocked.text.includes('explicit cwd/env'));
    ctx.ENABLE_HTTP_SERVER = false; ctx.getPersistentShell = () => ({ run: async () => ({ code: 0, restarted: false, out: 'CLI_OK' }) });
    check('CLI persistent request retains its existing result contract', (await ctx.bash({ persistent: true, command: 'echo CLI_OK' })).text.includes('CLI_OK'));
    let disposed = [];
    const install = key => { const shell = { dispose() { disposed.push(key); } }; ctx.shells.set(key, shell); return shell; };
    const main = install('main');
    let starts = 0;
    ctx.processWithTools = async () => {
      check('each sub-agent starts without a predecessor shell', !ctx.shells.has(ctx.shellSessionKey()));
      install(ctx.shellSessionKey()); starts++; return 'SUB_DONE';
    };
    await ctx.runSubAgent('one', 'one'); await ctx.runSubAgent('two', 'two');
    check('sub-agent scope releases its shell without touching main conversation', starts === 2 && disposed.length === 2 && ctx.shells.get('main') === main && ctx.agentDepth === 0);
    ctx.processWithTools = async () => { install(ctx.shellSessionKey()); throw Error('model failed'); };
    check('sub-agent model failure still releases shell and restores permission state', (await ctx.runSubAgent('fail', 'fail')).status === 'error' && !ctx.shells.has('agent-1') && ctx.agentDepth === 0 && ctx.subAgentModeOverride === null);
    let cancelled = false;
    ctx.processWithTools = async () => { install(ctx.shellSessionKey()); cancelled = true; return 'late answer'; };
    check('sub-agent cancellation also retires its scope', (await ctx.runSubAgent('cancel', 'cancel', () => cancelled)).status === 'cancelled' && !ctx.shells.has('agent-1'));

    ctx.safeExecuteTool = async () => { install(ctx.shellSessionKey()); return ctx.makeToolResult('ok', 'done'); };
    await ctx.workflow({ steps: [{ tool: 'bash_tool' }] }, () => false);
    check('completed root workflow cannot leak cwd/env into the next workflow', !ctx.shells.has('wf-1') && ctx.workflowStepDepth === 0 && ctx.shells.get('main') === main);
    ctx.safeExecuteTool = async () => { install(ctx.shellSessionKey()); throw Error('step crashed'); };
    try { await ctx.workflow({ steps: [{ tool: 'bash_tool' }] }, () => false); } catch (error) { assert.strictEqual(error.message, 'step crashed'); }
    check('workflow exception releases shell and depth', !ctx.shells.has('wf-1') && ctx.workflowStepDepth === 0);
    ctx.processWithTools = async () => {
      install(ctx.shellSessionKey());
      ctx.safeExecuteTool = async () => ctx.makeToolResult('ok', 'done');
      await ctx.workflow({ steps: [{ tool: 'read_file' }] }, () => false);
      check('workflow inside an agent does not dispose the enclosing agent shell early', ctx.shells.has('agent-1'));
      return 'agent done';
    };
    await ctx.runSubAgent('nested-flow', 'nested-flow');
    check('enclosing agent eventually releases the shared inner-workflow shell', !ctx.shells.has('agent-1'));

    const seen = new Set();
    fixture = http.createServer((req, res) => {
      let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
        const body = JSON.parse(raw), isSub = String(body.messages[0].content).includes('running as a SUB-AGENT');
        const job = (body.messages.map(m => String(m.content || '')).join('\n').match(/SCOPE_[A-Z]+/) || [''])[0];
        for (const message of body.messages) if (message.role === 'tool') recorded.push({ job, isSub, content: message.content });
        const key = job + ':' + isSub; let message;
        const tc = (name, args) => ({ role: 'assistant', tool_calls: [{ id: key, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        if (seen.has(key)) message = { role: 'assistant', content: 'SCOPE_DONE' };
        else {
          seen.add(key);
          if (job === 'SCOPE_AGENT' && !isSub) message = tc('agent_tool', { name: 'http-agent', task: 'SCOPE_AGENT' });
          else if (job === 'SCOPE_WORKFLOW') message = tc('workflow_tool', { steps: [
            { tool: 'bash_tool', args: { persistent: true, command: 'echo forbidden > scope-leak.txt' } },
            { tool: 'write_file', args: { path: 'after-block.txt', content: 'must not execute' } }
          ] });
          else message = tc('bash_tool', { persistent: true, command: 'echo forbidden > scope-leak.txt' });
        }
        if (body.stream) {
          const delta = Object.assign({}, message); delete delta.role;
          if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => Object.assign({ index }, call));
          res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        } else res.end(JSON.stringify({ choices: [{ message }] }));
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const cwd = S.freshCwd('scope-http');
    const child = S.spawn(S.NODE_BIN, [S.IDX, '--server', '--danger'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, {
      HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', OPENAI_ENDPOINT: 'http://127.0.0.1:' + fixture.address().port,
      OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', LIGHT_MODEL: '', SUMMARY_MODEL: '', DREAM_ALLOW: 'false', MAX_RETRIES: '1'
    }) });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    const api = (method, url, data = null) => S.httpReq(port, method, url, data);
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(output);
      try { return (await api('GET', '/api/info')).status === 200; } catch (error) { if (error.code !== 'ECONNREFUSED') throw error; return false; }
    }, 'HTTP ready');
    check('server advertises the disabled persistent capability', JSON.parse((await api('GET', '/api/info')).body).capabilities.persistentShell === false);
    for (const job of ['SCOPE_FIRST', 'SCOPE_SECOND', 'SCOPE_AGENT', 'SCOPE_WORKFLOW']) {
      const result = await api('POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: job }] });
      check('real HTTP ' + job + ' returns explicit blocked evidence', result.status === 200 && recorded.some(item => item.job === job && item.content.includes('Persistent bash is disabled')));
    }
    check('blocked direct, agent and workflow calls create no files', !fs.existsSync(path.join(cwd, 'scope-leak.txt')) && !fs.existsSync(path.join(cwd, 'after-block.txt')));
    console.log('SHELL/SCOPE ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline); S.cleanup(); for (const socket of sockets) socket.destroy();
    if (fixture) await new Promise(resolve => fixture.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
