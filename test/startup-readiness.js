const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm');
const S = require('./_shared').create({ suite: 'startup-readiness' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set(), agents = [], held = [], seen = [];
let fixture, checks = 0;
const deadline = setTimeout(() => { console.error('STARTUP/READINESS deadline'); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
async function until(predicate, label) {
  const end = Date.now() + 6000;
  while (!await predicate()) { if (Date.now() >= end) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function port() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const n = server.address().port; await new Promise(resolve => server.close(resolve)); return n; }
function send(res, body, content) {
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
}
async function backend(name, extra = {}, prompt, cwd, selectedPort) {
  const p = selectedPort || await port(); cwd = cwd || S.freshCwd(name);
  const child = S.spawn(S.NODE_BIN, [S.IDX, '--server'].concat(prompt ? ['--prompt', prompt] : []), { cwd,
    env: Object.assign({}, process.env, { HTTP_PORT: String(p), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '',
      OPENAI_ENDPOINT: 'http://127.0.0.1:' + fixture.address().port, OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', LIGHT_MODEL: '', SUMMARY_MODEL: '',
      PERMISSION_MODE: 'bypass', DREAM_ALLOW: 'true', MAX_RETRIES: '1', EXECUTION_TIMEOUT_MS: '10000' }, extra) });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const api = (method, url, data = null) => S.httpReq(p, method, url, data);
  const info = async () => JSON.parse((await api('GET', '/api/info')).body);
  const result = { child, cwd, port: p, api, info, output: () => output }; agents.push(result); return result;
}
async function ready(app) {
  await until(async () => {
    if (app.child.exitCode !== null || app.child.signalCode !== null) throw Error('Agent exited before readiness: ' + app.output());
    try { return (await app.api('GET', '/api/info')).status === 200; }
    catch (error) { if (error.code !== 'ECONNREFUSED') throw error; return false; }
  }, 'HTTP ready');
}
(async () => {
  try {
    const ctx = vm.createContext({ Buffer, Date, setTimeout, clearTimeout, setInterval, clearInterval,
      EXECUTION_TIMEOUT_MS: 5000, console: { warn() {} }, shuttingDown: false,
      triggerDreamIfNeeded: async () => { throw Error('EROFS preflight fixture'); } });
    vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') +
      cut('const CHAT_MAX_REQUESTS =', 'function effectivePermissionMode()') +
      cut('const serverStartupState =', '// AST-10: bounded JSON body reader') +
      'this.state=()=>({startup:serverStartupState,gate:requestGateBusy,controls:createExecutionControl.active.size});', ctx);
    await ctx.runServerDream({ main: 'fixture' });
    check('optional preflight failure releases gate/control and remains diagnostic', ctx.state().startup.phase === 'failed' && ctx.state().startup.error.includes('EROFS') && !ctx.state().gate && ctx.state().controls === 0);
    ctx.triggerDreamIfNeeded = async (model, token) => ctx.waitForExecution(5000, token);
    const optional = ctx.runServerDream({ main: 'fixture' });
    await until(() => ctx.state().startup.phase === 'dream', 'unit dream enters');
    ctx.preemptServerDream(); await optional;
    check('foreground preemption cancels optional startup and waits for its settlement', ctx.state().startup.phase === 'cancelled' && !ctx.state().gate && ctx.state().controls === 0);

    fixture = http.createServer((req, res) => {
      let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
        const body = JSON.parse(raw), dream = String(body.messages[0].content).includes('DREAM MODE OVERRIDE');
        const content = body.messages.map(m => String(m.content || '')).join('\n');
        const job = (content.match(/BOOT_[A-Z_]+/) || [''])[0];
        const item = { dream, job, closed: false }; seen.push(item); res.on('close', () => { item.closed = true; });
        if (dream) { held.push({ item, release: () => send(res, body, 'Dream complete') }); return; }
        if (job === 'BOOT_EXPLICIT') { held.push({ item, release: () => send(res, body, 'Explicit startup complete') }); return; }
        if (job === 'BOOT_FAILURE') { res.statusCode = 503; res.end('{}'); return; }
        send(res, body, 'OK ' + job);
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const beforeDream = held.length, app = await backend('preempt'); await ready(app);
    await until(() => held.length > beforeDream, 'startup dream model wait');
    check('real UI/info listen while optional dream is stalled', (await app.api('GET', '/')).status === 200 && (await app.info()).startup.phase === 'dream' && fs.existsSync(path.join(app.cwd, '.7coder', 'dream.lock')));
    const chat = await app.api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'BOOT_FOREGROUND' }] });
    await until(() => held[beforeDream].item.closed, 'preempted upstream close');
    check('real foreground chat preempts dream, removes its lock and completes', chat.status === 200 && chat.body.includes('OK BOOT_FOREGROUND') && !fs.existsSync(path.join(app.cwd, '.7coder', 'dream.lock')));
    check('startup info exposes preemption and core remains available', (await app.info()).startup.phase === 'cancelled' && !(await app.info()).load.chatActive);

    const timeout = await backend('timeout', { EXECUTION_TIMEOUT_MS: '1000' }); await ready(timeout);
    await until(async () => (await timeout.info()).startup.phase === 'cancelled', 'startup deadline');
    check('startup dream deadline clears owned lock without a false success marker', !fs.existsSync(path.join(timeout.cwd, '.7coder', 'dream.lock')) && !fs.existsSync(path.join(timeout.cwd, '.7coder', 'last_interaction')));
    check('server accepts a task after optional startup timeout', (await timeout.api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'BOOT_AFTER_TIMEOUT' }] })).body.includes('OK BOOT_AFTER_TIMEOUT'));

    const occupied = http.createServer(); await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    try {
      const count = seen.length, blocked = await backend('occupied', {}, 'BOOT_MUST_NOT_START', null, occupied.address().port);
      await until(() => blocked.child.exitCode !== null || blocked.child.signalCode !== null, 'occupied port exit');
      check('bind failure exits nonzero before dream or explicit startup side effects', blocked.child.exitCode !== 0 && blocked.output().includes('already in use') && seen.length === count && !fs.existsSync(path.join(blocked.cwd, '.7coder', 'dream.lock')));
    } finally { await new Promise(resolve => occupied.close(resolve)); }

    const explicitStart = held.length, explicit = await backend('explicit', {}, 'BOOT_EXPLICIT'); await ready(explicit);
    await until(() => held.length > explicitStart && held[explicitStart].item.job === 'BOOT_EXPLICIT', 'explicit task waits');
    const afterExplicit = explicit.api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'BOOT_AFTER_EXPLICIT' }] });
    await until(async () => (await explicit.info()).load.chatQueued === 1, 'chat behind explicit startup');
    check('explicit startup has visible readiness and retains priority over chats', (await explicit.info()).startup.phase === 'startup-task' && !held[explicitStart].item.closed);
    held[explicitStart].release();
    check('chat continues after explicit task while optional dream is skipped', (await afterExplicit).body.includes('OK BOOT_AFTER_EXPLICIT') && (await explicit.info()).startup.phase === 'completed');

    const failed = await backend('failure', {}, 'BOOT_FAILURE'); await ready(failed);
    await until(async () => (await failed.info()).startup.phase === 'failed', 'explicit failure status');
    check('explicit task failure is visible without leaving core gate stuck', (await failed.info()).startup.error.includes('failed') && (await failed.api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'BOOT_RECOVERY' }] })).status === 200);

    const restartStart = held.length, original = await backend('forced-restart'); await ready(original);
    await until(() => held.length > restartStart, 'original dream lock');
    original.child.kill(); await new Promise(resolve => original.child.once('close', resolve));
    check('forced termination leaves recognized dream evidence for recovery', fs.existsSync(path.join(original.cwd, '.7coder', 'dream.lock')));
    const restarted = await backend('forced-restart-next', {}, null, original.cwd, original.port); await ready(restarted);
    await until(() => held.length > restartStart + 1, 'new dream recovers lock');
    const recovered = await restarted.api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'BOOT_RESTARTED' }] });
    check('restart recovers prior owner lock immediately and can yield to a new chat', recovered.status === 200 && !fs.existsSync(path.join(restarted.cwd, '.7coder', 'dream.lock')));
    console.log('STARTUP/READINESS ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline); S.cleanup(); for (const socket of sockets) socket.destroy();
    if (fixture) await new Promise(resolve => fixture.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
