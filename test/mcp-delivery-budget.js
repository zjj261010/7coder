'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const { EventEmitter } = require('events'), { PassThrough, Writable } = require('stream');
const S = require('./_shared').create({ suite: 'mcp-delivery-budget' }), source = fs.readFileSync(S.IDX, 'utf8'), root = path.dirname(S.IDX);
const MiB = 1024 * 1024, frameLimit = 4 * MiB, scope = process.env.MCP_DELIVERY_SCOPE || 'all';
assert.ok(scope === 'all' || scope === 'native', 'unknown delivery test scope');
let checks = 0, actual = false;
const clients = [], children = [], owner = require(path.join(root, 'lib', 'process-owner')).create(cp, root);
function cut(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start, a); return source.slice(start, end); }
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { const end = Date.now() + 8000; while (!predicate()) { if (Date.now() > end) throw Error('delivery condition deadline'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const fakes = [];
function fake() {
  const child = new EventEmitter(), writes = [], notified = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  child.stdin = new Writable({ write(bytes, encoding, cb) { const req = JSON.parse(bytes); writes.push(req); cb(); if (req.method === 'notifications/initialized') notified.push(c.mcpBudgetSnapshot().deliveries); } });
  return { child, writes, notified, frame(message) { child.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, message)) + '\n'); } };
}
const c = vm.createContext({ Buffer, process, path, launchDir: S.runDir, APP_VERSION: 'fixture', mcpClients: {}, MCP_MAX_FRAME_BYTES: frameLimit, MCP_CALL_TIMEOUT: 8000,
  setTimeout, clearTimeout, setInterval, clearInterval, EXECUTION_TIMEOUT_MS: 8000, console: { log() {}, warn() {} }, resolveCommandOnWindows: () => false,
  child_process: Object.assign({}, owner, { spawn(file, args, options) {
    if (!actual) return fakes.shift().child;
    const child = owner.spawn(file, args, options); children.push(child); child.on('error', () => {});
    if (child.pid) fs.appendFileSync(S.manifest, child.pid + '\t' + S.runDir + '\n'); return child;
  } }) });
vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') + cut('function mcpContentToText(', '// A2-19:') + cut('function createMcpStdioClient(', '// Redact secrets'), c);
function make(name) { const f = fake(); fakes.push(f); f.client = c.createMcpStdioClient(name, {}); c.mcpClients[name] = f.client; clients.push(f.client); return f; }
function sizedFrame(id, bytes) { const message = { jsonrpc: '2.0', id, result: '' }; message.result = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(message))); const text = JSON.stringify(message); assert.strictEqual(Buffer.byteLength(text), bytes); return text + '\n'; }
function zero() { const stats = c.mcpBudgetSnapshot(); return stats.deliveries === 0 && stats.deliveryBytes === 0; }
const deadline = setTimeout(() => { console.error('MCP/DELIVERY deadline'); for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill(); process.exit(1); }, 30000);
(async () => { try {
  if (scope === 'all') {
    const group = Array.from({ length: 5 }, (_, i) => make('burst-' + i));
    const waiting = group.map(f => observe(f.client.request('echo', {}, 8000)));
    for (const f of group.slice(0, 4)) f.child.stdout.write(sizedFrame(1, frameLimit));
    check('four complete responses remain charged at exact shared 16MiB before consumers run', c.mcpBudgetSnapshot().deliveryBytes === 16 * MiB && c.mcpBudgetSnapshot().deliveries === 4 && c.mcpBudgetSnapshot().incomingBytes === 0 && c.mcpBudgetSnapshot().pending === 1);
    group[4].frame({ id: 1, result: 'overflow' });
    // Retirement cannot reclaim an already-resolved response still in transit.
    group[0].client.dispose(); group[0].client.dispose();
    check('retiring delivered client cannot prematurely free its result handoff', c.mcpBudgetSnapshot().deliveryBytes === 16 * MiB && group[0].client.deliveryBytes === frameLimit);
    const outcomes = await Promise.all(waiting);
    check('over-budget response fails one sent call as incomplete without retiring healthy peers', outcomes[4].error.code === 'MCP_RESULT_BUDGET' && /sent request result incomplete/.test(outcomes[4].error.message) && group.slice(1).every(f => !f.client.dead));
    check('successful raw snapshots release only their handoffs after delivery', outcomes.slice(0, 4).every(result => result.value.length > 4 * MiB - 100) && zero() && group.every(f => f.client.deliveryBytes === 0));

    const held = make('held'); let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = observe(held.client.request('echo', {}, 8000, null, async value => { entered = true; await gate; return value.length; }));
    held.frame({ id: 1, result: 'owned-result' }); await tick();
    check('asynchronous consuming callback owns response quota across awaits', entered && c.mcpBudgetSnapshot().deliveries === 1 && held.client.deliveryBytes > 0);
    held.client.dispose();
    check('dispose preserves quota of an already-admitted asynchronous consumer', c.mcpBudgetSnapshot().deliveries === 1 && held.client.deliveries === 1);
    release(); const done = await pending;
    check('consumer completion after retirement returns quota exactly once', done.value === 12 && zero() && held.client.deliveries === 0);

    const errors = make('errors');
    let request = observe(errors.client.request('echo', {}, 8000, null, () => { throw Error('consumer failed'); }));
    errors.frame({ id: 1, result: 'complete' });
    check('consumer exception releases response and keeps a live peer usable', (await request).error.message === 'consumer failed' && zero() && !errors.client.dead);
    request = observe(errors.client.request('echo', {}, 8000)); errors.frame({ id: 2, error: { code: -1, message: 'remote failed' } });
    const chargedError = c.mcpBudgetSnapshot().deliveries;
    check('remote errors are charged while waiting and released when thrown', chargedError === 1 && (await request).error.message === 'remote failed' && zero());
    request = observe(errors.client.request('echo', {}, 8000)); errors.frame({ id: 3, result: 'x', error: { code: -1, message: 'ambiguous' } });
    check('malformed envelopes never create a deliverable lease', c.mcpBudgetSnapshot().deliveries === 0 && (await request).error.code === 'MCP_PROTOCOL_ERROR');
    errors.frame({ method: 'notifications/progress', params: { data: 'unrelated' } }); errors.frame({ id: 9999, result: 'unsolicited' });
    check('notifications and uncorrelated responses cannot retain delivery quota', zero() && errors.client.pending.size === 0);

    const countGroup = Array.from({ length: 4 }, (_, i) => make('count-' + i)), countWaiting = [];
    for (const f of countGroup) for (let i = 0; i < 32; i++) countWaiting.push(observe(f.client.request('echo', {}, 8000)));
    for (const f of countGroup) for (let id = 1; id <= 32; id++) f.frame({ id, result: true });
    check('128 small answered responses count separately from zero pending requests', c.mcpBudgetSnapshot().deliveries === 128 && c.mcpBudgetSnapshot().pending === 0 && c.mcpBudgetSnapshot().deliveryBytes < MiB);
    request = observe(errors.client.request('echo', {}, 8000)); errors.frame({ id: 4, result: false });
    check('129th in-transit result cannot bypass count limit by being small', (await request).error.code === 'MCP_RESULT_BUDGET');
    const countResults = await Promise.all(countWaiting);
    check('all 128 accepted small results deliver without leaked or negative counters', countResults.every(result => result.value === true) && zero());

    const production = make('production');
    request = production.client.ensureInit();
    production.frame({ id: 1, result: { protocolVersion: '2024-11-05' } }); await request;
    check('initialization validation and notification consume inside the response lease', production.notified.join() === '1' && production.client.initialized && zero());
    const format = c.mcpContentToText; let duringFormat = 0;
    c.mcpContentToText = value => { duringFormat = c.mcpBudgetSnapshot().deliveries; return format(value); };
    request = production.client.callTool('echo', {}); await until(() => production.writes.some(q => q.method === 'tools/call'));
    const toolRequest = production.writes.find(q => q.method === 'tools/call'); production.frame({ id: toolRequest.id, result: { content: [{ type: 'text', text: 'formatted' }] } });
    check('tool result formatting occurs while its raw response remains charged', await request === 'formatted' && duringFormat === 1 && zero()); c.mcpContentToText = format;
    request = production.client.listTools(); await until(() => production.writes.some(q => q.method === 'tools/list'));
    production.frame({ id: production.writes.find(q => q.method === 'tools/list').id, result: { tools: [{ name: 'owned-schema' }] } });
    const tools = await request;
    check('discovery transfers accepted tools to schema budget before releasing raw response', tools[0].name === 'owned-schema' && production.client.schemaBytes > 2 && zero());
    let cancelled = false;
    request = observe(production.client.callTool('cancel', {}, () => cancelled)); await until(() => production.writes.some(q => q.method === 'tools/call' && q.params.name === 'cancel'));
    const cancelRequest = production.writes.find(q => q.method === 'tools/call' && q.params.name === 'cancel');
    production.frame({ id: cancelRequest.id, result: { content: [{ type: 'text', text: 'late' }] } }); cancelled = true;
    check('cancellation before formatting releases delivery without a late success', (await request).error.code === 'EXECUTION_CANCELLED' && zero());
    for (const client of clients) client.dispose(); await tick();
    check('retiring all fake peers restores request, frame, schema, write and delivery accounting', zero() && ['pending', 'queuedBytes', 'incomingBytes', 'schemaBytes'].every(key => c.mcpBudgetSnapshot()[key] === 0));
  }

  if (process.platform !== 'win32') throw Error('real delivery fixture requires Windows owner'); actual = true;
  const cwd = S.freshCwd('response burst'), script = path.join(cwd, 'peer.js');
  fs.writeFileSync(script, `let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);const out={jsonrpc:'2.0',id:q.id,result:''};out.result='x'.repeat(3*1024*1024-Buffer.byteLength(JSON.stringify(out)));process.stdout.write(JSON.stringify(out)+'\\n');}});`);
  const native = c.createMcpStdioClient('native', { command: S.NODE_BIN, args: [script] }); clients.push(native);
  let releaseNative, consuming = 0, refused = 0;
  const nativeGate = new Promise(resolve => { releaseNative = resolve; }), waiting = [];
  for (let i = 0; i < 8; i++) waiting.push(observe(native.request('echo', {}, 8000, null, async value => { consuming++; await nativeGate; return value.length; })).then(outcome => { if (outcome.error) refused++; return outcome; }));
  await until(() => native.pending.size === 0 && consuming === 5 && refused === 3);
  check('actual owned peer admits five 3MiB responses and rejects three excess handoffs', native.deliveryBytes === 15 * MiB && c.mcpBudgetSnapshot().deliveryBytes === 15 * MiB && native.deliveries === 5 && !native.dead);
  const nativeClosed = new Promise(resolve => native.child.once('close', resolve)); native.dispose(); await nativeClosed;
  check('actual target cleanup does not erase still-held response ownership', native.child.ownedTree.closed && owner.processOwnerInfo().active === 0 && c.mcpBudgetSnapshot().deliveryBytes === 15 * MiB);
  releaseNative(); const realResults = await Promise.all(waiting);
  check('actual consumers release all retained deliveries after target shutdown', zero() && realResults.filter(value => value.value > 3 * MiB - 100).length === 5 && realResults.filter(value => value.error && value.error.code === 'MCP_RESULT_BUDGET').length === 3 && c.mcpBudgetSnapshot().pending === 0);
  const expected = scope === 'all' ? 22 : 3; assert.strictEqual(checks, expected); console.log('MCP/DELIVERY ' + scope + ' ' + checks + '/' + expected);
} finally {
  clearTimeout(deadline); for (const client of clients) client.dispose();
  for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
  for (const child of children) if (child.exitCode == null && child.signalCode == null) await new Promise(resolve => child.once('close', resolve));
  S.cleanup();
} })().catch(error => { console.error(error.stack); process.exitCode = 1; });
