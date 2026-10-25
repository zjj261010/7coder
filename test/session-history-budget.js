// CLI retention only: bounded discovery, shared IO budget and safe deferral.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'session-history-budget' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set();
let checks = 0, server;
const deadline = setTimeout(() => { console.error('SESSION/HISTORY-BUDGET deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function context(cwd, overrides, extra) {
  const warnings = [], descriptors = new Map(), io = { bytes: 0, reads: 0, dirs: 0, closedDirs: 0 };
  const hooks = Object.assign({
    readdirSync() { throw Error('whole history directory collection is forbidden'); },
    readFileSync() { throw Error('whole archive read is forbidden'); },
    openSync(file, flags, mode) { const fd = fs.openSync(file, flags, mode); descriptors.set(fd, file); return fd; },
    closeSync(fd) { try { fs.closeSync(fd); } finally { descriptors.delete(fd); } },
    readSync(fd, buffer, offset, length, position) { const count = fs.readSync(fd, buffer, offset, length, position); io.bytes += count; io.reads++; return count; },
    opendirSync(dir) {
      const handle = fs.opendirSync(dir); io.dirs++;
      return { readSync: () => handle.readSync(), closeSync() { try { handle.closeSync(); } finally { io.closedDirs++; } } };
    }
  }, overrides);
  const ctx = loadContext(source, cwd, hooks, Object.assign({ Buffer, require, appDir: path.dirname(S.IDX), messages: [], console: { warn: text => warnings.push(text) } }, extra));
  const start = source.indexOf('function sessionFilePath()'), end = source.indexOf('async function summarizeAction(', start);
  assert(start >= 0 && end > start); vm.runInContext(source.slice(start, end), ctx);
  return { ctx, warnings, descriptors, io };
}
function seed(name, count = 21) {
  const cwd = S.freshCwd(name), dir = path.join(cwd, '.7coder', 'sessions'), names = [], original = new Map();
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const savedAt = new Date(1700000000000 + i * 1000).toISOString();
    const file = 'cli-' + savedAt.replace(/[:.]/g, '-') + '-' + i.toString(16).padStart(8, '0') + '.json';
    const bytes = Buffer.from(JSON.stringify({ kind: '7coder-cli-session-v1', savedAt, messages: [{ role: 'user', content: '中文 ' + i }] }));
    fs.writeFileSync(path.join(dir, file), bytes); names.push(file); original.set(file, bytes);
  }
  return { cwd, dir, names, original };
}
const intact = f => Array.from(f.original).every(([name, bytes]) => fs.existsSync(path.join(f.dir, name)) && fs.readFileSync(path.join(f.dir, name)).equals(bytes));
const totalBytes = f => Array.from(f.original.values()).reduce((sum, bytes) => sum + bytes.length, 0);
async function main() {
  try {
    if (process.env.SESSION_HISTORY_SCOPE !== 'integration') {
    let f = seed('normal'), c = context(f.cwd);
    const result = c.ctx.pruneCliSessionHistory(f.names[20]);
    check('complete bounded scan keeps twenty owned archives and closes all descriptors', result.status === 'complete' && result.removed === 1 && fs.readdirSync(f.dir).length === 20 && c.descriptors.size === 0 && c.io.dirs === c.io.closedDirs && c.io.bytes === result.readBytes);

    f = seed('entry-budget'); let visits = 0, closes = 0;
    c = context(f.cwd, { opendirSync() { return { readSync() { visits++; return { name: 'web-' + visits + '.json' }; }, closeSync() { closes++; } }; } });
    let outcome = c.ctx.pruneCliSessionHistory(f.names[20], { maxEntries: 3 });
    check('unmatched directory entries consume the budget and incomplete scans never delete', outcome.status === 'deferred' && /entry limit/.test(outcome.reason) && outcome.visited === 4 && visits === 4 && closes === 1 && c.io.reads === 0 && intact(f));

    f = seed('name-bytes'); visits = 0; closes = 0;
    c = context(f.cwd, { opendirSync() { return { readSync() { visits++; return { name: 'web-' + '中'.repeat(10) }; }, closeSync() { closes++; } }; } });
    outcome = c.ctx.pruneCliSessionHistory(f.names[20], { maxNameBytes: 8 });
    check('UTF8 directory-name budget stops collection before reading archives', outcome.status === 'deferred' && /name byte/.test(outcome.reason) && visits === 1 && closes === 1 && c.io.bytes === 0 && intact(f));

    f = seed('candidate-budget'); c = context(f.cwd);
    outcome = c.ctx.pruneCliSessionHistory(f.names[20], { maxCandidates: 2 });
    check('candidate limit bounds actual CLI-looking record inspection before any deletion', outcome.status === 'deferred' && /candidate limit/.test(outcome.reason) && outcome.checked === 2 && c.io.reads === 2 && c.descriptors.size === 0 && intact(f));

    f = seed('aggregate-bytes'); c = context(f.cwd);
    const allowance = 200;
    outcome = c.ctx.pruneCliSessionHistory(f.names[20], { maxReadBytes: allowance });
    check('shared byte budget applies to discovery reads and refuses the next file before reading it', outcome.status === 'deferred' && /aggregate archive byte/.test(outcome.reason) && outcome.readBytes === c.io.bytes && c.io.bytes > 0 && c.io.bytes <= allowance && c.descriptors.size === 0 && intact(f));

    f = seed('verification-budget'); c = context(f.cwd);
    outcome = c.ctx.pruneCliSessionHistory(f.names[20], { maxReadBytes: totalBytes(f) });
    check('pre-delete verification consumes the same budget and cannot bypass it', outcome.status === 'deferred' && outcome.checked === 21 && outcome.removed === 0 && c.io.bytes === totalBytes(f) && c.descriptors.size === 0 && intact(f));

    f = seed('deadline'); let clock = Date.now(), reads = 0;
    c = context(f.cwd, { readSync(fd, buffer, offset, length, position) { const n = fs.readSync(fd, buffer, offset, length, position); reads++; clock += 6000; return n; } }, { Date: class extends Date { static now() { return clock; } } });
    outcome = c.ctx.pruneCliSessionHistory(f.names[20]);
    check('deadline after a native read prevents later reads and deletion with all handles closed', outcome.status === 'deferred' && /deadline/.test(outcome.reason) && reads === 1 && c.descriptors.size === 0 && c.io.dirs === c.io.closedDirs && intact(f));

    f = seed('pre-cancel'); c = context(f.cwd); const preCancelled = () => true; preCancelled.reason = 'retention cancelled';
    outcome = c.ctx.pruneCliSessionHistory(f.names[20], { cancelled: preCancelled });
    check('pre-cancelled maintenance performs no directory/data collection or deletion', outcome.status === 'deferred' && /cancelled/.test(outcome.reason) && c.io.dirs === 0 && c.io.bytes === 0 && intact(f));

    f = seed('cancel-read'); let cancelled = false; const token = () => cancelled; token.reason = 'cancelled during archive read';
    c = context(f.cwd, { readSync(fd, buffer, offset, length, position) { const n = fs.readSync(fd, buffer, offset, length, position); cancelled = true; return n; } });
    outcome = c.ctx.pruneCliSessionHistory(f.names[20], { cancelled: token });
    check('cancellation after the final read defers maintenance and preserves all archives', cancelled && outcome.status === 'deferred' && c.descriptors.size === 0 && intact(f));

    f = seed('invalid-bytes', 3); for (const name of f.names) fs.writeFileSync(path.join(f.dir, name), '{}'); c = context(f.cwd);
    outcome = c.ctx.pruneCliSessionHistory(f.names[2], { maxReadBytes: 4 });
    check('unowned or malformed payload reads still consume the shared budget', outcome.status === 'deferred' && c.io.bytes === 4 && outcome.readBytes === 4 && c.descriptors.size === 0 && fs.readdirSync(f.dir).length === 3);

    f = seed('directory-EIO'); visits = 0; closes = 0;
    c = context(f.cwd, { opendirSync() { return { readSync() { if (++visits === 3) throw Object.assign(Error('directory EIO'), { code: 'EIO' }); return { name: f.names[visits - 1] }; }, closeSync() { closes++; } }; } });
    assert.throws(() => c.ctx.pruneCliSessionHistory(f.names[20]), e => e.code === 'EIO');
    check('directory IO failure closes its handle and cannot delete a partial selection', visits === 3 && closes === 1 && c.io.bytes === 0 && intact(f));

    f = seed('growth'); const grownFile = path.join(f.dir, f.names[0]); let grown = false, bytesRead = 0;
    c = context(f.cwd, { readSync(fd, buffer, offset, length, position) {
      if (!grown) { grown = true; fs.appendFileSync(grownFile, Buffer.alloc(3 * 1024 * 1024)); }
      const n = fs.readSync(fd, buffer, offset, length, position); bytesRead += n; return n;
    } });
    outcome = c.ctx.pruneCliSessionHistory(f.names[20]);
    check('growth after fstat reads only the recorded extent and preserves the changed source', grown && fs.statSync(grownFile).size > 2 * 1024 * 1024 && bytesRead === totalBytes(f) && outcome.unreadable === 1 && outcome.removed === 0 && c.descriptors.size === 0 && fs.readdirSync(f.dir).length === 21);

    f = seed('hardlink'); const linked = path.join(f.dir, f.names[0]); fs.linkSync(linked, path.join(f.cwd, 'alias')); c = context(f.cwd);
    outcome = c.ctx.pruneCliSessionHistory(f.names[20]);
    check('shared hard-linked CLI-looking files are preserved without being counted as owned', outcome.status === 'complete' && outcome.unreadable === 1 && outcome.removed === 0 && intact(f));

    f = seed('current-clock-rollback', 22); c = context(f.cwd);
    outcome = c.ctx.pruneCliSessionHistory(f.names[0]);
    check('current save survives clock rollback while other oldest owned records are pruned', outcome.removed === 2 && fs.readdirSync(f.dir).length === 20 && fs.existsSync(path.join(f.dir, f.names[0])) && !fs.existsSync(path.join(f.dir, f.names[1])) && !fs.existsSync(path.join(f.dir, f.names[2])));

    if (process.platform === 'win32') {
      f = seed('root-swap'); const history = f, oldest = path.join(f.dir, f.names[0]), outside = S.freshCwd('history-outside'), moved = path.join(outside, 'moved');
      let opens = 0, swapped = false;
      c = context(f.cwd, { openSync(file, flags) {
        if (file === oldest && ++opens === 2) { fs.renameSync(history.dir, moved); fs.symlinkSync(moved, history.dir, 'junction'); swapped = true; }
        const fd = fs.openSync(file, flags); c.descriptors.set(fd, file); return fd;
      } });
      try {
        assert.throws(() => c.ctx.pruneCliSessionHistory(f.names[20]), /outside|changed/);
        check('directory replacement during pre-delete verification preserves all external owned records', swapped && fs.readdirSync(moved).length === 21 && Array.from(f.original).every(([name, bytes]) => fs.readFileSync(path.join(moved, name)).equals(bytes)) && c.descriptors.size === 0);
      } finally { if (swapped) fs.rmdirSync(f.dir); }
    }

    }
    let calls = 0;
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        try {
          const request = JSON.parse(raw); assert.strictEqual(request.stream, true); calls++;
          res.setHeader('Content-Type', 'text/event-stream');
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'HISTORY_BUDGET_TASK_OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        } catch (error) { res.statusCode = 500; res.end(error.message); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const realCwd = S.freshCwd('real-cli'), realDir = path.join(realCwd, '.7coder', 'sessions'); fs.mkdirSync(realDir, { recursive: true });
    for (let i = 0; i < 4100; i++) fs.writeFileSync(path.join(realDir, 'web-' + i + '.json'), 'UNTOUCHED');
    // --prompt is intentionally one-shot and does not call saveSession.
    // Drive the actual persistence path, then /bye and observe direct close.
    const run = () => new Promise((resolve, reject) => {
      const child = S.spawn(S.NODE_BIN, [S.IDX], { cwd: realCwd,
        env: Object.assign({}, process.env, { OPENAI_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/v1', OPENAI_API_KEY: 'fixture', DREAM_ALLOW: 'false', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1' }) });
      let out = '', phase = 0, error = null;
      const timer = setTimeout(() => { error = Error('REPL history fixture timeout: ' + out.slice(-3000)); child.kill(); }, 10000);
      function collect(data) {
        out += data.toString();
        if (phase === 0 && out.includes('Commands:')) { phase = 1; child.stdin.write('history budget task\n/execute-task-now\n'); }
        if (phase === 1 && out.includes('HISTORY_BUDGET_TASK_OK') && fs.existsSync(path.join(realCwd, '.7coder', 'session.json'))) {
          phase = 2; child.stdin.end('/bye\n');
        }
      }
      child.stdout.on('data', collect); child.stderr.on('data', collect); child.stdin.on('error', () => {});
      child.on('error', e => { error = e; });
      child.once('close', code => { clearTimeout(timer); if (error) reject(error); else resolve({ code, out }); });
    });
    let actual = await run();
    assert(actual.code === 0 && actual.out.includes('HISTORY_BUDGET_TASK_OK'), 'REPL task failed: ' + actual.out.slice(-3000));
    const primary = JSON.parse(fs.readFileSync(path.join(realCwd, '.7coder', 'session.json'), 'utf8'));
    check('actual REPL completes and saves the primary despite an overfull foreign history directory', actual.code === 0 && actual.out.includes('Goodbye!') && actual.out.includes('CLI history cleanup deferred: entry limit 4096') && calls === 1 && primary.messages.some(m => m.content === 'HISTORY_BUDGET_TASK_OK') && fs.readdirSync(realDir).length === 4102 && fs.readFileSync(path.join(realDir, 'web-0.json'), 'utf8') === 'UNTOUCHED');
    for (let i = 2; i < 4100; i++) fs.unlinkSync(path.join(realDir, 'web-' + i + '.json'));
    actual = await run();
    check('after explicitly reducing private foreign history the next REPL task resumes normal retention', actual.code === 0 && actual.out.includes('Goodbye!') && calls === 2 && !actual.out.includes('CLI history cleanup deferred') && fs.readdirSync(realDir).filter(n => n.startsWith('cli-')).length === 4 && fs.readFileSync(path.join(realDir, 'web-1.json'), 'utf8') === 'UNTOUCHED');
    console.log('SESSION/HISTORY-BUDGET ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline); for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve)); S.cleanup();
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
