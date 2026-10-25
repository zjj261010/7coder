const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { EventEmitter } = require('events'), { PassThrough, Writable } = require('stream');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'mcp-retention' });
const source = fs.readFileSync(S.IDX, 'utf8'), clients = []; let checks = 0;
const deadline = setTimeout(() => { console.error('MCP/RETENTION deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error('owned MCP deadline'); await new Promise(r => setTimeout(r, 5)); } }
function context(spawn) {
  const warnings = [], sink = { writableLength: 0 }, clock = { now: 1000 };
  class Clock extends Date { static now() { return clock.now; } }
  const c = loadContext(source, S.runDir, null, { Buffer, Date: Clock, process: { env: process.env, stderr: sink },
    console: { log() {}, warn: line => warnings.push(line) }, mcpClients: Object.create(null), mcpServers: {},
    APP_VERSION: 'fixture', child_process: { spawn }, resolveCommandOnWindows: () => false });
  vm.runInContext(cut('const MCP_CALL_TIMEOUT =', '// One lazily-created client') + cut('function mcpContentToText(', '// A2-19:') + cut('function createMcpStdioClient(', '// Redact secrets'), c);
  return { c, warnings, sink, clock };
}
function fake(pages = []) {
  const child = new EventEmitter(), requests = [], f = { child, requests, pages, held: null }; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  f.reply = (id, result) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const req = JSON.parse(chunk.toString()); requests.push(req); callback();
    if (req.method === 'tools/list') setImmediate(() => {
      const next = f.pages.shift();
      if (next === 'HOLD') { f.held = req.id; return; }
      f.reply(req.id, next);
      if (f.exitAfterReply) child.emit('exit', 1);
    });
  } });
  const h = context(() => child), client = h.c.createMcpStdioClient('fixture', {}); client.initialized = true; clients.push(client); h.c.mcpClients.fixture = client;
  return Object.assign(f, h, { client });
}
async function rejectsList(pages, pattern) { const f = fake(pages); await assert.rejects(f.client.listTools(), pattern); assert.ok(f.client.toolsCache === null && f.client.toolsCacheBytes === 0 && !f.client.listingTools && !f.client.dead); return f; }
(async () => {
  try {
    let f = fake(); const chunk = '中😀'.repeat(2000);
    for (let i = 0; i < 100; i++) f.child.stderr.write(chunk);
    check('stderr burst drains while retaining valid UTF8 tail and one rate-limited log', f.client.stderrBytes === 100 * Buffer.byteLength(chunk) && Buffer.byteLength(f.client.stderrTail) <= 4096 && f.client.stderrTail.endsWith('中😀') && !f.client.stderrTail.includes('\ufffd') && f.warnings.length === 1 && f.client.stderrSuppressedChunks === 99 && f.child.stderr.readableLength === 0 && !f.client.dead);
    for (let i = 0; i < 40; i++) { f.clock.now += 1000; f.child.stderr.write(chunk); }
    const logged = f.warnings.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
    check('per-client forwarded diagnostics remain within 64KiB across elapsed time', logged === f.client.stderrLogBytes && logged <= 64 * 1024 && f.warnings.every(line => Buffer.byteLength(line) + 1 <= 4096) && f.client.stderrSuppressedChunks > 99 && Buffer.byteLength(f.client.stderrTail) <= 4096);
    f.child.stderr.write('PRIVATE_TAIL_SENTINEL'); const snapshot = f.c.mcpDiagnosticsSnapshot();
    check('diagnostic snapshot exposes bounded counts without raw stderr/schema/command', snapshot.length === 1 && snapshot[0].stderr.receivedBytes === f.client.stderrBytes && snapshot[0].stderr.tailBytes <= 4096 && !JSON.stringify(snapshot).includes('PRIVATE_TAIL_SENTINEL') && JSON.stringify(snapshot).length < 1000);
    f = fake(); f.sink.writableLength = 1024 * 1024; f.child.stderr.write('backpressure中文😀');
    check('backed-up parent stderr receives no additional writes and child still drains', f.warnings.length === 0 && f.client.stderrLogBytes === 0 && f.client.stderrSuppressedChunks === 1 && f.child.stderr.readableLength === 0 && f.client.stderrTail.includes('中文😀'));
    f.sink.writableLength = 0; f.clock.now += 1000; f.child.stderr.write('next'); check('diagnostics resume after parent drain without replaying entire omitted history', f.warnings.length === 1 && f.warnings[0].includes('unforwarded chunks=1') && Buffer.byteLength(f.warnings[0]) < 4096);
    f.clock.now -= 5000; for (let i = 0; i < 10; i++) f.child.stderr.write('rollback'); check('clock rollback allows one new report without a log storm', f.warnings.length === 2);
    const before = f.client.stderrBytes; f.client.dispose(); f.child.stderr.write('late-data'); check('retired client ignores late stderr and releases cache/pending references', f.client.stderrBytes === before && f.client.toolsCache === null && f.client.toolsCacheBytes === 0 && f.c.mcpDiagnosticsSnapshot().length === 0);
    f = fake([{ tools: [{ name: 'echo' }], nextCursor: 'next' }, { tools: [{ name: 'add' }] }]); const tools = await f.client.listTools(); const count = f.requests.length;
    check('bounded discovery follows cursor and publishes complete exact-byte cache once', tools.map(t => t.name).join(',') === 'echo,add' && f.requests[0].params.cursor === undefined && f.requests[1].params.cursor === 'next' && f.client.toolsCacheBytes === Buffer.byteLength(JSON.stringify(tools)) && !f.client.listingTools && (await f.client.listTools()) === tools && f.requests.length === count);
    const tool = { name: 'x', description: '' }, padding = 1024 * 1024 - Buffer.byteLength(JSON.stringify([tool])); tool.description = 'x'.repeat(padding);
    f = fake([{ tools: [tool] }]); check('exact 1MiB tool schema cache is accepted', (await f.client.listTools()).length === 1 && f.client.toolsCacheBytes === 1024 * 1024);
    await rejectsList([{ tools: [{ name: 'x', description: tool.description + 'x' }] }], /1MiB cache budget/); check('schema cache overflow is refused without partial cache or client retirement', true);
    f = fake([{ tools: Array.from({ length: 256 }, (_, i) => ({ name: 'n' + i })) }]); check('256 tool names are accepted', (await f.client.listTools()).length === 256);
    await rejectsList([{ tools: Array.from({ length: 200 }, (_, i) => ({ name: 'n' + i })), nextCursor: 'page' }, { tools: Array.from({ length: 57 }, (_, i) => ({ name: 'extra' + i })) }], /256 tools/);
    check('tool-count budget applies across pages with no complete-list claim', true);
    for (const reply of [{ nope: [] }, { tools: [null] }, { tools: [{ name: '' }] }, { tools: [{ name: 'x'.repeat(257) }] }, { tools: [{ name: 'same' }, { name: 'same' }] }]) await rejectsList([reply], /tools array|invalid or duplicate/);
    check('malformed/missing/duplicate tool names fail instead of empty-success caching', true);
    await rejectsList([{ tools: [{ name: 'same' }], nextCursor: 'x' }, { tools: [{ name: 'same' }] }], /duplicate/);
    f = await rejectsList([{ tools: [], nextCursor: 'x' }, { tools: [], nextCursor: 'x' }], /repeated cursor/);
    check('duplicate cross-page names and cursor cycles are rejected promptly', f.requests.length === 2);
    f = await rejectsList(Array.from({ length: 8 }, (_, i) => ({ tools: [], nextCursor: 'page-' + i })), /8 pages/); check('discovery page limit stops before a ninth request', f.requests.length === 8);
    f = await rejectsList([{ tools: [], nextCursor: 'x'.repeat(1025) }], /invalid or repeated cursor/); check('cursor size limit rejects before another request', f.requests.length === 1);
    f = fake(['HOLD']); const first = f.client.listTools(); await until(() => f.held !== null); await assert.rejects(f.client.listTools(true), /already running; request not sent/);
    check('concurrent discovery is refused without another request or queue', f.requests.length === 1 && f.client.pending.size === 1); f.reply(f.held, { tools: [{ name: 'first' }] }); await first;
    f.pages.push({ nope: [] }); await assert.rejects(f.client.listTools(true), /tools array/); f.pages.push({ tools: [{ name: 'new' }] });
    check('failed forced refresh clears stale cache and next discovery recovers', f.client.toolsCache === null && !f.client.listingTools && (await f.client.listTools())[0].name === 'new');
    f = fake([{ tools: [{ name: 'late' }] }]); f.exitAfterReply = true; await assert.rejects(f.client.listTools(), /closed during tool discovery/); check('close after reply cannot repopulate a retired client cache', f.client.dead && f.client.toolsCache === null && f.client.toolsCacheBytes === 0 && !f.client.listingTools);
    const script = path.join(S.runDir, 'mcp-retention-server.js'), nativeBytes = 80 * Buffer.byteLength('中😀'.repeat(1024));
    fs.writeFileSync(script, `let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{buf+=d;let nl;while((nl=buf.indexOf('\\n'))>=0){const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(!line)continue;const r=JSON.parse(line);if(r.id===undefined)continue;let result={};if(r.method==='tools/list'){if(!r.params.cursor){for(let i=0;i<80;i++)process.stderr.write('中😀'.repeat(1024));result={tools:[{name:'echo'}],nextCursor:'next'};}else result={tools:[{name:'add'}]};}else if(r.method==='tools/call')result={content:[{type:'text',text:'ECHO:'+r.params.arguments.text}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`);
    const native = context((command, argv, opts) => S.spawn(command, argv, opts)), client = native.c.createMcpStdioClient('native', { command: S.NODE_BIN, args: [script] }); clients.push(client); native.c.mcpClients.native = client;
    const realTools = await client.listTools(); await until(() => client.stderrBytes === nativeBytes);
    check('owned Node13 server paginates while real stderr flood drains into bounded diagnostics', realTools.map(t => t.name).join(',') === 'echo,add' && client.toolsCacheBytes < 1024 && Buffer.byteLength(client.stderrTail) <= 4096 && client.stderrLogBytes <= 64 * 1024 && native.warnings.length === 1 && client.pending.size === 0);
    check('same native client still completes a UTF8 tool call after flood and discovery', await client.callTool('echo', { text: '中文😀' }) === 'ECHO:中文😀');
    const closed = new Promise(resolve => client.child.once('close', resolve)); client.dispose(); await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('native close unconfirmed')), 5000); closed.then(() => clearTimeout(timer)); })]);
    check('owned direct server close clears cache and diagnostics entry without leaving requests', client.dead && client.toolsCache === null && client.toolsCacheBytes === 0 && client.pending.size === 0 && native.c.mcpDiagnosticsSnapshot().length === 0);
    console.log('MCP/RETENTION ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally { clearTimeout(deadline); for (const client of clients) client.dispose(); S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
