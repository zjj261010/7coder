// Shared MCP reservations survive retirement until actual write/pipe settlement.
const assert = require('assert'), fs = require('fs'), vm = require('vm'), { EventEmitter } = require('events'), { PassThrough, Writable } = require('stream');
const S = require('./_shared').create({ suite: 'mcp-aggregate-budget' }), { create } = require('./_endpoint');
const source = fs.readFileSync(S.IDX, 'utf8'), clients = []; let checks = 0, H;
const tail = process.env.MCP_AGGREGATE_SCOPE === 'tail';
const deadline = setTimeout(() => { console.error('MCP/AGGREGATE deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 35000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
const tick = () => new Promise(r => setImmediate(r));
function context(spawn) {
  const timers = new Set();
  const c = vm.createContext({ Buffer, process, launchDir: S.runDir, APP_VERSION: 'fixture', MCP_MAX_FRAME_BYTES: 4 * 1024 * 1024, MCP_CALL_TIMEOUT: 5000,
    EXECUTION_TIMEOUT_MS: 5000, child_process: { spawn }, mcpClients: {}, resolveCommandOnWindows: () => false, console: { warn() {} },
    setTimeout(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }, clearTimeout(t) { timers.delete(t); clearTimeout(t); }, setInterval, clearInterval });
  vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') + cut('function mcpContentToText(', '// A2-19:') + cut('function createMcpStdioClient(', 'function getMcpClient('), c);
  return { c, timers, stats: () => c.mcpBudgetSnapshot(), add(name, cfg = {}) { const client = c.createMcpStdioClient(name, cfg); clients.push(client); return client; } };
}
function fake(stalled = false, unknownClose = false) {
  const child = new EventEmitter(), writes = [], callbacks = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  child.stdin = new Writable({ write(chunk, encoding, callback) { writes.push(chunk.toString()); if (stalled) callbacks.push(callback); else callback(); } });
  if (unknownClose) child.stdin.destroy = () => child.stdin;
  return { child, writes, callbacks, reply(id, result = 'done') { child.stdout.write(JSON.stringify({ id, result }) + '\n'); } };
}
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('owned native child did not settle')), 5000); })]); } finally { clearTimeout(timer); } }
(async () => { try {
  const fakes = [];
  let h, active, one, client;
  const params = { text: 'x'.repeat(3 * 1024 * 1024) };
  if (!tail) {
  h = context(() => { const f = fake(); fakes.push(f); return f.child; });
  active = Array.from({ length: 5 }, (_, i) => h.add('pending-' + i));
  const waiters = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 32; j++) waiters.push(observe(active[i].request('wait', {}, 10000)));
  await tick(); const timerCount = h.timers.size;
  await assert.rejects(active[4].request('overflow', {}, 10000), /aggregate pending.*128.*request not sent/);
  check('128 pending requests across four clients block a fifth before write or timer', h.stats().pending === 128 && fakes[4].writes.length === 0 && h.timers.size === timerCount && active.every(c => !c.dead));
  fakes[0].reply(1); await waiters[0];
  check('one server response releases one shared slot', h.stats().pending === 127);
  const fifth = observe(active[4].request('new', {}, 10000));
  check('different server can use released slot', h.stats().pending === 128 && fakes[4].writes.length === 1);
  fakes[0].reply(1); await tick();
  check('duplicate response never releases another request reservation', h.stats().pending === 128);
  active[0].dispose(); await Promise.all(waiters.slice(0, 32));
  check('retirement releases only its remaining 31 pending slots', h.stats().pending === 97 && active[1].pending.size === 32);
  for (const client of active) client.dispose(); await Promise.all(waiters.concat(fifth)); await tick();
  check('all clients retired leave no pending reservations or request timers', h.stats().pending === 0 && h.stats().queuedBytes === 0 && h.timers.size === 0);
  const snapshot = h.stats(); snapshot.pending = 99;
  check('diagnostic snapshots cannot mutate shared admission', h.stats().pending === 0 && snapshot.pendingLimit === 128 && snapshot.queuedBytesLimit === 16 * 1024 * 1024);

  fakes.length = 0; h = context(() => { const f = fake(true, true); fakes.push(f); return f.child; });
  active = Array.from({ length: 6 }, (_, i) => h.add('pipe-' + i));
  const held = [];
  for (let i = 0; i < 5; i++) held.push(observe(active[i].request('held', params, 10000)));
  const charged = active.slice(0, 5).reduce((n, c) => n + c.queuedBytes, 0), beforeTimers = h.timers.size;
  await assert.rejects(active[5].request('overflow', params, 10000), /aggregate outgoing queue.*16 MiB.*request not sent/);
  check('shared UTF8 queue blocks sixth server without losing earlier writes', h.stats().queuedBytes === charged && charged > 15 * 1024 * 1024 && h.stats().pending === 5 && fakes[5].writes.length === 0 && h.timers.size === beforeTimers);
  fakes[0].reply(1); await held[0];
  check('response releases pending slot but keeps unfinished write bytes charged', h.stats().pending === 4 && h.stats().queuedBytes === charged);
  active[0].dispose();
  check('dispose with no confirmed close retains aggregate bytes despite per-client retirement', active[0].queuedBytes === 0 && h.stats().queuedBytes === charged);
  await assert.rejects(active[5].request('still-full', params, 10000), /aggregate outgoing queue/);
  check('replacement cannot bypass retained charge from dead client', h.stats().pending === 4 && h.stats().queuedBytes === charged && fakes[5].writes.length === 0);
  const releasedBytes = Buffer.byteLength(fakes[0].writes[0], 'utf8');
  fakes[0].child.stdin.emit('close');
  check('observed stdin close releases exactly its owned bytes', h.stats().queuedBytes === charged - releasedBytes);
  const next = observe(active[5].request('after-close', params, 10000));
  check('another server can send after pipe close frees capacity', fakes[5].writes.length === 1 && h.stats().pending === 5);
  const afterNext = h.stats().queuedBytes; fakes[0].callbacks.shift()(); await tick();
  check('late callback after close cannot undercount new client bytes', h.stats().queuedBytes === afterNext);
  for (const client of active) client.dispose(); await Promise.all(held.concat(next));
  check('retirement settles sent requests as unknown without freeing unconfirmed buffers', h.stats().pending === 0 && h.stats().queuedBytes > 0 && (await next).error.message.includes('result unknown'));
  for (const f of fakes) f.child.emit('close', 0);
  check('observed child closes also release queued bytes when stdin close was absent', h.stats().queuedBytes === 0 && h.timers.size === 0);
  for (const f of fakes) while (f.callbacks.length) f.callbacks.shift()(); await tick();
  check('all late callbacks remain idempotent after aggregate reset', h.stats().queuedBytes === 0 && h.stats().pending === 0);

  one = fake(); h = context(() => one.child); client = h.add('sync-error');
  one.child.stdin.write = () => { throw Error('fixture write throws'); };
  const sync = await observe(client.request('fail', {}, 10000));
  check('synchronous write failure releases pending and bytes exactly once', !!sync.error && h.stats().pending === 0 && h.stats().queuedBytes === 0 && h.timers.size === 0);
  one = fake(); h = context(() => one.child); client = h.add('timeout');
  const timeout = await observe(client.request('wait', {}, 15));
  check('timeout releases pending and reports unknown result', timeout.error.message.includes('result unknown') && h.stats().pending === 0 && h.stats().queuedBytes === 0 && h.timers.size === 0);
  }
  one = fake(); h = context(() => one.child); client = h.add('cancel');
  const cancelClose = new Promise(resolve => one.child.stdin.once('close', resolve));
  const token = h.c.createExecutionControl(5000), cancellation = observe(client.request('wait', {}, 10000, token)); token.cancel('fixture cancel');
  const cancelled = await cancellation; token.dispose();
  check('active cancellation releases shared pending and all request/control timers', cancelled.error.message.includes('result unknown') && h.stats().pending === 0 && h.timers.size === 0);
  await bounded(cancelClose);
  check('cancelled writer releases shared bytes after observed pipe close', h.stats().queuedBytes === 0);
  one = fake(); h = context(() => one.child); client = h.add('cancel-before');
  const pre = () => true; await assert.rejects(client.request('never', {}, 10000, pre), e => e.code === 'EXECUTION_CANCELLED');
  check('pre-cancelled requests reserve nothing', h.stats().pending === 0 && h.stats().queuedBytes === 0 && one.writes.length === 0 && h.timers.size === 0);
  one = fake(); h = context(() => one.child); client = h.add('frame-limit');
  await assert.rejects(client.request('large', { text: 'x'.repeat(4 * 1024 * 1024) }, 10000), /outgoing frame/);
  check('existing per-frame admission failure leaks no shared pending slot', h.stats().pending === 0 && h.stats().queuedBytes === 0 && !client.dead && h.timers.size === 0);

  h = context((cmd, args, opts) => S.spawn(cmd, args, opts)); active = [];
  for (let i = 0; i < 2; i++) {
    client = h.add('native-' + i, { command: S.NODE_BIN, args: ['-e', 'process.stdin.pause();console.log("OWNED_READY");setInterval(()=>{},1000)'] }); active.push(client);
    await bounded(new Promise(resolve => { let text = ''; client.child.stdout.on('data', data => { text += data; if (text.includes('OWNED_READY')) resolve(); }); }));
  }
  const nativeWaiters = active.map(c => observe(c.request('held', params, 10000))); await tick();
  check('two actual Node13 unread pipes share summed queued bytes', h.stats().pending === 2 && h.stats().queuedBytes === active.reduce((n, c) => n + c.queuedBytes, 0) && h.stats().queuedBytes > 6 * 1024 * 1024);
  const closes = active.map(c => bounded(new Promise(resolve => c.child.once('close', resolve))));
  for (const c of active) c.dispose(); await Promise.all(closes); const nativeResults = await Promise.all(nativeWaiters);
  check('actual owned pipe/child closes settle unknown and restore shared capacity', nativeResults.every(r => r.error.message.includes('result unknown')) && h.stats().pending === 0 && h.stats().queuedBytes === 0 && h.timers.size === 0);
  H = create({ suite: 'mcp-aggregate-diagnostics', endpoint: 'http://127.0.0.1:1', key: '', model: 'fixture', permissionMode: 'denial' });
  await H.start(S.freshCwd('diagnostics-agent')); const info = JSON.parse((await H.api('/api/info')).body);
  check('actual Agent exposes shared budget independently of active-client array', info.mcpBudget.pending === 0 && info.mcpBudget.queuedBytes === 0 && info.mcpBudget.pendingLimit === 128 && info.mcpBudget.queuedBytesLimit === 16 * 1024 * 1024);
  console.log('MCP/AGGREGATE ' + checks + '/' + checks + '; SKIP 0' + (tail ? '; selected failed/unrun tail only; first 19 checks NOT RUN' : ''));
} finally { clearTimeout(deadline); for (const c of clients) c.dispose(); if (H) { await H.stop(); H.S.cleanup(); } S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
