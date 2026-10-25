const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'auxiliary-budget' });
const source = fs.readFileSync(S.IDX, 'utf8'), contexts = [], sockets = new Set(); let checks = 0, server;
const deadline = setTimeout(() => { console.error('AUXILIARY/BUDGET deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function sparse(file, size) { const fd = fs.openSync(file, 'w'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } }
function fixture(name) {
  const cwd = S.freshCwd(name), root = path.join(cwd, '.7coder'); fs.mkdirSync(root); const warnings = [], opens = new Map(), bytes = new Map(); let calls = 0;
  const c = loadContext(source, cwd, { openSync(file, flags, mode) { const fd = fs.openSync(file, flags, mode); opens.set(fd, file); return fd; }, closeSync(fd) { fs.closeSync(fd); opens.delete(fd); },
    readSync(...args) { const n = fs.readSync(...args), file = opens.get(args[0]); bytes.set(file, (bytes.get(file) || 0) + n); return n; } },
    { Buffer, appDir: path.dirname(S.IDX), DREAM_ALLOW: true, shuttingDown: false, systemPrompt: 'fixture', listMemoryTopics: () => [], getRandomSpinner: () => 'fixture',
      console: { log() {}, warn: text => warnings.push(text), error: text => warnings.push(text) }, processWithTools: async () => { calls++; return 'done'; }, messages: [] });
  vm.runInContext(cut('function getLastInteractionTime()', '// ====================== VISION HELPER') + cut('function sessionFilePath()', 'async function summarizeAction('), c); contexts.push(c);
  return { c, cwd, root, warnings, opens, bytes, calls: () => calls, time: path.join(root, 'last_interaction'), lock: path.join(root, 'dream.lock') };
}
function seedHistory(f) {
  const dir = path.join(f.root, 'sessions'); fs.mkdirSync(dir); const names = [];
  for (let i = 0; i < 21; i++) { const savedAt = new Date(1700000000000 + i * 1000).toISOString(), name = 'cli-' + savedAt.replace(/[:.]/g, '-') + '-' + i.toString(16).padStart(8, '0') + '.json'; fs.writeFileSync(path.join(dir, name), JSON.stringify({ kind: '7coder-cli-session-v1', savedAt, messages: [{ role: 'user', content: 'owned' }] })); names.push(name); }
  return { dir, names, oldest: path.join(dir, names[0]) };
}
(async () => {
  try {
    let f = fixture('disabled'); f.c.DREAM_ALLOW = false; sparse(f.time, 100 * 1024 * 1024); sparse(f.lock, 100 * 1024 * 1024);
    check('disabled Dream reads neither huge timestamp nor lock and never calls model', await f.c.triggerDreamIfNeeded(null) === false && f.bytes.size === 0 && f.calls() === 0 && f.opens.size === 0 && f.c.triggerDreamIfNeeded.lastOutcome === 'skipped');
    f.c.DREAM_ALLOW = true; const token = f.c.createExecutionControl(5000); token.cancel('already cancelled'); await assert.rejects(f.c.triggerDreamIfNeeded(null, token), e => e.code === 'EXECUTION_CANCELLED'); token.dispose();
    check('already cancelled Dream performs no timestamp/lock collection', f.bytes.size === 0 && f.calls() === 0 && f.opens.size === 0);
    f = fixture('new-layout'); check('both missing timestamp layouts retain initial idle behavior', f.c.getLastInteractionTime() === 0);
    fs.writeFileSync(path.join(f.cwd, '.7coder_last_interaction'), '\uFEFF001234\r\n'); check('missing primary may read a bounded valid BOM legacy timestamp', f.c.getLastInteractionTime() === 1234);
    fs.writeFileSync(f.time, '12junk'); const before = Date.now(), deferred = f.c.getLastInteractionTime();
    check('invalid existing primary defers Dream instead of using stale legacy timestamp', deferred >= before && deferred <= Date.now() && f.warnings.some(s => s.includes('automatic dream deferred')) && fs.readFileSync(f.time, 'utf8') === '12junk');
    for (const value of ['', '-1', '1.2', '9007199254740992', Buffer.from([0xD6, 0xD0])]) { fs.writeFileSync(f.time, value); const now = Date.now(), valueTime = f.c.getLastInteractionTime(); assert.ok(valueTime >= now && valueTime <= Date.now()); }
    check('empty/negative/fractional/unsafe/legacy-encoded timestamps never fabricate idle history', f.calls() === 0);
    f = fixture('oversized-time'); sparse(f.time, 100 * 1024 * 1024); fs.writeFileSync(path.join(f.cwd, '.7coder_last_interaction'), '0');
    check('oversized timestamp stops before data read and does not trigger Dream or read legacy', await f.c.triggerDreamIfNeeded(null) === false && !f.bytes.has(f.time) && !f.bytes.has(path.join(f.cwd, '.7coder_last_interaction')) && f.calls() === 0 && !fs.existsSync(f.lock) && fs.statSync(f.time).size === 100 * 1024 * 1024);
    f = fixture('fresh-large-lock'); fs.writeFileSync(f.time, '0'); sparse(f.lock, 100 * 1024 * 1024);
    check('fresh oversized lock preserves grace period without collecting lock bytes', await f.c.triggerDreamIfNeeded(null) === false && !f.bytes.has(f.lock) && f.calls() === 0 && fs.statSync(f.lock).size === 100 * 1024 * 1024 && f.opens.size === 0);
    f = fixture('recognized-boundary'); fs.writeFileSync(f.time, '0'); fs.writeFileSync(path.join(f.cwd, '7CODER.md'), 'SOURCE_NOTES'); const owner = JSON.stringify({ kind: '7coder-dream-owner-v1', nonce: 'previous' }); fs.writeFileSync(f.lock, owner + ' '.repeat(4096 - Buffer.byteLength(owner)));
    await f.c.triggerDreamIfNeeded(null); check('exact 4KiB recognized owner lock recovers and normal cleanup records time', f.calls() === 1 && !fs.existsSync(f.lock) && Number(fs.readFileSync(f.time, 'utf8')) > 0 && f.opens.size === 0 && f.c.createExecutionControl.active.size === 0);
    f = fixture('changed-lock'); fs.writeFileSync(f.time, '0'); const changed = f; f.c.processWithTools = async () => { sparse(changed.lock, 100 * 1024 * 1024); return 'done'; }; await f.c.triggerDreamIfNeeded(null);
    check('finally cannot fully read or delete a lock replaced by a huge foreign file', fs.statSync(f.lock).size === 100 * 1024 * 1024 && !f.bytes.has(f.lock) && f.warnings.some(s => s.includes('dream lock cleanup failed')) && !f.c.triggerDreamIfNeeded.owner && f.opens.size === 0 && f.c.createExecutionControl.active.size === 0);
    f = fixture('unavailable-notes'); fs.writeFileSync(f.time, '0'); const md = path.join(f.cwd, '7CODER.md'); sparse(md, 100 * 1024 * 1024); await f.c.triggerDreamIfNeeded(null);
    check('unavailable Dream source is failed maintenance without model call/reset/success timestamp', f.calls() === 0 && f.c.triggerDreamIfNeeded.lastOutcome === 'failed' && f.warnings.some(s => s.includes('source notes unavailable')) && fs.readFileSync(f.time, 'utf8') === '0' && fs.statSync(md).size === 100 * 1024 * 1024 && !fs.existsSync(f.lock) && f.opens.size === 0);
    f = fixture('legacy-btw'); const old = path.join(f.cwd, 'BTW.md'), target = path.join(f.root, 'BTW.md'); fs.writeFileSync(target, 'EXISTING'); sparse(old, 100 * 1024 * 1024); f.c.migrateWorkspaceRootFiles();
    check('oversized legacy notes remain in place with migration warning and unchanged current notes', fs.statSync(old).size === 100 * 1024 * 1024 && fs.readFileSync(target, 'utf8') === 'EXISTING' && !f.bytes.has(old) && f.warnings.some(s => s.includes('BTW migration left original in place')));
    fs.writeFileSync(old, 'x'.repeat(8 * 1024 * 1024)); f.c.migrateWorkspaceRootFiles(); check('combined BTW state overflow does not delete source or replace current notes', fs.existsSync(old) && fs.readFileSync(target, 'utf8') === 'EXISTING' && !fs.existsSync(target + '.7coder-prev'));
    fs.writeFileSync(old, '中文😀'); f.c.migrateWorkspaceRootFiles(); check('ordinary legacy migration preserves exact text and previous target before deleting legacy', !fs.existsSync(old) && fs.readFileSync(target, 'utf8') === 'EXISTING中文😀' && fs.readFileSync(target + '.7coder-prev', 'utf8') === 'EXISTING');
    for (const phase of [1, 2]) {
      f = fixture('archive-growth-' + phase); const history = seedHistory(f); let opens = 0; const original = f.c.fs.openSync;
      f.c.fs.openSync = (file, flags, mode) => { if (file === history.oldest && flags === 'r' && ++opens === phase) sparse(file, 100 * 1024 * 1024); return original(file, flags, mode); };
      if (phase === 1) f.c.pruneCliSessionHistory(history.names[20]); else assert.throws(() => f.c.pruneCliSessionHistory(history.names[20]), e => e.code === 'EFILETOOLARGE');
      check('archive growth at read ' + phase + ' preserves all archives without full large read or quarantine', fs.readdirSync(history.dir).length === 21 && fs.statSync(history.oldest).size === 100 * 1024 * 1024 && (f.bytes.get(history.oldest) || 0) < 2048 && f.opens.size === 0);
    }
    let modelCalls = 0; server = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { modelCalls++; const body = JSON.parse(raw); if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'AUX_BUDGET_TASK_OK' } }] }) + '\n\ndata: [DONE]\n\n'); } else res.end(JSON.stringify({ choices: [{ message: { content: 'AUX_BUDGET_TASK_OK' } }] })); }); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    f = fixture('actual-cli-disabled'); sparse(f.time, 100 * 1024 * 1024); sparse(f.lock, 100 * 1024 * 1024);
    const actual = await S.runCli({ port: server.address().port, args: ['--prompt', 'normal task'], cwd: f.cwd, env: { DREAM_ALLOW: 'false', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1' }, timeoutMs: 8000 });
    check('actual CLI completes one model task with huge disabled-Dream metadata intact', actual.code === 0 && actual.out.includes('AUX_BUDGET_TASK_OK') && modelCalls === 1 && fs.statSync(f.time).size === 100 * 1024 * 1024 && fs.statSync(f.lock).size === 100 * 1024 * 1024 && actual.out.includes('last interaction save failed'));
    console.log('AUXILIARY/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally { clearTimeout(deadline); for (const c of contexts) { c.cancelActiveExecutions('cleanup'); for (const token of Array.from(c.createExecutionControl.active || [])) token.dispose(); } S.cleanup(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
