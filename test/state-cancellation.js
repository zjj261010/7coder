const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), { create } = require('./_endpoint');
const S = require('./_shared').create({ suite: 'state-cancellation' }), source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set();
let checks = 0, server, H;
const deadline = setTimeout(() => { console.error('STATE/CANCELLATION deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
const same = (file, text) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
function fixture(name, value = 'OLD') {
  const cwd = S.freshCwd(name), file = path.join(cwd, 'state.txt'), fds = new Map(), clock = { now: 0 }, counters = { reads: 0, bytes: 0, opens: 0, dirs: 0, closedDirs: 0 };
  fs.writeFileSync(file, value); fs.writeFileSync(file + '.7coder-prev', 'OLDER');
  class Clock extends Date { static now() { return clock.now; } }
  const c = loadContext(source, cwd, {
    openSync(file, flags, mode) { counters.opens++; const fd = fs.openSync(file, flags, mode); fds.set(fd, String(file)); return fd; },
    closeSync(fd) { try { fs.closeSync(fd); } finally { fds.delete(fd); } },
    readSync(...args) { counters.reads++; const n = fs.readSync(...args); counters.bytes += n; return n; },
    opendirSync(file) { counters.dirs++; const d = fs.opendirSync(file); return { readSync: () => d.readSync(), closeSync() { d.closeSync(); counters.closedDirs++; } }; }
  }, { Date: Clock, console: { log() {}, warn() {} } });
  vm.runInContext('async function brief(args,cancelled){const name="brief_tool";' + cut("  if (name === 'brief_tool') {", "  if (name === 'task_create_tool') {") + '}', c);
  const token = () => clock.now >= 100; token.deadlineAt = 100; token.reason = 'fixture absolute deadline';
  const artifacts = () => {
    const rows = []; function walk(dir) { for (const name of fs.readdirSync(dir)) { const full = path.join(dir, name); if (fs.statSync(full).isDirectory()) walk(full); else rows.push(full); } } walk(cwd); return rows;
  };
  return { cwd, file, previous: file + '.7coder-prev', c, fds, clock, token, counters, artifacts,
    noTemp: () => !artifacts().some(file => file.includes('.7coder-tmp-')),
    read: parse => c.readStateRecord(file, parse || c.parseStateText, false, 8 * 1024 * 1024, token),
    write: text => c.writeStateFile(file, text, c.parseStateText, undefined, token) };
}
const cancelled = e => e.code === 'EXECUTION_CANCELLED';
(async () => { try {
  let f = fixture('pre-cancel'); f.clock.now = 200;
  assert.throws(() => f.read(), cancelled); assert.throws(() => f.write('NEW'), cancelled);
  check('pre-cancelled controlled reads/writes open no files and preserve primary/previous', f.counters.opens === 0 && same(f.file, 'OLD') && same(f.previous, 'OLDER'));
  f = fixture('read-chunk', 'x'.repeat(200000)); const readChunk = f.c.fs.readSync;
  f.c.fs.readSync = (...args) => { const n = readChunk(...args); f.clock.now = 200; return n; };
  assert.throws(() => f.read(), cancelled);
  check('deadline after first native read stops within 64KiB and closes held descriptor', f.counters.reads === 1 && f.counters.bytes === 65536 && f.fds.size === 0 && f.artifacts().length === 2);
  f = fixture('empty-read', ''); const emptyRead = f.c.fs.readSync;
  f.c.fs.readSync = (...args) => { const n = emptyRead(...args); f.clock.now = 200; return n; };
  assert.throws(() => f.read(), cancelled);
  check('EOF on empty input still checks cancellation and cannot return empty-success', f.counters.bytes === 0 && f.fds.size === 0 && same(f.file, ''));
  f = fixture('parse-expiry', '{bad');
  assert.throws(() => f.read(() => { f.clock.now = 200; throw Error('invalid JSON'); }), cancelled);
  check('expiry while parsing is not misclassified as corrupt data or quarantined', same(f.file, '{bad') && same(f.previous, 'OLDER') && f.artifacts().length === 2);
  f = fixture('cancel-error-from-parser');
  assert.throws(() => f.read(() => { throw Object.assign(Error('parser cancelled'), { code: 'EXECUTION_CANCELLED' }); }), cancelled);
  check('explicit cancellation error from parser never triggers corruption recovery', f.artifacts().length === 2 && same(f.file, 'OLD'));
  f = fixture('read-close-expiry'); const readClose = f.c.fs.closeSync;
  f.c.fs.closeSync = fd => { readClose(fd); f.clock.now = 200; };
  assert.throws(() => f.write('NEW'), cancelled);
  check('deadline after reader close prevents even previous-version publication', same(f.file, 'OLD') && same(f.previous, 'OLDER') && f.noTemp());

  for (const phase of ['create', 'previous-write', 'primary-write', 'primary-flush', 'previous-published']) {
    f = fixture(phase); const open = f.c.fs.openSync, write = f.c.fs.writeFileSync, sync = f.c.fs.fsyncSync, rename = f.c.fs.renameSync;
    f.c.fs.openSync = (...args) => { const fd = open(...args); if (phase === 'create' && args[1] === 'wx') f.clock.now = 200; return fd; };
    f.c.fs.writeFileSync = (fd, bytes, ...rest) => { const result = write(fd, bytes, ...rest), name = f.fds.get(fd) || '';
      if (phase === 'previous-write' && name.startsWith(f.previous + '.7coder-tmp-') || phase === 'primary-write' && name.startsWith(f.file + '.7coder-tmp-')) f.clock.now = 200; return result; };
    f.c.fs.fsyncSync = fd => { const result = sync(fd); if (phase === 'primary-flush' && (f.fds.get(fd) || '').startsWith(f.file + '.7coder-tmp-')) f.clock.now = 200; return result; };
    f.c.fs.renameSync = (a, b) => { const result = rename(a, b); if (phase === 'previous-published' && b === f.previous) f.clock.now = 200; return result; };
    assert.throws(() => f.write('NEW'), cancelled);
    const saved = ['create', 'previous-write'].includes(phase) ? 'OLDER' : 'OLD';
    check('cancel at ' + phase + ' keeps primary and valid previous, closes fd and removes owned staging', same(f.file, 'OLD') && same(f.previous, saved) && f.fds.size === 0 && f.noTemp());
  }
  f = fixture('quarantine-cancel', '{bad'); fs.writeFileSync(f.previous, '"VALID_PREVIOUS"'); const evidenceWrite = f.c.fs.writeFileSync;
  f.c.fs.writeFileSync = (fd, bytes, ...rest) => { const result = evidenceWrite(fd, bytes, ...rest); if ((f.fds.get(fd) || '').includes('.7coder-corrupt-')) f.clock.now = 200; return result; };
  assert.throws(() => f.read(f.c.parseStateJson), cancelled);
  check('cancel during evidence staging prevents quarantine publication and recovery overwrite', same(f.file, '{bad') && same(f.previous, '"VALID_PREVIOUS"') && f.artifacts().length === 2 && f.fds.size === 0);
  f = fixture('restore-cancel', '{bad'); fs.writeFileSync(f.previous, '"VALID_PREVIOUS"'); const restoreWrite = f.c.fs.writeFileSync;
  f.c.fs.writeFileSync = (fd, bytes, ...rest) => { const result = restoreWrite(fd, bytes, ...rest); if ((f.fds.get(fd) || '').startsWith(f.file + '.7coder-tmp-')) f.clock.now = 200; return result; };
  assert.throws(() => f.read(f.c.parseStateJson), cancelled);
  check('cancel before recovery commit preserves corrupt original and already completed evidence', same(f.file, '{bad') && same(f.previous, '"VALID_PREVIOUS"') && f.artifacts().filter(file => file.includes('.7coder-corrupt-')).length === 1 && f.noTemp() && f.fds.size === 0);
  f = fixture('expected-snapshot'); assert.throws(() => f.c.writeStateFile(f.file, 'NEW', f.c.parseStateText, Buffer.from('STALE'), f.token), /changed before commit/);
  check('new optional control preserves expectedCurrent mismatch guard', same(f.file, 'OLD') && same(f.previous, 'OLDER') && f.noTemp());
  f = fixture('controlled-success'); f.write('NEW');
  check('live control still publishes exact data and the original complete previous version', same(f.file, 'NEW') && same(f.previous, 'OLD') && f.noTemp());

  for (const empty of [false, true]) {
    f = fixture('brief-scan-' + empty); const dir = path.join(f.cwd, 'src'); fs.mkdirSync(dir); if (!empty) fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const scan = f.c.fs.opendirSync; f.c.fs.opendirSync = file => { const d = scan(file); return { readSync: () => d.readSync(), closeSync() { d.closeSync(); f.clock.now = 200; } }; };
    const result = await f.c.brief({ folder: 'src' }, f.token);
    check('brief native scan close expiry leaves no published summary (' + (empty ? 'empty' : 'nonempty') + ')', result.status === 'cancelled' && !fs.existsSync(path.join(f.cwd, '.7coder', 'summaries', 'src.summary')) && f.counters.closedDirs === f.counters.dirs && f.noTemp());
  }
  f = fixture('brief-precancel'); f.clock.now = 200;
  check('pre-cancelled brief neither scans nor creates summary files', (await f.c.brief({ folder: 'src' }, f.token)).status === 'cancelled' && f.counters.dirs === 0 && f.counters.opens === 0 && f.artifacts().length === 2);
  f = fixture('brief-write-expiry'); fs.mkdirSync(path.join(f.cwd, 'src')); const briefWrite = f.c.fs.writeFileSync;
  f.c.fs.writeFileSync = (fd, bytes, ...rest) => { const result = briefWrite(fd, bytes, ...rest); if ((f.fds.get(fd) || '').includes('src.summary.7coder-tmp-')) f.clock.now = 200; return result; };
  check('brief expiry after staging write cannot publish a new summary', (await f.c.brief({ folder: 'src' }, f.token)).status === 'cancelled' && !fs.existsSync(path.join(f.cwd, '.7coder', 'summaries', 'src.summary')) && f.noTemp() && f.fds.size === 0);
  f = fixture('brief-invalid'); const invalid = await f.c.brief({ folder: '../' }, f.token);
  check('ordinary path failure remains error rather than cancellation', invalid.status === 'error' && invalid.text.includes('Brief error'));

  server = http.createServer((req, res) => { const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), done = body.messages.some(m => m.role === 'tool');
    const delta = done ? { content: 'BRIEF_CONTROL_OK' } : { tool_calls: [{ index: 0, id: 'brief-controlled', type: 'function', function: { name: 'brief_tool', arguments: '{"folder":"src"}' } }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
  }); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cwd = S.freshCwd('actual-agent'); fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src', '中文 file.txt'), 'data');
  H = create({ suite: 'state-cancel-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: '', model: 'fixture', permissionMode: 'bypass' }); await H.start(cwd);
  const chat = await H.chat([{ role: 'user', content: 'create brief with live execution control' }], 5000), info = JSON.parse((await H.api('/api/info')).body);
  check('actual Agent completes controlled brief and records exact tool identity/status', chat.content === 'BRIEF_CONTROL_OK' && chat.tools.filter(t => t.type === 'result').length === 1 && chat.tools.some(t => t.type === 'result' && t.callId === 'brief-controlled' && t.status === 'completed') && fs.readFileSync(path.join(cwd, '.7coder', 'summaries', 'src.summary'), 'utf8').includes('中文 file.txt') && S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).some(row => row.callId === 'brief-controlled' && row.status === 'ok'));
  check('normal controlled publication leaves core task and tool counters idle', info.runtime.activeTasks === 0 && info.runtime.activeTools === 0);
  console.log('STATE/CANCELLATION ' + checks + '/' + checks + '; SKIP 0');
} finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
