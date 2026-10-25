const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), { create } = require('./_endpoint'), S = require('./_shared').create({ suite: 'directory-budget' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set(); let checks = 0, server, H;
const tail = process.env.DIRECTORY_PHASE === 'tail';
const deadline = setTimeout(() => { console.error('DIRECTORY/BUDGET deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(name, overrides, extra) { return loadContext(source, S.freshCwd(name), overrides, Object.assign({ Buffer, appDir: path.dirname(S.IDX) }, extra)); }
function fake(count, options = {}) { let reads = 0, closes = 0, opens = 0; const entries = [];
  return { io: { readdirSync() { throw Error('whole-directory read forbidden'); }, opendirSync() { opens++; let i = 0; return { readSync() { reads++; if (options.onRead) options.onRead(i); if (options.readError) throw Error('directory read failed'); if (i >= count) return null; const index = i++, e = { name: options.name ? options.name(index) : 'entry-' + index, isDirectory: () => false, isFile: () => true }; entries.push(e); return e; }, closeSync() { closes++; if (options.closeError) throw Error('directory close failed'); } }; } }, reads: () => reads, opens: () => opens, closes: () => closes, entries };
}
(async () => { try {
  let f, c, r;
  if (!tail) {
  f = fake(1000000); c = context('count', f.io); r = c.readDirectoryEntriesBounded('.');
  check('million-entry logical directory collects 200 and probes one, without whole-array read', r.entries.length === 200 && r.visited === 201 && f.reads() === 201 && f.closes() === 1 && r.incomplete === 'entry limit 200');
  f = fake(200); c = context('exact', f.io); r = c.readDirectoryEntriesBounded('.'); check('exact count can report complete after bounded EOF probe', r.entries.length === 200 && !r.incomplete && f.reads() === 201 && f.closes() === 1);
  f = fake(1000, { name: i => '中'.repeat(100) + i }); c = context('bytes', f.io); r = c.readDirectoryEntriesBounded('.', { maxEntries: 1000, maxBytes: 1000 });
  check('UTF8 name byte budget stops collection before oversized aggregate', r.entries.length === 3 && r.bytes <= 1000 && /byte limit/.test(r.incomplete) && f.closes() === 1);
  f = fake(10); c = context('predeadline', f.io); r = c.readDirectoryEntriesBounded('.', { deadlineAt: 0 }); check('expired deadline creates no directory handle', f.opens() === 0 && r.entries.length === 0 && /deadline/.test(r.incomplete));
  let cancelled = false; f = fake(10, { onRead() { cancelled = true; } }); c = context('cancel', f.io); assert.throws(() => c.readDirectoryEntriesBounded('.', { cancelled: () => cancelled }), e => e.code === 'EXECUTION_CANCELLED');
  check('cancellation between reads closes the owned directory', f.reads() === 1 && f.closes() === 1);
  let clock = 100; f = fake(10, { onRead() { clock += 50; } }); c = context('deadline', f.io, { Date: { now: () => clock } }); r = c.readDirectoryEntriesBounded('.', { deadlineAt: 200 });
  check('scan deadline checks between native IO preserve partial entries and close', r.entries.length === 2 && /deadline/.test(r.incomplete) && f.closes() === 1);
  for (const kind of ['readError', 'closeError']) { f = fake(2, { [kind]: true }); c = context(kind, f.io); assert.throws(() => c.readDirectoryEntriesBounded('.'), /directory (read|close) failed/); check(kind + ' is visible instead of successful empty listing', f.closes() === 1); }
  }
  const real = S.freshCwd('native'), large = path.join(real, 'large'); fs.mkdirSync(large); for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(large, 'file-' + i + '.txt'), 'x');
  let handles = 0; c = loadContext(source, real, { readdirSync() { throw Error('whole-directory read forbidden'); }, opendirSync(dir) { const h = fs.opendirSync(dir); handles++; return { readSync: () => h.readSync(), closeSync() { h.closeSync(); handles--; } }; } }, { Buffer, appDir: path.dirname(S.IDX) });
  vm.runInContext('async function tool(name,args,cancelled){' + cut("  if (name === 'list_dir') {", "  if (name === 'process_list_tool') {") + cut("  if (name === 'list_mcp_resources_tool') {", "  if (name === 'read_mcp_resource_tool') {") + cut("  if (name === 'skill_tool') {", "  if (name === 'prompt_from_file') {") + '}', c);
  if (!tail) {
  const listed = await c.tool('list_dir', { path: 'large' }); check('real filesystem list is bounded, honest and closes handles', listed.status === 'ok' && listed.text.startsWith('[incomplete: entry limit 200]') && listed.text.split('\n').length === 201 && handles === 0);
  const missing = await c.tool('list_dir', { path: 'missing' }); check('missing directory remains an error', missing.status === 'error' && missing.text.startsWith('List error:'));
  const cancelledTool = await c.tool('list_dir', { path: 'large' }, () => true); check('tool cancellation is authoritative and opens no directory', cancelledTool.status === 'cancelled' && handles === 0);
  }
  // A logical 400-directory tree exercises the aggregate startup-map budget,
  // including countFiles and walking the same child. No million real files.
  let visited = 0, opened = 0, closedDirs = 0;
  const tree = context('map', { readdirSync() { throw Error('whole-directory read forbidden'); }, opendirSync(dir) { opened++; let i = 0; const root = dir === tree.launchDir; return { readSync() { if (i >= (root ? 400 : 100000)) return null; const n = i++; visited++; return { name: root ? 'dir-' + n : 'link-' + n, isDirectory: () => root, isFile: () => false }; }, closeSync() { closedDirs++; } }; } });
  vm.runInContext(cut('function buildRepoMap()', 'const SYSTEM_PROMPT_BASE'), tree); const map = tree.buildRepoMap(); check('startup map caps total visits including repeated child counts and closes all handles', visited <= 2000 && opened === closedDirs && map.startsWith('(workspace file map incomplete:') && map.includes('at least'));
  const mcp = path.join(real, '.mcp'), skills = path.join(real, '.7coder', 'skills'); fs.mkdirSync(mcp); fs.mkdirSync(skills, { recursive: true }); for (let i = 0; i < 250; i++) { fs.writeFileSync(path.join(mcp, 'resource-' + i), 'x'); fs.writeFileSync(path.join(skills, 'skill-' + i + '.md'), 'x'); }
  const resources = await c.tool('list_mcp_resources_tool', {}), skill = await c.tool('skill_tool', { skill_name: 'missing' });
  check('resource and missing-skill discovery use bounded incomplete listings', resources.status === 'ok' && resources.text.startsWith('[incomplete: entry limit 200]') && skill.status === 'error' && skill.text.includes('Available skills: [incomplete:') && handles === 0);
  server = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { const body = JSON.parse(raw), hasResult = body.messages.some(m => m.role === 'tool');
    const delta = hasResult ? { content: 'DIRECTORY_DONE' } : { tool_calls: [['dir-call', 'list_dir', { path: 'large' }], ['resources-call', 'list_mcp_resources_tool', {}], ['skill-call', 'skill_tool', { skill_name: 'missing' }]].map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) };
    res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n'); }); }); server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  H = create({ suite: 'directory-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: '', model: 'fixture', permissionMode: 'bypass' }); await H.start(real);
  const result = await H.chat([{ role: 'user', content: 'List directories and resources' }], 5000), done = result.tools.filter(t => t.type === 'result');
  check('actual Agent lists partial results with correct call IDs and statuses', result.content === 'DIRECTORY_DONE' && ['dir-call', 'resources-call'].every(id => done.some(t => t.callId === id && t.status === 'completed' && t.result.startsWith('[incomplete:'))) && done.some(t => t.callId === 'skill-call' && t.status === 'error' && t.result.includes('[incomplete:')));
  const info = JSON.parse((await H.api('/api/info')).body); check('same Agent remains available with no active operations', info.runtime.activeTasks === 0 && info.runtime.activeTools === 0);
  console.log('DIRECTORY/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0' + (tail ? '; selected tail only; first 11 checks NOT RUN' : ''));
} finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
