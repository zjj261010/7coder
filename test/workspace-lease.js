// T22-14: actual OS lease, multiple native Agent processes, one local model.
// No real model/user files. One bounded suite; no stress/retry test loops.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const vm = require('vm');
const { EventEmitter } = require('events');
const S = require('./_shared').create({ suite: 'workspace-lease' });
const source = fs.readFileSync(S.IDX, 'utf8');
const a = source.indexOf('function workspaceLeaseAddress('), b = source.indexOf('// Config reads may restore files', a);
assert.ok(a >= 0 && b > a, 'lease source boundaries');
const leaseSource = source.slice(a, b);
const children = new Set(), localLeases = new Set(), modelSockets = new Set(), held = new Map(), jobs = [];
let checks = 0, model, releaseBackground = null;
const deadline = setTimeout(() => { console.error('WORKSPACE/LEASE suite deadline'); for (const s of modelSockets) s.destroy(); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function bounded(promise, ms = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function context(extra) {
  const ctx = Object.assign({ Buffer, process, fs, path, crypto, net, console, setTimeout, clearTimeout,
    flushExit: () => { throw Error('unexpected fatal lease failure'); } }, extra);
  vm.createContext(ctx); vm.runInContext(leaseSource, ctx); return ctx;
}
const native = context();
async function acquire(cwd, ctx = native) { const lease = await ctx.acquireWorkspaceLease(cwd); localLeases.add(lease); return lease; }
async function release(lease) { localLeases.delete(lease); await lease.releaseForHandoff(); }
function spawnApp(cwd, args, env) {
  const child = S.spawn(S.NODE_BIN, [S.IDX].concat(args || []), { cwd, env: Object.assign({}, process.env, {
    ENABLE_HTTP_SERVER: 'false', HTTP_API_KEY: '', HTTP_BIND: '127.0.0.1', OPENAI_API_KEY: 'fixture-key',
    OPENAI_ENDPOINT: 'http://127.0.0.1:' + (model ? model.address().port : 1) + '/v1', HEAVY_MODEL: 'fixture',
    DREAM_ALLOW: 'false', MAX_RETRIES: '1', PERMISSION_MODE: 'bypass'
  }, env || {}) });
  let output = '';
  const notices = new EventEmitter();
  child.stdout.on('data', d => { output += d.toString(); notices.emit('output'); });
  child.stderr.on('data', d => { output += d.toString(); notices.emit('output'); });
  child.stdin.on('error', () => {});
  const done = new Promise(resolve => child.once('close', code => { children.delete(child); resolve({ code, out: output }); notices.emit('output'); }));
  children.add(child);
  const waitFor = text => bounded(new Promise((resolve, reject) => {
    const inspect = () => {
      if (output.includes(text)) { notices.removeListener('output', inspect); resolve(); }
      else if (child.exitCode !== null || child.signalCode !== null) { notices.removeListener('output', inspect); reject(Error('child ended before ' + text + ': ' + output)); }
    };
    notices.on('output', inspect); inspect();
  }));
  return { child, done, waitFor, output: () => output };
}
async function run(cwd, args, env) { const app = spawnApp(cwd, args, env); app.child.stdin.end(); return bounded(app.done); }
async function stop(app, signal = 'SIGKILL') { if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill(signal); return bounded(app.done); }
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function backend(cwd) {
  const port = await freePort(), app = spawnApp(cwd, ['--server'], { HTTP_PORT: String(port) });
  app.child.stdin.end(); await app.waitFor('endpoint ready at');
  app.api = (method, url, data = null) => bounded(S.httpReq(port, method, url, data));
  return app;
}
function reply(res, body, message) {
  if (body.stream) {
    const delta = Object.assign({}, message);
    if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((t, index) => Object.assign({ index }, t));
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else res.end(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant' }, message) }] }));
}
async function startModel() {
  model = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
      try {
        const body = JSON.parse(raw), text = body.messages.filter(m => m.role === 'user').map(m => String(m.content)).join('\n');
        const match = text.match(/LEASE_(SERIAL_FIRST|SERIAL_SECOND|HTTP_TODO|BACKGROUND)/), job = match ? match[0] : 'other';
        jobs.push(job);
        if (job === 'LEASE_BACKGROUND') {
          releaseBackground = () => reply(res, body, { content: 'BACKGROUND_DONE' });
          held.get(job).resolve(); return;
        }
        if (job !== 'other' && body.tools && !body.messages.some(m => m.role === 'tool')) {
          reply(res, body, { tool_calls: [{ id: job, type: 'function', function: { name: 'todo_write_tool', arguments: JSON.stringify({ action: 'add', title: job }) } }] }); return;
        }
        if (job === 'LEASE_SERIAL_FIRST') {
          held.get(job).resolve(() => reply(res, body, { content: 'FIRST_DONE' })); return;
        }
        reply(res, body, { content: 'FIXTURE_DONE' });
      } catch (e) { res.statusCode = 500; res.end(e.message); }
    });
  });
  model.on('connection', s => { modelSockets.add(s); s.on('close', () => modelSockets.delete(s)); });
  await new Promise(r => model.listen(0, '127.0.0.1', r));
}
async function protocol() {
  const cwd = S.freshCwd('protocol 中文 空格'), address = native.workspaceLeaseAddress(cwd), lease = await acquire(cwd);
  const owner = await native.probeWorkspaceLease(address);
  check('actual lease probe verifies challenge, workspace key and random run identity', owner && owner.pid === process.pid && owner.token === lease.identity.token && owner.key === address.key);
  check('canonical dot/trailing path gives the same lease key', native.workspaceLeaseAddress(path.join(cwd, '.')).key === address.key);
  if (process.platform === 'win32') check('Windows path case shares the same lease key', native.workspaceLeaseAddress(cwd.toUpperCase()).key === address.key);
  const aliasParent = S.freshCwd('alias'), alias = path.join(aliasParent, 'workspace');
  fs.symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  check('real junction alias uses the original workspace lease', native.workspaceLeaseAddress(alias).key === address.key);
  for (const payload of ['null\n', JSON.stringify({ kind: 'wrong', key: address.key, challenge: 'a'.repeat(32) }) + '\n', 'x'.repeat(4097)]) {
    await bounded(new Promise(resolve => {
      const s = net.createConnection(address.endpoint, () => s.write(payload));
      s.on('error', () => {}); s.on('close', resolve);
    }));
  }
  check('malformed/wrong/oversized probe frames leave ownership healthy', (await native.probeWorkspaceLease(address)).token === owner.token);
  await bounded(new Promise(resolve => { const s = net.createConnection(address.endpoint); s.on('error', () => {}); s.on('close', resolve); }));
  check('idle probe closes on bounded timeout and owner still answers', (await native.probeWorkspaceLease(address)).token === owner.token);
  await release(lease);
  const newer = await acquire(cwd);
  check('explicit handoff release permits a new random identity, independent of PID reuse', newer.identity.token !== owner.token);
  await release(newer);
  const failures = [], captured = [];
  const faulty = context({ net: Object.assign({}, net, { createServer(handler) { const s = net.createServer(handler); captured.push(s); return s; } }),
    console: { error: s => failures.push(s) }, flushExit: code => failures.push(code) });
  const l = await acquire(cwd, faulty); captured[0].emit('error', Object.assign(Error('fixture lease failure'), { code: 'EIO' }));
  check('unexpected owned-lease error requests nonzero termination instead of continuing unlocked', failures.includes(1));
  await release(l);
  const badNet = context({ net: { createServer() {
    const s = new EventEmitter(); s.listen = () => process.nextTick(() => s.emit('error', Object.assign(Error('fixture EMFILE'), { code: 'EMFILE' })));
    s.close = () => {}; return s;
  } } });
  let caught; try { await badNet.acquireWorkspaceLease(cwd); } catch (e) { caught = e; }
  check('OS bind resource failure is rejected without pretending another owner exists', caught && caught.code === 'EMFILE');
}
async function admission() {
  const cwd = S.freshCwd('serial-writers'); held.set('LEASE_SERIAL_FIRST', deferred());
  const first = spawnApp(cwd, ['--prompt', 'LEASE_SERIAL_FIRST']); first.child.stdin.end();
  const finishFirst = await bounded(held.get('LEASE_SERIAL_FIRST').promise);
  const file = path.join(cwd, '.7coder', 'todos.json'), before = fs.readFileSync(file);
  const owner = await native.probeWorkspaceLease(native.workspaceLeaseAddress(cwd)), count = jobs.length;
  const denied = await run(cwd, ['--prompt', 'LEASE_SERIAL_SECOND']);
  check('second CLI fails before model/tool execution while the first owns the workspace', denied.code === 1 && denied.out.includes('Workspace is already in use') && denied.out.includes('PID ' + owner.pid) && jobs.length === count && fs.readFileSync(file).equals(before));
  finishFirst(); const firstResult = await bounded(first.done);
  const second = await run(cwd, ['--prompt', 'LEASE_SERIAL_SECOND']);
  const items = JSON.parse(fs.readFileSync(file, 'utf8')).items;
  check('after first exit a second writer preserves both todos and their distinct IDs', firstResult.code === 0 && second.code === 0 && items.length === 2 && items[0].title === 'LEASE_SERIAL_FIRST' && items[1].title === 'LEASE_SERIAL_SECOND' && items[0].id !== items[1].id);

  const ws = S.freshCwd('HTTP-owner'), app = await backend(ws), dir = path.join(ws, '.7coder'); fs.mkdirSync(dir, { recursive: true });
  const env = path.join(ws, '.env'), profiles = path.join(dir, 'models.json');
  fs.writeFileSync(env, Buffer.from([0xFF])); fs.writeFileSync(env + '.7coder-prev', 'HEAVY_MODEL=must-not-recover\n');
  fs.writeFileSync(profiles, '{broken'); fs.writeFileSync(profiles + '.7coder-prev', '{}');
  const deniedServer = await run(ws, ['--server'], { HTTP_PORT: String(await freePort()) });
  check('different HTTP port cannot bypass ownership or perform startup config recovery', deniedServer.code === 1 && deniedServer.out.includes('Workspace is already in use') && !deniedServer.out.includes('endpoint ready') && fs.readFileSync(env).equals(Buffer.from([0xFF])) && fs.readFileSync(profiles, 'utf8') === '{broken' && !fs.readdirSync(ws).some(n => n.includes('corrupt-')) && !fs.readdirSync(dir).some(n => n.includes('corrupt-')));
  const help = await run(ws, ['--help']);
  check('--help remains available without config recovery or workspace admission', help.code === 0 && help.out.includes('Usage:') && fs.readFileSync(env).equals(Buffer.from([0xFF])));
  for (const f of [env, env + '.7coder-prev', profiles, profiles + '.7coder-prev']) fs.unlinkSync(f);
  const aliasParent = S.freshCwd('native-alias'), alias = path.join(aliasParent, 'workspace');
  fs.symlinkSync(ws, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasAttempt = await run(alias, ['--prompt', 'never-run']);
  check('Agent started through a real junction cannot become a second writer', aliasAttempt.code === 1 && aliasAttempt.out.includes('Workspace is already in use'));
  const other = await backend(S.freshCwd('independent-workspace'));
  check('independent workspaces can serve concurrently', (await app.api('GET', '/api/info')).status === 200 && (await other.api('GET', '/api/info')).status === 200);
  const chat = await app.api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'LEASE_HTTP_TODO' }] });
  const todos = await app.api('GET', '/api/todos');
  check('owning HTTP Agent still executes tools and persists todos for its clients', chat.status === 200 && todos.status === 200 && JSON.parse(todos.body).todos[0].title === 'LEASE_HTTP_TODO');
  const oldOwner = await native.probeWorkspaceLease(native.workspaceLeaseAddress(ws));
  await stop(app);
  fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: process.pid, token: 'stale-fixture' }));
  const restarted = await backend(ws), newOwner = await native.probeWorkspaceLease(native.workspaceLeaseAddress(ws));
  check('forced owner termination permits second start without removing stale PID/lock files', newOwner.token !== oldOwner.token && (await restarted.api('GET', '/api/todos')).body.includes('LEASE_HTTP_TODO') && fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8').includes('stale-fixture'));
  await stop(restarted); await stop(other);
  const repl = spawnApp(ws); await repl.waitFor('Welcome to 7coder'); repl.child.stdin.end('/bye\n');
  const bye = await bounded(repl.done), afterBye = await backend(ws);
  check('normal /bye releases OS ownership after cleanup and next start succeeds', bye.code === 0 && (await afterBye.api('GET', '/api/info')).status === 200);
  await stop(afterBye);
}
async function unknownAndFrozen() {
  const cwd = S.freshCwd('unknown-owner'), address = native.workspaceLeaseAddress(cwd);
  const foreignPeers = new Set();
  const foreign = net.createServer(s => {
    foreignPeers.add(s); s.on('close', () => foreignPeers.delete(s));
    s.on('error', () => {}); s.resume(); s.end('{"kind":"another-application"}\n');
  });
  await new Promise(r => foreign.listen(address.endpoint, r));
  try {
    const r = await run(cwd, ['--server']);
    check('unrecognized endpoint blocks startup without removing/killing its owner', r.code === 1 && r.out.includes('owner could not be verified') && foreign.listening && !fs.existsSync(path.join(cwd, '.7coder')));
  } finally { for (const s of foreignPeers) s.destroy(); await bounded(new Promise(r => foreign.close(r))); }
  const frozenDir = S.freshCwd('frozen'), script = path.join(S.runDir, 'frozen-owner.js');
  fs.writeFileSync(script, `const fs=require('fs'),path=require('path'),crypto=require('crypto'),net=require('net');
${leaseSource}
acquireWorkspaceLease(process.cwd()).then(()=>{process.send('owned',()=>{const end=Date.now()+10000;while(Date.now()<end){}setInterval(()=>{},1000);});}).catch(e=>{console.error(e);process.exit(1)});
function flushExit(code){process.exit(code)}
`);
  const child = S.spawn(S.NODE_BIN, [script], { cwd: frozenDir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ended = new Promise(r => child.once('close', r));
  await bounded(new Promise(r => child.once('message', r)));
  try {
    const r = await run(frozenDir, ['--prompt', 'must-not-run']);
    check('unresponsive but live owner is never mistaken for a stale lease', r.code === 1 && r.out.includes('owner could not be verified') && child.exitCode === null && !fs.existsSync(path.join(frozenDir, '.7coder')));
  } finally { child.kill(); await bounded(ended); }
  const next = await backend(frozenDir);
  check('after frozen owner is actually terminated the workspace restarts normally', (await next.api('GET', '/api/info')).status === 200); await stop(next);
}
async function backgroundAndSharedInstall() {
  const cwd = S.freshCwd('background-handoff'); held.set('LEASE_BACKGROUND', deferred());
  const launcher = spawnApp(cwd, ['--background', '--prompt', 'LEASE_BACKGROUND']); launcher.child.stdin.end();
  await bounded(held.get('LEASE_BACKGROUND').promise);
  const result = await bounded(launcher.done), address = native.workspaceLeaseAddress(cwd), owner = await native.probeWorkspaceLease(address);
  check('background launcher exits only after the worker owns the same workspace', result.code === 0 && result.out.includes('Background worker accepted') && owner && owner.pid !== launcher.child.pid && result.out.includes('PID ' + owner.pid));
  fs.appendFileSync(S.manifest, owner.pid + '\t' + S.IDX + '\n'); // recoverable identity for an interrupted run
  const rejected = await run(cwd, ['--server']);
  check('background worker remains the sole owner after its launcher exits', rejected.code === 1 && rejected.out.includes('PID ' + owner.pid));
  releaseBackground(); releaseBackground = null;
  // Readiness wait for this known one-shot worker's OS handle to disappear;
  // no test command is repeated and no PID-based deletion/reclamation occurs.
  const end = Date.now() + 6000;
  while (await native.probeWorkspaceLease(address)) {
    if (Date.now() > end) throw Error('background worker did not finish; see owned-processes manifest');
    await new Promise(r => setTimeout(r, 80));
  }
  const restarted = await backend(cwd);
  check('completed background task releases ownership and retains its local diagnostic log', (await restarted.api('GET', '/api/info')).status === 200 && fs.readFileSync(path.join(cwd, '.7coder', 'background.log'), 'utf8').includes('BACKGROUND_DONE'));
  await stop(restarted);

  const appDir = path.dirname(S.IDX), models = path.join(appDir, 'models.json'), env = path.join(appDir, '.env');
  fs.writeFileSync(models, '{shared-broken'); fs.writeFileSync(models + '.7coder-prev', JSON.stringify({ 'install-profile': {} }));
  fs.writeFileSync(env, Buffer.from([0xFF])); fs.writeFileSync(env + '.7coder-prev', 'SHARED_ONLY_FIXTURE=yes\n');
  try {
    const [one, two] = await Promise.all([backend(S.freshCwd('shared-A')), backend(S.freshCwd('shared-B'))]);
    check('distinct workspaces read shared installation fallback without concurrent recovery writes',
      JSON.parse((await one.api('GET', '/api/info')).body).models.includes('install-profile') && JSON.parse((await two.api('GET', '/api/info')).body).models.includes('install-profile') &&
      fs.readFileSync(models, 'utf8') === '{shared-broken' && fs.readFileSync(env).equals(Buffer.from([0xFF])) && !fs.readdirSync(appDir).some(n => n.includes('.7coder-corrupt-')) && one.output().includes('without modifying installation') && two.output().includes('without modifying installation'));
    await stop(one); await stop(two);
  } finally { for (const f of [models, models + '.7coder-prev', env, env + '.7coder-prev']) fs.unlinkSync(f); }
}
(async () => {
  try {
    await startModel(); await protocol(); await admission(); await unknownAndFrozen(); await backgroundAndSharedInstall();
    console.log('WORKSPACE/LEASE ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally {
    if (releaseBackground) releaseBackground();
    for (const entry of held.values()) entry.resolve(() => {});
    for (const child of children) { try { child.kill(); } catch (e) {} }
    for (const lease of localLeases) { try { await lease.releaseForHandoff(); } catch (e) {} }
    for (const socket of modelSockets) socket.destroy();
    if (model) await new Promise(r => model.close(r));
    clearTimeout(deadline); S.cleanup();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
