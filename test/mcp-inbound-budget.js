const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { EventEmitter } = require('events'), { PassThrough, Writable } = require('stream'), { create } = require('./_endpoint');
const S = require('./_shared').create({ suite: 'mcp-inbound-budget' }), source = fs.readFileSync(S.IDX, 'utf8'), clients = [];
const MiB = 1024 * 1024, frameLimit = 4 * MiB; let checks = 0, H;
const deadline = setTimeout(() => { console.error('MCP/INBOUND deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
async function until(predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() >= end) throw Error('owned MCP condition deadline'); await new Promise(r => setTimeout(r, 5)); } }
async function closed(client) { const p = new Promise(r => client.child.once('close', r)); client.dispose(); await Promise.race([p, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('owned MCP close unconfirmed')), 5000); p.then(() => clearTimeout(t)); })]); }
function context(spawn) {
  let parses = 0;
  const c = vm.createContext({ Buffer, process, launchDir: S.runDir, APP_VERSION: 'fixture', MCP_MAX_FRAME_BYTES: frameLimit,
    MCP_CALL_TIMEOUT: 5000, EXECUTION_TIMEOUT_MS: 5000, mcpClients: {}, child_process: { spawn }, resolveCommandOnWindows: () => false,
    console: { log() {}, warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON: { stringify: JSON.stringify, parse(value) { parses++; return JSON.parse(value); } } });
  vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') + cut('function mcpContentToText(', '// A2-19:') + cut('function createMcpStdioClient(', '// Redact secrets'), c);
  return { c, parses: () => parses, stats: () => c.mcpBudgetSnapshot(), add(name, cfg = {}) { const client = c.createMcpStdioClient(name, cfg); clients.push(client); c.mcpClients[name] = client; return client; } };
}
function fake(pages = []) {
  const child = new EventEmitter(), f = { child, pages, requests: [], held: null, exitAfterReply: false };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  f.reply = (id, result) => child.stdout.write(JSON.stringify({ id, result }) + '\n');
  child.stdin = new Writable({ write(chunk, encoding, cb) {
    const req = JSON.parse(chunk.toString()); f.requests.push(req); cb();
    if (req.method === 'initialize') setImmediate(() => f.reply(req.id, {}));
    if (req.method === 'tools/list') setImmediate(() => {
      const page = f.pages.shift(); if (page === 'HOLD') { f.held = req.id; return; }
      f.reply(req.id, page); if (f.exitAfterReply) child.emit('exit', 1);
    });
  } });
  return f;
}
function fakeGroup() { const fakes = [], h = context(() => { const f = fakes.shift(); assert.ok(f, 'owned fake spawn'); return f.child; });
  return Object.assign(h, { make(name, pages) { const f = fake(pages); fakes.push(f); f.client = h.add(name); f.client.initialized = true; return f; } }); }
function schema(size, name) { const tool = { name, description: '' }; tool.description = 'x'.repeat(size - Buffer.byteLength(JSON.stringify([tool]))); return [tool]; }
(async () => { try {
  let h = fakeGroup(), group = Array.from({ length: 5 }, (_, i) => h.make('frame-' + i));
  for (const f of group.slice(0, 4)) f.child.stdout.write(' '.repeat(frameLimit));
  check('four incomplete frames share exact 16MiB admission', h.stats().incomingBytes === 16 * MiB && group.slice(0, 4).every(f => f.client.incomingBytes === frameLimit && !f.client.dead));
  const overflow = observe(group[4].client.request('wait', {}, 5000)); group[4].child.stdout.write('x');
  check('one extra byte retires only offending server and settles its sent call unknown', (await overflow).error.message.includes('aggregate incoming') && h.stats().incomingBytes === 16 * MiB && group.slice(0, 4).every(f => !f.client.dead));
  group[0].child.stdout.write('\n');
  check('complete blank frame releases its bytes without JSON parsing', h.stats().incomingBytes === 12 * MiB && group[0].client.incomingBytes === 0 && h.parses() === 0);
  const replacement = h.make('replacement'); replacement.child.stdout.write(' '.repeat(frameLimit)); group[4].child.emit('exit', 1); group[4].child.stdout.write('late');
  check('late retired data and exit cannot release replacement frame bytes', h.stats().incomingBytes === 16 * MiB && replacement.client.incomingBytes === frameLimit);
  group[1].client.dispose(); group[1].client.dispose();
  check('repeated retirement releases only its own incomplete input', h.stats().incomingBytes === 12 * MiB);
  for (const f of group.concat(replacement)) f.client.dispose();
  check('retiring all incomplete frames leaves shared and per-client counts zero', h.stats().incomingBytes === 0 && group.concat(replacement).every(f => f.client.incomingBytes === 0));

  h = fakeGroup(); let f = h.make('utf8'), request = observe(f.client.request('echo', {}, 5000));
  const encoded = Buffer.from(JSON.stringify({ id: 1, result: '中文😀_TAIL' }) + '\r\n');
  for (let i = 0; i < encoded.length; i++) f.child.stdout.write(encoded.slice(i, i + 1));
  check('real StringDecoder preserves fragmented UTF8 and CRLF, releasing input at dispatch', (await request).value === '中文😀_TAIL' && h.stats().incomingBytes === 0 && f.client.pending.size === 0);
  f = h.make('exact-crlf'); request = observe(f.client.request('echo', {}, 5000));
  const overhead = Buffer.byteLength(JSON.stringify({ id: 1, result: '' })), exact = 'a'.repeat(frameLimit - overhead);
  f.child.stdout.write(JSON.stringify({ id: 1, result: exact }) + '\r\n');
  check('exact 4MiB JSON frame retains existing CRLF compatibility', (await request).value === exact && !f.client.dead && h.stats().incomingBytes === 0);
  f = h.make('oversized'); request = observe(f.client.request('echo', {}, 5000)); const parsed = h.parses();
  f.child.stdout.write(JSON.stringify({ id: 1, result: exact + 'x' }) + '\n');
  check('oversized complete frame is refused before native JSON parsing', (await request).error.message.includes('incoming frame exceeds') && h.parses() === parsed && h.stats().incomingBytes === 0);
  f = h.make('multi-frame'); const waits = [observe(f.client.request('a', {}, 5000)), observe(f.client.request('b', {}, 5000))];
  const a = 'x'.repeat(2200000) + 'FIRST_END', b = 'y'.repeat(2200000) + 'SECOND_END';
  f.child.stdout.write(JSON.stringify({ id: 1, result: a }) + '\n' + JSON.stringify({ id: 2, result: b }) + '\n');
  const pair = await Promise.all(waits);
  check('one chunk over 4MiB with two legal frames dispatches both without false rejection', pair[0].value === a && pair[1].value === b && !f.client.dead && h.stats().incomingBytes === 0);
  f.child.stdout.write('中😀');
  check('retained input is charged by UTF8 bytes rather than UTF16 length', f.client.incomingBytes === 7 && h.stats().incomingBytes === 7);
  f.client.dispose(); check('input disposal restores exact shared capacity', h.stats().incomingBytes === 0);

  h = fakeGroup(); group = Array.from({ length: 4 }, (_, i) => h.make('cache-' + i, [{ tools: schema(MiB, 'n' + i) }]));
  const lists = await Promise.all(group.map(f => f.client.listTools()));
  check('four exact 1MiB caches fill the shared 4MiB schema budget', h.stats().schemaBytes === 4 * MiB && group.every(f => f.client.schemaBytes === MiB && f.client.toolsCacheBytes === MiB));
  const fifth = h.make('cache-fifth', [{ tools: schema(MiB, 'fifth') }]); fifth.client.initialized = false;
  await assert.rejects(fifth.client.listTools(), /aggregate tool schemas.*4MiB/);
  check('new discovery at shared capacity sends neither initialize nor tools/list and retains no partial cache', fifth.requests.length === 0 && fifth.client.schemaBytes === 0 && fifth.client.toolsCache === null && !fifth.client.listingTools && !fifth.client.dead && h.stats().schemaBytes === 4 * MiB);
  const count = group[0].requests.length;
  check('cache hit at full capacity reuses the same object without another reservation', await group[0].client.listTools() === lists[0] && group[0].requests.length === count && h.stats().schemaBytes === 4 * MiB);
  group[0].pages.push({ tools: schema(MiB, 'refreshed') }); await group[0].client.listTools(true);
  check('forced refresh releases its own old cache before replacing it at shared capacity', group[0].client.toolsCache[0].name === 'refreshed' && h.stats().schemaBytes === 4 * MiB && group[1].client.toolsCache === lists[1]);
  group[1].client.dispose(); await fifth.client.listTools();
  check('retired cache capacity admits another server without mutating other caches', h.stats().schemaBytes === 4 * MiB && fifth.client.schemaBytes === MiB && group[2].client.toolsCache === lists[2]);
  for (const f of group.concat(fifth)) f.client.dispose();
  check('all cache owners retired restore aggregate schema bytes to zero', h.stats().schemaBytes === 0);

  h = fakeGroup(); group = Array.from({ length: 3 }, (_, i) => h.make('stable-' + i, [{ tools: schema(MiB, 'stable' + i) }]));
  await Promise.all(group.map(f => f.client.listTools()));
  const partialA = h.make('partial-a', [{ tools: schema(MiB / 2, 'partA'), nextCursor: 'next' }, 'HOLD']);
  const partialB = h.make('partial-b', [{ tools: schema(MiB / 2, 'partB'), nextCursor: 'next' }, 'HOLD']);
  const discoverA = observe(partialA.client.listTools()), discoverB = observe(partialB.client.listTools());
  await until(() => partialA.held !== null && partialB.held !== null);
  check('in-flight paginated discoveries and stable caches share the same exact 4MiB budget', h.stats().schemaBytes === 4 * MiB && partialA.client.toolsCache === null && partialA.client.schemaBytes === MiB / 2 && partialB.client.schemaBytes === MiB / 2);
  partialA.reply(partialA.held, { tools: [{ name: 'one-byte-too-many' }] });
  check('later page overflow discards only failing discovery and publishes no partial list', (await discoverA).error.message.includes('aggregate tool schemas') && partialA.client.schemaBytes === 0 && partialA.client.toolsCache === null && h.stats().schemaBytes === 3.5 * MiB && partialB.client.schemaBytes === MiB / 2 && group.every(f => f.client.toolsCacheBytes === MiB));
  partialB.reply(partialB.held, { tools: [] });
  check('another in-flight discovery still completes after competitor exceeds budget', (await discoverB).value.length === 1 && h.stats().schemaBytes === 3.5 * MiB);
  f = h.make('malformed', [{ tools: [{ name: 'good-first' }], nextCursor: 'next' }, { nope: [] }]);
  await assert.rejects(f.client.listTools(), /tools array/);
  check('malformed later page releases envelope and prior successful page reservation', f.client.schemaBytes === 0 && h.stats().schemaBytes === 3.5 * MiB && !f.client.listingTools);
  f = h.make('cancelled-discovery', ['HOLD']); const token = h.c.createExecutionControl(5000);
  request = observe(f.client.listTools(false, token)); await until(() => f.held !== null); token.cancel('fixture cancel');
  const cancelled = await request; token.dispose(); f.reply(f.held, { tools: [{ name: 'late' }] });
  check('cancelled discovery releases its reservation and late reply cannot resurrect cache', cancelled.error && f.client.dead && f.client.schemaBytes === 0 && f.client.toolsCache === null && h.stats().schemaBytes === 3.5 * MiB);
  f = h.make('exit-during-reply', [{ tools: [{ name: 'late-exit' }] }]); f.exitAfterReply = true;
  await assert.rejects(f.client.listTools(), /closed during tool discovery/);
  check('exit before discovery continuation releases once without affecting other owners', f.client.schemaBytes === 0 && h.stats().schemaBytes === 3.5 * MiB);
  for (const f of group.concat(partialA, partialB)) f.client.dispose();
  check('mixed successful and failed discovery owners settle without shared leakage', h.stats().schemaBytes === 0 && h.stats().pending === 0);

  const script = path.join(S.runDir, 'native-mcp-inbound.js');
  fs.writeFileSync(script, `let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{buf+=d;let n;while((n=buf.indexOf('\\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);if(!line)continue;const r=JSON.parse(line);if(r.id===undefined)continue;const result=r.method==='tools/list'?{tools:[{name:'echo',description:'中😀'.repeat(1024)}]}:r.method==='tools/call'?{content:[{type:'text',text:'ECHO:'+r.params.arguments.text}]}:{};const out=JSON.stringify({id:r.id,result})+'\\r\\n';process.stdout.write(out.slice(0,7));process.stdout.write(out.slice(7));}});`);
  h = context((command, argv, opts) => S.spawn(command, argv, opts));
  const native = [h.add('native-a', { command: S.NODE_BIN, args: [script] }), h.add('native-b', { command: S.NODE_BIN, args: [script] })];
  await Promise.all(native.map(c => c.listTools()));
  check('two owned Node13 MCP servers publish separately counted caches with fully drained frames', h.stats().schemaBytes === native.reduce((n, c) => n + c.toolsCacheBytes, 0) && h.stats().schemaBytes > 14000 && h.stats().incomingBytes === 0 && h.stats().pending === 0);
  const echoed = await Promise.all(native.map(c => c.callTool('echo', { text: '中文😀' })));
  check('same real clients remain usable for fragmented CRLF UTF8 tool responses', echoed.every(value => value === 'ECHO:中文😀') && h.stats().incomingBytes === 0);
  const remaining = native[1].schemaBytes; await closed(native[0]);
  check('observed first native close releases its cache without borrowing second ownership', h.stats().schemaBytes === remaining && native[1].toolsCache !== null);
  await closed(native[1]);
  check('all real direct children close with input/schema/pending/write counters zero', h.stats().schemaBytes === 0 && h.stats().incomingBytes === 0 && h.stats().pending === 0 && h.stats().queuedBytes === 0);
  H = create({ suite: 'mcp-inbound-diagnostics', endpoint: 'http://127.0.0.1:1', key: '', model: 'fixture', permissionMode: 'denial' });
  await H.start(S.freshCwd('diagnostics')); const info = JSON.parse((await H.api('/api/info')).body);
  check('real HTTP diagnostics expose distinct inbound and schema limits with zero idle usage', info.mcpBudget.incomingBytes === 0 && info.mcpBudget.incomingBytesLimit === 16 * MiB && info.mcpBudget.schemaBytes === 0 && info.mcpBudget.schemaBytesLimit === 4 * MiB);
  console.log('MCP/INBOUND ' + checks + '/' + checks + '; SKIP 0');
} finally { clearTimeout(deadline); for (const c of clients) c.dispose(); if (H) { await H.stop(); H.S.cleanup(); } S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
