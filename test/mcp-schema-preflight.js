'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const { EventEmitter } = require('events'), { PassThrough, Writable } = require('stream');
const S = require('./_shared').create({ suite: 'mcp-schema-preflight' }), root = path.dirname(S.IDX), source = fs.readFileSync(S.IDX, 'utf8');
const MiB = 1024 * 1024, clients = [], children = [], queue = [], owner = require(path.join(root, 'lib', 'process-owner')).create(cp, root);
let checks = 0, serializations = 0, actual = false, blocked = false;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start); return source.slice(start, end); }
const fatal = Object.assign(new Error('owned cleanup pending'), { code: 'EOWNERCLEANUP' });
const c = vm.createContext({ Buffer, process, path, launchDir: S.runDir, APP_VERSION: 'fixture', mcpClients: {}, MCP_MAX_FRAME_BYTES: 4 * MiB, MCP_CALL_TIMEOUT: 5000,
  EXECUTION_TIMEOUT_MS: 5000, console: { log() {}, warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval, resolveCommandOnWindows: () => false,
  JSON: { parse: JSON.parse, stringify(value) { serializations++; return JSON.stringify(value); } },
  child_process: { assertProcessOwnerReady() { if (blocked) throw fatal; owner.assertProcessOwnerReady(); }, spawn(file, args, options) {
    if (!actual) return queue.shift().child;
    const child = owner.spawn(file, args, options); children.push(child); child.on('error', () => {});
    if (child.pid) fs.appendFileSync(S.manifest, child.pid + '\t' + S.runDir + '\n'); return child;
  } } });
vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') + cut('function mcpContentToText(', '// A2-19:') + cut('function createMcpStdioClient(', '// Redact secrets'), c);
const measure = c.serializeModelRequest;
function fake(pages) {
  const child = new EventEmitter(), writes = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  child.stdin = new Writable({ write(bytes, encoding, cb) {
    const request = JSON.parse(bytes); writes.push(request); cb();
    if (request.method === 'tools/list') setImmediate(() => {
      const page = pages.shift(); assert.notStrictEqual(page, undefined, 'fixture page exhausted');
      if (typeof page === 'string') child.stdout.write('{"jsonrpc":"2.0","id":' + request.id + ',"result":' + page + '}\n');
      else child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: page }) + '\n');
    });
  } });
  queue.push({ child }); const client = c.createMcpStdioClient('fake-' + clients.length, {}); client.initialized = true; clients.push(client);
  return { client, writes };
}
function sized(bytes, name = 'size') { const tools = [{ name, description: '' }]; tools[0].description = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(tools))); assert.strictEqual(Buffer.byteLength(JSON.stringify(tools)), bytes); return tools; }
function clean(client) { const stats = c.mcpBudgetSnapshot(); return client.toolsCache === null && client.schemaBytes === 0 && !client.listingTools && !client.dead && stats.pending === 0 && stats.deliveries === 0 && stats.deliveryBytes === 0; }
async function rejected(pages, pattern) { const f = fake(pages); const before = serializations; await assert.rejects(f.client.listTools(), error => error.code === 'MCP_SCHEMA_BUDGET' && !error.requestNotSent && pattern.test(error.message)); assert.ok(clean(f.client)); assert.strictEqual(serializations - before, f.writes.length); return f; }
const deadline = setTimeout(() => { console.error('MCP/SCHEMA deadline'); for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill(); process.exit(1); }, 30000);
(async () => { try {
  let f = fake([{ tools: sized(MiB) }]), before = serializations;
  await f.client.listTools();
  check('exact 1MiB schema succeeds with no full JSON copy during measurement', f.client.toolsCacheBytes === MiB && serializations - before === 1);
  const stable = f.client, stableBytes = stable.schemaBytes;
  await rejected([{ tools: sized(MiB + 1) }], /1MiB cache budget/);
  check('one-byte schema overflow fails before stringify and leaves other cache intact', stable.schemaBytes === stableBytes && c.mcpBudgetSnapshot().schemaBytes === stableBytes);

  const expanded = '{"tools":[{"name":"numbers","inputSchema":{"enum":[' + '1e20,'.repeat(59999) + '1e20]}}]}';
  assert.ok(Buffer.byteLength(expanded) < MiB && Buffer.byteLength(JSON.stringify(JSON.parse(expanded).tools)) > MiB);
  await rejected([expanded], /byte budget/);
  check('short numeric wire literals cannot allocate over-budget normalized schema JSON', true);
  const deep = '{"tools":[{"name":"deep","inputSchema":' + '['.repeat(20000) + '0' + ']'.repeat(20000) + '}]}';
  assert.throws(() => JSON.stringify(JSON.parse(deep).tools), /call stack/i);
  await rejected([deep], /64 nested levels/);
  check('deep parsed schemas are refused by bounded walk before native stringify recursion', true);
  const nodes = '{"tools":[{"name":"nodes","inputSchema":{"enum":[' + '0,'.repeat(100000) + '0]}}]}';
  await rejected([nodes], /100000 values/);
  check('large small-value schema rejects at node limit before stringify', true);

  let value = 0; for (let i = 0; i < 62; i++) value = { child: value };
  f = fake([{ tools: [{ name: 'depth64', inputSchema: value }] }]); before = serializations; await f.client.listTools();
  check('64-level structural boundary remains accepted without serialization copy', serializations - before === 1 && f.client.toolsCache[0].name === 'depth64'); f.client.dispose();
  await rejected([{ tools: [{ name: 'depth65', inputSchema: { child: value } }] }], /64 nested levels/);
  check('65-level boundary rejects with MCP-specific already-sent semantics', true);
  const utf8 = [{ name: 'quoted', description: '中文😀"\\\n\u0000\ud800' }];
  f = fake([{ tools: utf8 }]); before = serializations; await f.client.listTools();
  check('UTF8, escaped controls and unpaired surrogate measure actual cache bytes', f.client.toolsCacheBytes === Buffer.byteLength(JSON.stringify(utf8)) && serializations - before === 1); f.client.dispose();

  f = fake([{ tools: sized(MiB / 2, 'first'), nextCursor: 'next' }, { tools: sized(MiB / 2 + 1, 'second') }]); before = serializations; await f.client.listTools();
  check('two-page exact boundary includes array replacement and comma bytes', f.client.toolsCacheBytes === MiB && f.client.toolsCache.length === 2 && serializations - before === 2); f.client.dispose();
  await rejected([{ tools: sized(MiB / 2, 'first'), nextCursor: 'next' }, { tools: sized(MiB / 2 + 2, 'second') }], /byte budget/);
  check('later page uses remaining budget and clears all partial schemas on overflow', c.mcpBudgetSnapshot().schemaBytes === stableBytes);
  f = fake([{ tools: sized(MiB, 'full'), nextCursor: 'next' }, { tools: [] }]); await f.client.listTools();
  check('empty final page consumes no separator or extra cache bytes', f.client.toolsCacheBytes === MiB && f.client.toolsCache.length === 1); f.client.dispose();

  let cancelled = false;
  c.serializeModelRequest = (...args) => { if (Array.isArray(args[0])) cancelled = true; return measure(...args); };
  f = fake([{ tools: [{ name: 'cancelled' }] }]);
  await assert.rejects(f.client.listTools(false, () => cancelled), error => error.code === 'EXECUTION_CANCELLED'); c.serializeModelRequest = measure;
  check('cancellation during preflight retains cancellation code and frees partial state', clean(f.client));
  c.serializeModelRequest = (...args) => { if (Array.isArray(args[0])) blocked = true; return measure(...args); };
  f = fake([{ tools: [{ name: 'blocked' }] }]); await assert.rejects(f.client.listTools(), error => error === fatal); blocked = false; c.serializeModelRequest = measure;
  check('owner guard during preflight escapes without false request-not-sent wrapper', clean(f.client));
  for (const client of clients) client.dispose();
  check('all schema refusals and accepted cache owners restore complete accounting', ['schemaBytes', 'pending', 'queuedBytes', 'incomingBytes', 'deliveries', 'deliveryBytes'].every(key => c.mcpBudgetSnapshot()[key] === 0));

  if (process.platform !== 'win32') throw Error('actual schema fixture requires Windows owner'); actual = true;
  const cwd = S.freshCwd('schema preflight'), script = path.join(cwd, 'peer.js');
  fs.writeFileSync(script, `let buf='',listed=0;process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);if(q.id===undefined)continue;if(q.method==='initialize')process.stdout.write(JSON.stringify({id:q.id,result:{protocolVersion:'2024-11-05'}})+'\\n');else if(q.method==='tools/list'&&listed++===0)process.stdout.write('{"id":'+q.id+',"result":'+${JSON.stringify(expanded)}+'}\\n');else process.stdout.write(JSON.stringify({id:q.id,result:{tools:[{name:'recovered'}]}})+'\\n');}});`);
  const native = c.createMcpStdioClient('native', { command: S.NODE_BIN, args: [script] }); clients.push(native);
  await assert.rejects(native.listTools(), error => error.code === 'MCP_SCHEMA_BUDGET' && !error.requestNotSent);
  check('actual peer oversized normalized schema rejects without cache or dead session', clean(native));
  const tools = await native.listTools();
  check('same actual peer explicitly rediscovers successfully without automatic replay', tools[0].name === 'recovered' && native.initialized && native.toolsCacheBytes === Buffer.byteLength(JSON.stringify(tools)));
  const closed = new Promise(resolve => native.child.once('close', resolve)); native.dispose(); await closed;
  check('actual schema budget failure and recovery close owned tree and return all resources', native.child.ownedTree.closed && owner.processOwnerInfo().active === 0 && ['schemaBytes', 'pending', 'queuedBytes', 'incomingBytes', 'deliveries', 'deliveryBytes'].every(key => c.mcpBudgetSnapshot()[key] === 0));
  assert.strictEqual(checks, 17); console.log('MCP/SCHEMA 17/17');
} finally {
  clearTimeout(deadline); blocked = false; c.serializeModelRequest = measure; for (const client of clients) client.dispose();
  for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
  for (const child of children) if (child.exitCode == null && child.signalCode == null) await new Promise(resolve => child.once('close', resolve));
  S.cleanup();
} })().catch(error => { console.error(error.stack); process.exitCode = 1; });
