const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const S = require('./_shared').create({ suite: 'runtime-diagnostics' });
const { loadContext } = require('./download-commit');
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set();
let checks = 0, fixture, app, releaseHold, cancelSeen = false;
const deadline = setTimeout(() => { console.error('RUNTIME/DIAGNOSTICS deadline'); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(name, overrides = {}) {
  const cwd = S.freshCwd(name), warnings = [];
  const ctx = loadContext(source, cwd, overrides, { Buffer, Date, process, console: { warn: msg => warnings.push(msg) } });
  vm.runInContext(cut('function appendDiagnosticRecord(', 'function audit(') + cut('// Bounded operating diagnostics:', '// No-key is a valid setup') +
    cut('const ownedChildStates =', 'async function stopBackgroundTask(') + 'this.limit=RUNTIME_LOG_LIMIT;', ctx);
  return { ctx, cwd, warnings, file: path.join(cwd, '.7coder', 'runtime.jsonl'), old: path.join(cwd, '.7coder', 'runtime.old.jsonl') };
}
async function until(test, label) { const end = Date.now() + 6000; while (!await test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 10)); } }
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function reply(res, body, text) {
  if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); }
  else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
}
(async () => {
  try {
    let f = context('bounded 中文'), c = f.ctx;
    const finish = c.beginRuntimeOperation('cli-task'), finishTool = c.beginRuntimeOperation('tool');
    check('active task and tool counters are independent', c.runtimeSnapshot().activeTasks === 1 && c.runtimeSnapshot().activeTools === 1);
    finishTool('error', { code: 'ENOENT', path: '中文 path/file.txt', syscall: 'open', message: 'token=abc Bearer abc.def sk-abcdefghijk', command: 'MUST_NOT_LOG', apiKey: 'MUST_NOT_LOG' });
    finishTool('ok'); finish('ok'); finish('error');
    let state = c.runtimeSnapshot(), log = fs.readFileSync(f.file, 'utf8');
    check('finish is idempotent and retains last success plus last error', state.activeTasks === 0 && state.activeTools === 0 && state.completed === 1 && state.failed === 1 && state.lastSuccess.scope === 'cli-task' && state.lastError.code === 'ENOENT');
    check('errno syscall and Unicode path survive UTF-8 log writes', state.lastError.syscall === 'open' && log.includes('中文 path/file.txt'));
    check('diagnostics whitelist metadata and scrub token-like text', !/abc|abcdefghijk|MUST_NOT_LOG/.test(log) && log.includes('***'));
    state.lastError.message = 'mutated';
    check('returned state cannot mutate internal records', c.runtimeSnapshot().lastError.message !== 'mutated');
    c.recordRuntimeEvent('child', 'error', { message: '中'.repeat(100000), path: '文'.repeat(10000) });
    check('very large error metadata is bounded before retaining', JSON.stringify(c.runtimeSnapshot()).length < 15000);
    fs.writeFileSync(f.file, Buffer.alloc(c.limit - 1, 32));
    c.recordRuntimeEvent('rotation', 'error', { message: 'UTF8中文' });
    check('rotation happens before crossing byte limit and retains one previous file', fs.statSync(f.old).size === c.limit - 1 && fs.statSync(f.file).size < c.limit);
    fs.writeFileSync(f.file, Buffer.alloc(c.limit - 1, 32)); c.recordRuntimeEvent('rotation-again', 'error');
    check('second rotation replaces previous file without accumulating generations', fs.readdirSync(path.dirname(f.file)).length === 2 && fs.statSync(f.old).size <= c.limit && fs.statSync(f.file).size <= c.limit);

    f = context('rotation-denied', { renameSync() { throw Object.assign(Error('fixture rotation denied'), { code: 'EACCES' }); } }); c = f.ctx;
    fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, Buffer.alloc(c.limit - 1, 32));
    c.recordRuntimeEvent('test', 'error'); c.recordRuntimeEvent('test', 'error');
    check('failed rotation never falls through to append or repeated warning spam', fs.statSync(f.file).size === c.limit - 1 && c.runtimeSnapshot().loggingError.code === 'EACCES' && f.warnings.length === 1);
    f = context('disk-full', { writeSync() { throw Object.assign(Error('fixture full'), { code: 'ENOSPC' }); } }); c = f.ctx;
    c.beginRuntimeOperation('cli-task')('ok');
    check('disk-full leaves operation successful, counters released and logging fault visible', c.runtimeSnapshot().lastSuccess.status === 'ok' && c.runtimeSnapshot().activeTasks === 0 && c.runtimeSnapshot().loggingError.code === 'ENOSPC');
    c.fs.writeSync = fs.writeSync; c.recordRuntimeEvent('recovered', 'ok');
    check('next successful log write clears the logging fault', c.runtimeSnapshot().loggingError === null && fs.existsSync(f.file));
    const child = S.spawn(S.NODE_BIN, ['-e', 'process.exit(7)'], { stdio: 'ignore' }); c.observeOwnedChild(child, 'background-child', 'owned-fixture');
    await new Promise(r => child.once('close', r));
    state = c.runtimeSnapshot();
    check('real child close records PID numeric exit and owner ID', state.lastError.scope === 'background-child' && state.lastError.pid === child.pid && state.lastError.exitCode === 7 && state.lastError.id === 'owned-fixture');
    const { EventEmitter } = require('events'), missing = new EventEmitter();
    c.observeOwnedChild(missing); missing.emit('error', Object.assign(Error('fixture spawn'), { code: 'ENOENT', path: 'missing.exe', syscall: 'spawn' }));
    check('spawn failure keeps errno/path even without PID or close event', c.runtimeSnapshot().lastError.code === 'ENOENT' && c.runtimeSnapshot().lastError.path === 'missing.exe');

    fixture = http.createServer((req, res) => {
      let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
        const body = JSON.parse(raw), text = body.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
        if (text.includes('RT_CANCEL')) { cancelSeen = true; return; }
        if (text.includes('RT_FAIL')) { res.statusCode = 503; res.end('{}'); return; }
        if (text.includes('RT_HOLD')) { releaseHold = () => reply(res, body, 'held complete'); return; }
        if (text.includes('RT_TOOL') && !body.messages.some(m => m.role === 'tool')) {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'rt-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"missing.txt"}' } }] } }] })); return;
        }
        reply(res, body, 'runtime complete');
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(r => fixture.listen(0, '127.0.0.1', r));
    const p = await port(), cwd = S.freshCwd('real-agent');
    const env = Object.assign({}, process.env, { HTTP_PORT: String(p), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '',
      OPENAI_ENDPOINT: 'http://127.0.0.1:' + fixture.address().port, OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', LIGHT_MODEL: '', SUMMARY_MODEL: '',
      DREAM_ALLOW: 'false', MAX_RETRIES: '1', EXECUTION_TIMEOUT_MS: '10000', PERMISSION_MODE: 'bypass', AUDIT_LOG: 'false' });
    app = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env });
    let output = ''; app.stdout.on('data', d => output += d); app.stderr.on('data', d => output += d);
    const api = (method, url, body = null) => S.httpReq(p, method, url, body);
    const info = async () => JSON.parse((await api('GET', '/api/info')).body);
    const chat = (job, stream = false) => api('POST', '/v1/chat/completions', { stream, messages: [{ role: 'user', content: job }] });
    await until(async () => { if (app.exitCode != null) throw Error(output); try { return (await api('GET', '/api/info')).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'Agent ready');
    check('real info exposes clean runtime state with ready event', (await info()).runtime.lastSuccess.scope === 'http-ready' && (await info()).runtime.activeTasks === 0);
    const held = chat('RT_HOLD'); await until(() => !!releaseHold, 'held model');
    const queued = chat('RT_QUEUED'); await until(async () => (await info()).load.chatQueued === 1, 'queued request');
    check('real diagnostics distinguish active task from queued chat', (await info()).runtime.activeTasks === 1 && (await info()).load.chatRequests === 2);
    releaseHold(); check('released work and queued chat both complete', (await held).status === 200 && (await queued).status === 200);
    const failure = await chat('RT_FAIL');
    check('upstream failure leaves live server with visible terminal error and zero active count', failure.status === 500 && (await info()).runtime.lastError.scope === 'http-task' && (await info()).runtime.activeTasks === 0);
    check('streaming recovery records success without erasing earlier failure', (await chat('RT_STREAM', true)).body.includes('[DONE]') && (await info()).runtime.lastSuccess.scope === 'http-task' && (await info()).runtime.lastError.scope === 'http-task');
    check('tool failure is visible even with audit disabled and overall task success', (await chat('RT_TOOL')).status === 200 && (await info()).runtime.lastError.id === 'read_file' && (await info()).runtime.activeTools === 0);
    const data = JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'RT_CANCEL' }] });
    const request = http.request({ hostname: '127.0.0.1', port: p, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => res.resume());
    request.on('error', () => {}); request.end(data);
    await until(() => cancelSeen, 'cancel model entered'); request.destroy();
    await until(async () => (await info()).runtime.activeTasks === 0 && (await info()).runtime.lastError.status === 'cancelled', 'cancel terminal state');
    check('real client disconnect records cancellation and releases activity', (await info()).load.chatRequests === 0);
    const events = fs.readFileSync(path.join(cwd, '.7coder', 'runtime.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    check('persisted diagnostics contain terminal tool/task failures, no prompt or API config', events.some(e => e.scope === 'tool' && e.id === 'read_file') && !JSON.stringify(events).includes('RT_FAIL') && !JSON.stringify(events).includes('OPENAI_ENDPOINT'));
    console.log('RUNTIME/DIAGNOSTICS ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline); S.cleanup(); for (const socket of sockets) socket.destroy();
    if (fixture) await new Promise(r => fixture.close(r));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
