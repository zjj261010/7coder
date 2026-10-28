'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const { EventEmitter } = require('events'), { PassThrough, Writable } = require('stream');
const S = require('./_shared').create({ suite: 'mcp-outgoing-preflight' }), root = path.dirname(S.IDX), source = fs.readFileSync(S.IDX, 'utf8');
const MiB = 1024 * 1024, limit = 4 * MiB, clients = [], children = [], queue = [], owner = require(path.join(root, 'lib', 'process-owner')).create(cp, root);
const scope = process.env.MCP_OUTGOING_SCOPE || 'all';
assert.ok(scope === 'all' || scope === 'tail', 'unknown outgoing test scope');
let checks = 0, serializations = 0, actual = false, guardCalls = 0, guardAction = null;
const timers = new Set();
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start); return source.slice(start, end); }
const c = vm.createContext({ Buffer, process, path, launchDir: S.runDir, APP_VERSION: 'fixture', mcpClients: {}, MCP_MAX_FRAME_BYTES: limit, MCP_CALL_TIMEOUT: 8000,
  EXECUTION_TIMEOUT_MS: 8000, console: { log() {}, warn() {} }, setInterval, clearInterval,
  setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  resolveCommandOnWindows: () => false, JSON: { parse: JSON.parse, stringify(value) { serializations++; return JSON.stringify(value); } },
  child_process: { assertProcessOwnerReady() { guardCalls++; if (guardAction) guardAction(); owner.assertProcessOwnerReady(); }, spawn(file, args, options) {
    if (!actual) return queue.shift().child;
    const child = owner.spawn(file, args, options); children.push(child); child.on('error', () => {}); if (child.pid) fs.appendFileSync(S.manifest, child.pid + '\t' + S.runDir + '\n'); return child;
  } } });
vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') + cut('function mcpContentToText(', '// A2-19:') + cut('function createMcpStdioClient(', '// Redact secrets'), c);
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
function fake(stalled) {
  const child = new EventEmitter(), lines = [], callbacks = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  child.stdin = new Writable({ write(bytes, encoding, cb) { lines.push(bytes.toString()); if (stalled) callbacks.push(cb); else cb(); } });
  queue.push({ child }); const client = c.createMcpStdioClient('fake-' + clients.length, {}); clients.push(client);
  return { client, child, lines, callbacks, reply(id, result = 'done') { child.stdout.write(JSON.stringify({ id, result }) + '\n'); } };
}
function paramsFor(bytes, id = 1, method = 'echo') { const params = { text: '' }; params.text = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')); return params; }
function zero() { const stats = c.mcpBudgetSnapshot(); return ['pending', 'queuedBytes', 'incomingBytes', 'deliveries', 'deliveryBytes'].every(key => stats[key] === 0); }
const deadline = setTimeout(() => { console.error('MCP/OUTGOING deadline'); for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill(); process.exit(1); }, 30000);
(async () => { try {
  const f = fake();
  let before, pending;
  if (scope === 'all') {
  before = serializations; pending = f.client.request('echo', paramsFor(limit), 8000);
  check('exact 4MiB outgoing frame including newline is admitted once', Buffer.byteLength(f.lines[0]) === limit && serializations - before === 1 && f.client.pending.size === 1);
  f.reply(1); assert.strictEqual(await pending, 'done');
  let executable = 0, getter = 0, deep = 0; for (let i = 0; i < 70; i++) deep = [deep];
  const cyclic = {}; cyclic.self = cyclic;
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get() { getter++; return 'must not execute'; } });
  const shortNumbers = { text: 'x'.repeat(3 * MiB), values: Array(90000).fill(1e20) };
  assert.ok(Buffer.byteLength(JSON.stringify(shortNumbers)) > limit);
  for (const [label, params] of [
    ['frame overflow', { text: 'x'.repeat(limit) }], ['numeric expansion', shortNumbers], ['deep args', { deep }],
    ['too many values', { values: Array(100001).fill(0) }], ['cycle', cyclic], ['accessor', accessor],
    ['executable serializer', { toJSON() { executable++; return {}; } }], ['unsupported bigint', { value: BigInt(1) }]
  ]) {
    before = serializations; const writes = f.lines.length;
    const result = await observe(f.client.request('refused', params, 8000));
    check(label + ' refuses before stringify/write and releases its request timer', result.error && result.error.code === 'MCP_REQUEST_BUDGET' && result.error.requestNotSent === true && serializations === before && f.lines.length === writes && !f.client.dead && zero() && timers.size === 0);
  }
  check('preflight never executes serializer functions or argument getters', executable === 0 && getter === 0);
  }
  const literal = '中文😀"\\\n\u0000\ud800';
  pending = f.client.request('echo', { text: literal }, 8000); const wire = JSON.parse(f.lines[f.lines.length - 1]); f.reply(wire.id, wire.params.text);
  const echoed = await pending; await new Promise(resolve => setImmediate(resolve));
  check('UTF8, quoting, controls and surrogate values survive normal dispatch exactly', echoed === literal && zero());

  const stalled = fake(true); pending = observe(stalled.client.request('echo', paramsFor(3 * MiB), 8000)); before = serializations;
  const overflow = await observe(stalled.client.request('more', { text: 'y'.repeat(2 * MiB) }, 8000));
  check('per-client queue admission precedes full JSON allocation and keeps earlier request', /outgoing queue/.test(overflow.error.message) && serializations === before && stalled.lines.length === 1 && stalled.client.pending.size === 1 && stalled.client.queuedBytes === 3 * MiB);
  stalled.callbacks.shift()(); stalled.reply(1); await pending;
  check('draining original writer releases byte charge without retiring healthy peer', stalled.client.queuedBytes === 0 && !stalled.client.dead && zero());

  let cancelled = false; guardCalls = 0; guardAction = () => { if (guardCalls > 20) cancelled = true; };
  before = serializations; const cancelledResult = await observe(f.client.request('cancel', { text: 'x'.repeat(100000) }, 8000, () => cancelled)); guardAction = null;
  check('cancellation discovered during measurement prevents every write and JSON allocation', cancelledResult.error.code === 'EXECUTION_CANCELLED' && serializations === before && zero() && timers.size === 0);
  const fatal = Object.assign(new Error('owner cleanup pending'), { code: 'EOWNERCLEANUP' }); guardCalls = 0;
  guardAction = () => { if (guardCalls > 20) throw fatal; }; before = serializations;
  const blocked = await observe(f.client.request('blocked', { text: 'x'.repeat(100000) }, 8000)); guardAction = null;
  check('owner quarantine during measurement retains fatal identity without model wrapper', blocked.error === fatal && serializations === before && zero() && timers.size === 0);

  const group = Array.from({ length: 6 }, () => fake(true)), waiting = [];
  for (const producer of group.slice(0, 5)) waiting.push(observe(producer.client.request('echo', paramsFor(3 * MiB), 8000)));
  before = serializations;
  const full = await observe(group[5].client.request('echo', { text: 'z'.repeat(2 * MiB) }, 8000));
  check('shared 16MiB queue refuses before serialization across six different clients', /aggregate outgoing queue/.test(full.error.message) && serializations === before && group[5].lines.length === 0 && c.mcpBudgetSnapshot().queuedBytes === 15 * MiB && c.mcpBudgetSnapshot().pending === 5);
  for (const producer of group.slice(0, 5)) { producer.callbacks.shift()(); producer.reply(1); } await Promise.all(waiting);
  for (const client of clients) client.dispose();
  check('all admission failures and drained fake producers leave no requests, bytes or timers', zero() && timers.size === 0);

  if (process.platform !== 'win32') throw Error('actual preflight fixture requires Windows owner'); actual = true;
  const cwd = S.freshCwd('outgoing preflight'), marker = path.join(cwd, 'requests.jsonl'), script = path.join(cwd, 'peer.js');
  fs.writeFileSync(script, `const fs=require('fs');let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);if(q.id===undefined)continue;fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({method:q.method,params:q.params})+'\\n');const result=q.method==='initialize'?{protocolVersion:'2024-11-05'}:{content:[{type:'text',text:q.params.arguments.text}]};process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');}});`);
  const native = c.createMcpStdioClient('native', { command: S.NODE_BIN, args: [script] }); clients.push(native);
  const refused = await observe(native.request('must-not-send', { text: 'x'.repeat(limit) }, 8000));
  check('actual spawned peer receives no oversized request before preflight refusal', refused.error.code === 'MCP_REQUEST_BUDGET' && refused.error.requestNotSent && !fs.existsSync(marker) && !native.dead);
  const text = await native.callTool('echo', { text: literal }), rows = fs.readFileSync(marker, 'utf8').trim().split('\n').map(JSON.parse);
  check('same actual peer negotiates and executes one exact valid call after refusal', text === literal && rows.length === 2 && rows[0].method === 'initialize' && rows[1].method === 'tools/call' && rows[1].params.arguments.text === literal);
  const closed = new Promise(resolve => native.child.once('close', resolve)); native.dispose(); await closed;
  check('actual outgoing refusal and recovery restore native ownership and all MCP accounting', native.child.ownedTree.closed && owner.processOwnerInfo().active === 0 && zero() && timers.size === 0);
  const expected = scope === 'all' ? 20 : 10;
  assert.strictEqual(checks, expected); console.log('MCP/OUTGOING ' + scope + ' ' + checks + '/' + expected);
} finally {
  clearTimeout(deadline); guardAction = null; for (const client of clients) client.dispose();
  for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
  for (const child of children) if (child.exitCode == null && child.signalCode == null) await new Promise(resolve => child.once('close', resolve));
  S.cleanup();
} })().catch(error => { console.error(error.stack); process.exitCode = 1; });
