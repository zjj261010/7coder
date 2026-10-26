// Real private files/NTFS links plus the original Audit/Runtime append paths.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), { create } = require('./_endpoint');
const S = require('./_shared').create({ suite: 'diagnostic-log-ownership' }), source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set();
let checks = 0, server, H;
const tail = process.env.DIAGNOSTIC_SCOPE === 'tail';
const deadline = setTimeout(() => { console.error('DIAGNOSTIC/OWNERSHIP deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
const same = (file, bytes) => fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(bytes));
function seed(file, size) { const fd = fs.openSync(file, 'w'); try { fs.ftruncateSync(fd, size); if (size) fs.writeSync(fd, Buffer.from('\n'), 0, 1, size - 1); } finally { fs.closeSync(fd); } }
function fixture(actor, name, overrides = {}) {
  const cwd = S.freshCwd(actor + '-' + name), root = path.join(cwd, '.7coder'), warnings = [], fds = new Set(); fs.mkdirSync(root);
  const file = path.join(root, actor + '.jsonl'), old = path.join(root, actor + '.old.jsonl'); let reads = 0;
  const c = loadContext(source, cwd, Object.assign({
    openSync(...args) { const fd = fs.openSync(...args); fds.add(fd); return fd; },
    closeSync(fd) { try { fs.closeSync(fd); } finally { fds.delete(fd); } },
    readSync(...args) { reads++; return fs.readSync(...args); }
  }, overrides), { Buffer, Date, AUDIT_ENABLED: true, auditDirReady: false, console: { warn: text => warnings.push(text), log() {} } });
  vm.runInContext(cut('function sanitizeAuditArgs(', '// No-key is a valid setup'), c);
  return { actor, cwd, root, file, old, c, warnings, fds, limit: (actor === 'audit' ? 5 : 1) * 1024 * 1024, reads: () => reads,
    act() { if (actor === 'audit') return c.audit({ type: 'tool', tool: 'read_file', callId: 'fixture-id', status: 'ok' }); c.beginRuntimeOperation('cli-task')('ok'); return c.runtimeSnapshot().loggingError === null; },
    fault() { return actor === 'audit' ? c.auditSnapshot().lastError : c.runtimeSnapshot().loggingError; } };
}
(async () => { try {
  for (const actor of ['audit', 'runtime']) {
    let f, original;
    if (!tail || actor !== 'audit') {
    f = fixture(actor, 'hardlink'); original = path.join(f.cwd, 'project-data.txt'); fs.writeFileSync(original, 'PROJECT_DATA\n'); fs.linkSync(original, f.file);
    check(actor + ': aliased primary is refused without changing project data', f.act() === false && same(original, 'PROJECT_DATA\n') && same(f.file, 'PROJECT_DATA\n') && f.fds.size === 0);
    f = fixture(actor, 'archive-link'); seed(f.file, f.limit); fs.writeFileSync(f.old, 'ARCHIVE_DATA\n'); original = path.join(f.cwd, 'archive-alias.txt'); fs.linkSync(f.old, original);
    check(actor + ': aliased archive blocks rotation without deleting either link or primary', f.act() === false && fs.statSync(f.file).size === f.limit && same(original, 'ARCHIVE_DATA\n') && same(f.old, 'ARCHIVE_DATA\n'));
    f = fixture(actor, 'rotation-denied', { renameSync() { throw Object.assign(Error('private rename failure'), { code: 'EACCES' }); } }); seed(f.file, f.limit); fs.writeFileSync(f.old, 'PREVIOUS_EVIDENCE\n');
    check(actor + ': failed rename preserves the prior archive and never appends to full primary', f.act() === false && same(f.old, 'PREVIOUS_EVIDENCE\n') && fs.statSync(f.file).size === f.limit && f.fault().code === 'EACCES');
    f = fixture(actor, 'archive-directory'); seed(f.file, f.limit); fs.mkdirSync(f.old);
    check(actor + ': archive directory is preserved and blocks rotation', f.act() === false && fs.statSync(f.old).isDirectory() && fs.statSync(f.file).size === f.limit);
    f = fixture(actor, 'oversized'); seed(f.file, f.limit + 1); fs.writeFileSync(f.old, 'OLDER\n');
    check(actor + ': existing oversized log is preserved with zero content reads', f.act() === false && f.reads() === 0 && f.fds.size === 0 && fs.statSync(f.file).size === f.limit + 1 && same(f.old, 'OLDER\n'));
    f = fixture(actor, 'torn-tail'); fs.writeFileSync(f.file, '{partial');
    for (let n = 0; n < 3; n++) assert.strictEqual(f.act(), false);
    check(actor + ': torn tail stays intact, closes handles and warns once across repeated events', same(f.file, '{partial') && f.fds.size === 0 && f.warnings.length === 1 && f.fault().message.includes('tail is incomplete'));
    let writes = 0; f = fixture(actor, 'partial-write', { writeSync(fd, bytes, offset, length, position) { if (++writes === 1) return fs.writeSync(fd, bytes, offset, 5, position); throw Object.assign(Error('private full disk'), { code: 'ENOSPC' }); } });
    assert.strictEqual(f.act(), false); assert.strictEqual(f.act(), false);
    check(actor + ': partial write closes descriptor and next event refuses damaged tail', fs.statSync(f.file).size === 5 && writes === 2 && f.fds.size === 0);
    f = fixture(actor, 'zero-progress', { writeSync() { return 0; } });
    check(actor + ': zero-progress writes stop without spinning or leaking fd', f.act() === false && fs.statSync(f.file).size === 0 && f.fds.size === 0 && f.fault().message.includes('no progress'));
    f = fixture(actor, 'open-denied', { openSync() { throw Object.assign(Error('private open denied'), { code: 'EACCES' }); } }); fs.writeFileSync(f.file, 'BEFORE\n');
    check(actor + ': open failure preserves log and exposes errno', f.act() === false && same(f.file, 'BEFORE\n') && f.fault().code === 'EACCES');

    f = fixture(actor, 'swap-before-open'); fs.writeFileSync(f.file, 'BEFORE\n'); const savedBefore = path.join(f.root, 'saved-before.jsonl');
    f.c.fs.openSync = function(file, flags) { if (file === f.file && flags === 'a+') { fs.renameSync(file, savedBefore); fs.writeFileSync(file, 'FOREIGN\n'); } const fd = fs.openSync(file, flags); f.fds.add(fd); return fd; };
    check(actor + ': replacement between snapshot/open is never appended', f.act() === false && same(f.file, 'FOREIGN\n') && same(savedBefore, 'BEFORE\n') && f.fds.size === 0 && f.fault().code === 'ELOGOWNERSHIP');
    f = fixture(actor, 'swap-after-open'); fs.writeFileSync(f.file, 'BEFORE\n'); const savedAfter = path.join(f.root, 'saved-after.jsonl');
    f.c.fs.openSync = function(file, flags) { const fd = fs.openSync(file, flags); f.fds.add(fd); if (file === f.file && flags === 'a+') { fs.renameSync(file, savedAfter); fs.writeFileSync(file, 'FOREIGN\n'); } return fd; };
    check(actor + ': replacement after open preserves both foreign name and held original', f.act() === false && same(f.file, 'FOREIGN\n') && same(savedAfter, 'BEFORE\n') && f.fds.size === 0);
    f = fixture(actor, 'archive-swap'); seed(f.file, f.limit); fs.writeFileSync(f.old, 'BEFORE_ARCHIVE\n'); let oldStats = 0;
    const savedArchive = path.join(f.root, 'saved-archive.jsonl');
    f.c.fs.lstatSync = file => { if (file === f.old && ++oldStats === 2) { fs.renameSync(file, savedArchive); fs.writeFileSync(file, 'FOREIGN_ARCHIVE\n'); } return fs.lstatSync(file); };
    check(actor + ': changed archive identity prevents rename without deleting replacement', f.act() === false && fs.statSync(f.file).size === f.limit && same(f.old, 'FOREIGN_ARCHIVE\n') && same(savedArchive, 'BEFORE_ARCHIVE\n'));

    f = fixture(actor, 'parent-junction'); fs.writeFileSync(f.file, 'BEFORE\n'); let anchored = false, stats = 0;
    const captured = f.c.captureTempParent; f.c.captureTempParent = (...args) => { const value = captured(...args); anchored = true; return value; };
    const moved = path.join(S.freshCwd(actor + '-moved-owned'), 'saved-root'), foreign = S.freshCwd(actor + '-foreign-owned'); fs.writeFileSync(path.join(foreign, path.basename(f.file)), 'FOREIGN\n');
    f.c.fs.lstatSync = file => { if (anchored && file === f.file && ++stats === 2) { fs.renameSync(f.root, moved); fs.symlinkSync(foreign, f.root, 'junction'); } return fs.lstatSync(file); };
    try { check(actor + ': parent junction replacement after anchor preserves all owned fixture files', f.act() === false && same(path.join(foreign, path.basename(f.file)), 'FOREIGN\n') && same(path.join(moved, path.basename(f.file)), 'BEFORE\n') && f.fds.size === 0 && f.fault().code === 'ELOGOWNERSHIP'); }
    finally { if (fs.lstatSync(f.root).isSymbolicLink()) fs.rmdirSync(f.root); }

    f = fixture(actor, 'short-writes'); let calls = 0;
    f.c.fs.writeSync = (fd, bytes, offset, length, position) => { calls++; return fs.writeSync(fd, bytes, offset, Math.min(length, 7), position); };
    check(actor + ': legal short writes produce one complete JSON record and close fd', f.act() === true && calls > 1 && JSON.parse(fs.readFileSync(f.file, 'utf8')) && f.fds.size === 0);
    }
    f = fixture(actor, 'normal-rotation'); seed(f.file, f.limit); fs.writeFileSync(f.old, 'OLD_ARCHIVE\n');
    check(actor + ': successful rename replacement retains full previous generation and a bounded new primary', f.act() === true && fs.statSync(f.old).size === f.limit && fs.statSync(f.file).size < f.limit && f.fds.size === 0);
  }

  const cwd = S.freshCwd('actual-agent'), root = path.join(cwd, '.7coder'); fs.mkdirSync(root);
  const runtimeTarget = path.join(cwd, 'runtime-project-data.txt'), auditTarget = path.join(cwd, 'audit-project-data.txt');
  fs.writeFileSync(runtimeTarget, 'PROJECT_RUNTIME\n'); fs.writeFileSync(auditTarget, 'PROJECT_AUDIT\n');
  const runtime = path.join(root, 'runtime.jsonl'), audit = path.join(root, 'audit.jsonl'); fs.linkSync(runtimeTarget, runtime); fs.linkSync(auditTarget, audit);
  server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'LOG_OWNERSHIP_CORE_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n'); }); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  H = create({ suite: 'diagnostic-log-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: '', model: 'fixture', permissionMode: 'bypass' }); await H.start(cwd);
  const first = await H.chat([{ role: 'user', content: 'diagnostic alias fixture' }], 5000); let info = JSON.parse((await H.api('/api/info')).body);
  check('actual Agent completes core task while both aliased logs fail visibly and preserve project bytes', first.content === 'LOG_OWNERSHIP_CORE_OK' && info.runtime.loggingError && info.audit.lastError && info.audit.dropped > 0 && same(runtimeTarget, 'PROJECT_RUNTIME\n') && same(auditTarget, 'PROJECT_AUDIT\n'));
  fs.unlinkSync(runtime); fs.unlinkSync(audit);
  const next = await H.chat([{ role: 'user', content: 'diagnostics after owned fixture repair' }], 5000); info = JSON.parse((await H.api('/api/info')).body);
  check('same Agent resumes both log streams after repair while keeping cumulative audit loss count', next.content === 'LOG_OWNERSHIP_CORE_OK' && info.runtime.loggingError === null && info.audit.lastError === null && info.audit.dropped > 0 && info.audit.written > 0 && S.readLog(runtime).length > 0 && S.readLog(audit).length > 0 && same(runtimeTarget, 'PROJECT_RUNTIME\n') && same(auditTarget, 'PROJECT_AUDIT\n'));
  check('diagnostic faults and repair leave no active core operation', info.runtime.activeTasks === 0 && info.runtime.activeTools === 0);
  console.log('DIAGNOSTIC/OWNERSHIP ' + checks + '/' + checks + '; SKIP 0' + (tail ? '; failed/unrun tail only; first 14 audit checks NOT RUN' : ''));
} finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
