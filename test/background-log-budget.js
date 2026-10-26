const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), crypto = require('crypto');
const { StringDecoder } = require('string_decoder'), { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'background-log-budget' }), source = fs.readFileSync(S.IDX, 'utf8'), writers = [], sockets = new Set();
let checks = 0, server;
const bootstrapOnly = process.env.BACKGROUND_LOG_SCOPE === 'bootstrap';
const deadline = setTimeout(() => { console.error('BACKGROUND/LOG deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok, detail) { assert.ok(ok, label + (detail ? '\n' + detail : '')); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
async function until(predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() >= end) throw Error('background fixture condition deadline'); await new Promise(r => setTimeout(r, 10)); } }
const tick = () => new Promise(r => setImmediate(r));
function context(name, options = {}) {
  const cwd = S.freshCwd(name), fds = new Set();
  const c = loadContext(source, cwd, { openSync(...args) { const fd = fs.openSync(...args); fds.add(fd); return fd; }, closeSync(fd) { try { fs.closeSync(fd); } finally { fds.delete(fd); } } }, { StringDecoder, Uint8Array, process });
  vm.runInContext(cut('function appendDiagnosticRecord(', 'function audit(') + cut('function runtimeText(', 'function recordRuntimeEvent('), c);
  const writer = c.createBackgroundLogger(Object.assign({ limit: 4096, batchLimit: 256 }, options)); writers.push(writer);
  return { c, writer, cwd, fds, file: path.join(cwd, '.7coder', 'background.log'), old: path.join(cwd, '.7coder', 'background.old.log') };
}
(async () => { try {
  if (!bootstrapOnly) {
  let f = context('order'); const header = fs.readFileSync(f.file, 'utf8');
  f.writer.write('stdout', 'STDOUT_A'); f.writer.write('stderr', 'STDERR_B\n');
  check('stdout/stderr preserve call order in a single bounded pending buffer', fs.readFileSync(f.file, 'utf8') === header + 'STDOUT_ASTDERR_B\n' && f.writer.snapshot().pendingBytes === 0 && f.fds.size === 0);
  let called = 0; const returned = f.writer.write('stdout', 'callback', 'utf8', () => called++), asynchronous = called === 0; await tick();
  check('stream write accepts callback asynchronously without artificial backpressure', returned === true && asynchronous && called === 1 && f.writer.snapshot().pendingBytes <= 8);
  await until(() => f.writer.snapshot().pendingBytes === 0);
  check('unreferenced flush timer persists partial lines without waiting for a newline', fs.readFileSync(f.file, 'utf8').endsWith('callback') && f.fds.size === 0);
  const bytes = Buffer.from('中😀_BUFFER_END'); for (let i = 0; i < bytes.length; i++) f.writer.write('stdout', bytes.slice(i, i + 1));
  f.writer.write('stdout', '\n');
  check('fragmented buffer UTF8 survives decoder boundaries and partial-line appends', fs.readFileSync(f.file, 'utf8').endsWith('callback中😀_BUFFER_END\n') && !fs.readFileSync(f.file, 'utf8').includes('\uFFFD'));
  f = context('rotation', { limit: 1024, batchLimit: 128 });
  const long = '中文😀_'.repeat(3000) + 'FINAL_OUTPUT_TAIL\n'; f.writer.write('stdout', long); f.writer.flush();
  check('one large write streams through bounded batches and two bounded generations', fs.statSync(f.file).size <= 1024 && fs.statSync(f.old).size <= 1024 && fs.readFileSync(f.file, 'utf8').endsWith('FINAL_OUTPUT_TAIL\n') && f.writer.snapshot().writtenBytes === Buffer.byteLength(long) && f.writer.snapshot().droppedBytes === 0 && f.writer.snapshot().pendingBytes === 0 && f.fds.size === 0);
  check('rotation does not split UTF8 characters across retained file boundaries', !fs.readFileSync(f.file, 'utf8').includes('\uFFFD') && !fs.readFileSync(f.old, 'utf8').includes('\uFFFD'));
  f.writer.write('stderr', 'EXIT_PARTIAL'); f.writer.close(); f.writer.close();
  check('idempotent close flushes the final partial line and owns no fd', fs.readFileSync(f.file, 'utf8').endsWith('EXIT_PARTIAL') && f.writer.snapshot().pendingBytes === 0 && f.fds.size === 0);

  f = context('disk-failure'); const before = fs.readFileSync(f.file), write = f.c.fs.writeSync; let reports = 0;
  f.writer.setReporter(() => { reports++; f.writer.write('stderr', 'nested log warning\n'); });
  f.c.fs.writeSync = () => { throw Object.assign(Error('private ENOSPC secret=FAKE_SECRET'), { code: 'ENOSPC' }); };
  f.writer.write('stdout', 'first dropped\n'); f.writer.write('stderr', 'second dropped\n');
  check('disk failure drops bounded diagnostics, rate-limits reporter and prevents recursion', reports === 1 && f.writer.snapshot().droppedBytes > 0 && f.writer.snapshot().lastError.code === 'ENOSPC' && !JSON.stringify(f.writer.snapshot()).includes('FAKE_SECRET') && fs.readFileSync(f.file).equals(before) && f.writer.snapshot().pendingBytes === 0 && f.fds.size === 0);
  const snapshot = f.writer.snapshot(); snapshot.lastError.message = 'mutated';
  check('diagnostic snapshots cannot mutate the active background writer', f.writer.snapshot().lastError.message !== 'mutated');
  f.c.fs.writeSync = write; f.writer.write('stdout', 'RECOVERED\n');
  check('recovery emits explicit loss marker and clears current fault without resetting loss count', fs.readFileSync(f.file, 'utf8').includes('prior output dropped:') && fs.readFileSync(f.file, 'utf8').endsWith('RECOVERED\n') && f.writer.snapshot().lastError === null && f.writer.snapshot().droppedBytes > 0);
  f = context('rotation-denied', { limit: 256, batchLimit: 64 });
  f.writer.write('stdout', 'x'.repeat(120) + '\n'); const current = fs.readFileSync(f.file); fs.writeFileSync(f.old, 'PREVIOUS\n');
  f.c.fs.renameSync = () => { throw Object.assign(Error('private occupied archive'), { code: 'EACCES' }); };
  f.writer.write('stdout', 'y'.repeat(200) + '\n');
  check('failed background rotation preserves archive and refuses growth past file cap', fs.readFileSync(f.old, 'utf8') === 'PREVIOUS\n' && fs.statSync(f.file).size <= 256 && f.writer.snapshot().lastError && f.writer.snapshot().lastError.code === 'EACCES' && f.fds.size === 0);
  f = context('hardlink-after-start'); const moved = path.join(f.cwd, 'saved.log'); fs.renameSync(f.file, moved); const target = path.join(f.cwd, 'project-data.txt'); fs.writeFileSync(target, 'PROJECT_BYTES\n'); fs.linkSync(target, f.file);
  f.writer.write('stdout', 'must not reach alias\n');
  check('post-start log hardlink cannot redirect worker output into project data', fs.readFileSync(target, 'utf8') === 'PROJECT_BYTES\n' && f.writer.snapshot().lastError && f.fds.size === 0);
  f = context('oversized-existing'); f.writer.close(); const fd = fs.openSync(f.file, 'w'); fs.ftruncateSync(fd, 1024 * 1024 + 1); fs.closeSync(fd);
  assert.throws(() => f.c.createBackgroundLogger(), /exceeds 1 MiB/);
  check('oversized legacy log requires explicit archiving and remains unchanged', fs.statSync(f.file).size === 1024 * 1024 + 1);
  }

  let mainCalls = 0, summaryCalls = 0;
  const response = 'B'.repeat(2300000) + 'NATIVE_WORKER_FINAL_TAIL';
  server = http.createServer((req, res) => { const chunks = []; req.on('data', data => chunks.push(data)); req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), summary = String(body.messages[0].content).startsWith('Create a short, concise summary');
    if (summary) summaryCalls++; else mainCalls++;
    const content = summary ? 'NATIVE_BACKGROUND_SUMMARY' : response;
    if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); }
    else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  }); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { OPENAI_ENDPOINT: 'http://127.0.0.1:' + server.address().port, OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', LIGHT_MODEL: 'fixture', SUMMARY_MODEL: 'fixture',
    MAX_RETRIES: '1', PERMISSION_MODE: 'denial', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false' };
  if (!bootstrapOnly) {
  const cwd = S.freshCwd('owned-real-worker'), token = crypto.randomBytes(24).toString('hex');
  const worker = S.spawn(S.NODE_BIN, [S.IDX, '--prompt', 'native background fixture'], { cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, env,
    { _7CODER_LEASE_HANDOFF: JSON.stringify({ token, pid: process.pid }) }) });
  let acknowledged, bootstrap = ''; worker.on('message', message => { acknowledged = message; });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => { bootstrap = (bootstrap + data).slice(-4000); });
  const exitCode = await new Promise(resolve => worker.once('close', resolve));
  const file = path.join(cwd, '.7coder', 'background.log'), old = path.join(cwd, '.7coder', 'background.old.log');
  check('owned real worker acknowledges both workspace and installed logger', exitCode === 0 && acknowledged && acknowledged.kind === '7coder-background-owned' && acknowledged.handoffToken === token && acknowledged.owner.pid === worker.pid && acknowledged.logReady === true);
  check('real multi-MiB streamed reply rotates into bounded files and retains latest output tail', fs.statSync(file).size <= 1024 * 1024 && fs.statSync(old).size <= 1024 * 1024 && fs.readFileSync(file, 'utf8').includes('NATIVE_WORKER_FINAL_TAIL') && !bootstrap.includes('NATIVE_WORKER_FINAL_TAIL'));
  check('real worker completes task and action summary exactly once despite output rotation', mainCalls === 1 && summaryCalls === 1 && fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8').includes('NATIVE_BACKGROUND_SUMMARY'));

  const bad = S.freshCwd('blocked-parent'), badRoot = path.join(bad, '.7coder'); fs.mkdirSync(badRoot); const data = path.join(bad, 'data.txt'); fs.writeFileSync(data, 'UNCHANGED\n'); fs.linkSync(data, path.join(badRoot, 'background.log'));
  const refused = await S.runCli({ cwd: bad, port: server.address().port, args: ['--background', '--prompt', 'never launch'], timeoutMs: 8000, env });
  check('real launcher refuses aliased log before acceptance or model execution', refused.code === 1 && !refused.out.includes('Background worker accepted') && fs.readFileSync(data, 'utf8') === 'UNCHANGED\n' && mainCalls === 1);
  }

  // Only the owned install is altered to exercise a child failing before the
  // normal logger can load; restore it even if this negative control fails.
  const original = fs.readFileSync(S.IDX, 'utf8');
  const beforeBootstrap = mainCalls;
  try {
    // Drop the entire shebang line, including CRLF. Dot-star does not match
    // carriage returns, so /^#!.*\n/ accidentally retained a Windows shebang.
    fs.writeFileSync(S.IDX, `if(process.send&&process.env._7CODER_LEASE_HANDOFF){process.stderr.write('PRIVATE_BOOTSTRAP_START'+'z'.repeat(100000)+'PRIVATE_BOOTSTRAP_TAIL',()=>process.exit(23));}else{\n` + original.slice(original.indexOf(String.fromCharCode(10)) + 1) + '\n}');
    const failed = await S.runCli({ cwd: S.freshCwd('bootstrap-failure'), port: server.address().port, args: ['--background', '--prompt', 'bootstrap failure'], timeoutMs: 12000, env });
    check('real launcher drains oversized bootstrap stderr but reports a bounded useful tail', failed.code === 1 && failed.out.includes('exit 23') && failed.out.includes('PRIVATE_BOOTSTRAP_TAIL') && failed.out.length < 10000 && !failed.out.includes('Background worker accepted') && mainCalls === beforeBootstrap,
      JSON.stringify({ code: failed.code, length: failed.out.length, tail: failed.out.slice(-2500) }));
  } finally { fs.writeFileSync(S.IDX, original); }
  console.log('BACKGROUND/LOG ' + checks + '/' + checks + '; SKIP 0' + (bootstrapOnly ? '; failed bootstrap tail only; first 17 NOT RUN' : ''));
} finally { clearTimeout(deadline); for (const writer of writers) writer.close(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
