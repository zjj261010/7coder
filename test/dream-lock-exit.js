const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'dream-lock-exit' });
const source = fs.readFileSync(S.IDX, 'utf8'), a = source.indexOf('function releaseOwnedDreamLock('), b = source.indexOf('async function triggerDreamIfNeeded(', a);
assert.ok(a >= 0 && b > a); let checks = 0; const children = new Set(), servers = new Set(), sockets = new Set();
const deadline = setTimeout(() => { console.error('DREAM/LOCK/EXIT deadline'); for (const c of children) c.kill(); S.cleanup(); process.exit(1); }, 40000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function unit(name, overrides) { const cwd = S.freshCwd(name), root = path.join(cwd, '.7coder'); fs.mkdirSync(root); const warnings = [];
  const c = loadContext(source, cwd, overrides, { Buffer, appDir: path.dirname(S.IDX), triggerDreamIfNeeded: function () {}, console: { warn: s => warnings.push(s) } });
  vm.runInContext(source.slice(a, b), c); return { c, cwd, lock: path.join(root, 'dream.lock'), warnings }; }
async function until(predicate, label) { const limit = Date.now() + 6000; while (!predicate()) { if (Date.now() > limit) throw Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 10)); } }
async function launch(cwd, dream) {
  let calls = 0, closedRequests = 0, output = '', closed = false, code = null;
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { calls++; res.once('close', () => { closedRequests++; }); }); }); servers.add(server);
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_API_KEY: 'fixture', OPENAI_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/v1',
    HEAVY_MODEL: 'fixture', LIGHT_MODEL: 'fixture', SUMMARY_MODEL: 'fixture', MAX_RETRIES: '1', DREAM_ALLOW: dream ? 'true' : 'false', ENABLE_RALPH_MODE: 'false', ENABLE_HTTP_SERVER: 'false', PERMISSION_MODE: 'bypass' }) }); children.add(child);
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d); child.stdin.on('error', () => {}); child.once('close', value => { code = value; closed = true; children.delete(child); });
  await until(() => { if (closed) throw Error('early exit: ' + output); return output.includes('Commands:'); }, 'REPL ready');
  return { child, calls: () => calls, closedRequests: () => closedRequests, output: () => output,
    async bye() { child.stdin.write('/bye\n'); await until(() => closed, '/bye close'); check('actual REPL exits cleanly after /bye', code === 0 && output.includes('Goodbye!') && !/UnhandledPromiseRejection|\[REPL\]/.test(output)); } };
}
(async () => { try {
  let reads = 0, f = unit('no-owner', { openSync(...args) { reads++; return fs.openSync(...args); } }); fs.writeFileSync(f.lock, 'FOREIGN');
  check('no active owner performs no lock read or deletion', f.c.releaseOwnedDreamLock() === false && reads === 0 && fs.readFileSync(f.lock, 'utf8') === 'FOREIGN');
  f.c.triggerDreamIfNeeded.owner = 'OWNED'; fs.writeFileSync(f.lock, 'OWNED');
  check('exact active owner releases only matching bytes', f.c.releaseOwnedDreamLock() === true && !fs.existsSync(f.lock) && f.c.triggerDreamIfNeeded.owner === 'OWNED');
  check('already released owner cleanup is harmless', f.c.releaseOwnedDreamLock() === false && f.warnings.length === 0);
  fs.writeFileSync(f.lock, 'FOREIGN'); check('replacement owner is preserved even when current owner is set', f.c.releaseOwnedDreamLock() === false && fs.readFileSync(f.lock, 'utf8') === 'FOREIGN');
  fs.writeFileSync(f.lock, 'CAPTURED'); f.c.triggerDreamIfNeeded.owner = 'NEW_OWNER';
  check('finally uses captured owner rather than a later owner value', f.c.releaseOwnedDreamLock('CAPTURED') === true && f.c.triggerDreamIfNeeded.owner === 'NEW_OWNER');
  f = unit('occupied', { unlinkSync() { throw Object.assign(Error('occupied lock'), { code: 'EACCES' }); } }); fs.writeFileSync(f.lock, 'OWNED');
  check('failed owned deletion warns and retains lock', f.c.releaseOwnedDreamLock('OWNED') === false && fs.readFileSync(f.lock, 'utf8') === 'OWNED' && f.warnings.some(s => s.includes('occupied lock')));
  f = unit('huge'); const fd = fs.openSync(f.lock, 'w'); fs.ftruncateSync(fd, 100 * 1024 * 1024); fs.closeSync(fd);
  check('oversized replacement is refused in place with a diagnostic', f.c.releaseOwnedDreamLock('OWNED') === false && fs.statSync(f.lock).size === 100 * 1024 * 1024 && f.warnings.some(s => s.includes('4096')));
  const passive = S.freshCwd('passive'), root = path.join(passive, '.7coder'); fs.mkdirSync(root); const lock = path.join(root, 'dream.lock'), legacy = path.join(passive, '7C.dream.lock');
  let app = await launch(passive, false); fs.writeFileSync(lock, 'FOREIGN_MODERN'); fs.writeFileSync(legacy, 'FOREIGN_LEGACY'); await app.bye();
  check('actual /bye preserves modern and legacy-root unowned locks', app.calls() === 0 && fs.readFileSync(lock, 'utf8') === 'FOREIGN_MODERN' && fs.readFileSync(legacy, 'utf8') === 'FOREIGN_LEGACY');
  app = await launch(passive, false); await app.bye();
  check('second disabled-Dream startup/exit still retains both locks without a model call', app.calls() === 0 && fs.readFileSync(lock, 'utf8') === 'FOREIGN_MODERN' && fs.readFileSync(legacy, 'utf8') === 'FOREIGN_LEGACY');
  for (const replace of [false, true]) {
    const cwd = S.freshCwd(replace ? 'active-foreign' : 'active-owned'), note = path.join(cwd, '7CODER.md'), ownedLock = path.join(cwd, '.7coder', 'dream.lock'), oldLock = path.join(cwd, '7C.dream.lock');
    fs.writeFileSync(note, 'PRESERVE_NOTES'); app = await launch(cwd, true); app.child.stdin.write('MUST_NOT_START\n/execute-task-now\n'); await until(() => app.calls() === 1, 'active Dream request');
    assert.strictEqual(JSON.parse(fs.readFileSync(ownedLock, 'utf8')).kind, '7coder-dream-owner-v1');
    if (replace) { fs.writeFileSync(ownedLock, 'FOREIGN_REPLACEMENT'); fs.writeFileSync(oldLock, 'FOREIGN_ROOT'); }
    await app.bye(); await until(() => app.closedRequests() === 1, 'upstream aborted');
    check('actual active Dream cancellation ' + (replace ? 'preserves foreign replacements' : 'cleans its owned lock'), app.calls() === 1 && fs.readFileSync(note, 'utf8') === 'PRESERVE_NOTES' &&
      (replace ? fs.readFileSync(ownedLock, 'utf8') === 'FOREIGN_REPLACEMENT' && fs.readFileSync(oldLock, 'utf8') === 'FOREIGN_ROOT' : !fs.existsSync(ownedLock)));
    check('cancelled Dream does not record successful maintenance', !fs.existsSync(path.join(cwd, '.7coder', 'last_interaction')));
  }
  console.log('DREAM/LOCK/EXIT ' + checks + '/' + checks + ' passed; SKIP 0');
} finally { clearTimeout(deadline); for (const child of children) child.kill(); for (const socket of sockets) socket.destroy(); for (const server of servers) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
