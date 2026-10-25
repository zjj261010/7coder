const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'btw-migration' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set(); let checks = 0, server;
const deadline = setTimeout(() => { console.error('BTW/MIGRATION deadline'); S.cleanup(); process.exit(1); }, 40000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const start = source.indexOf('function parseBtwMigrationState('), end = source.indexOf('function migrateWorkspaceRootFiles()', start), migration = source.slice(start, end); assert.ok(start >= 0 && end > start);
function context(cwd, overrides) { const c = loadContext(source, cwd, overrides, { Buffer, appDir: path.dirname(S.IDX), console: { log() {}, warn() {} } }); vm.runInContext(migration, c); return c; }
function fixture(name, before = 'TARGET\r\n', legacy = '\uFEFF旧笔记😀\n') { const cwd = S.freshCwd(name), root = path.join(cwd, '.7coder'); fs.mkdirSync(root); const f = { cwd, before, legacy, old: path.join(cwd, 'BTW.md'), target: path.join(root, 'BTW.md'), journal: path.join(root, 'btw-migration.json') }; if (before !== null) fs.writeFileSync(f.target, before); if (legacy !== null) fs.writeFileSync(f.old, legacy); return f; }
const same = (file, text) => fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(text));
const io = label => Object.assign(Error('injected ' + label), { code: 'EACCES' });
function complete(f) { return same(f.target, (f.before || '') + (f.legacy || '')) && !fs.existsSync(f.old) && !fs.existsSync(f.journal) && !fs.existsSync(f.journal + '.7coder-prev'); }
(async () => {
  try {
    let f = fixture('normal'), c = context(f.cwd); c.migrateLegacyBtw();
    check('normal migration preserves literal BOM/newlines/Unicode and complete prior target', complete(f) && same(f.target + '.7coder-prev', f.before));
    check('completed migration is a no-op on following startup', c.migrateLegacyBtw() === false && complete(f));
    f = fixture('empty-source', null, ''); context(f.cwd).migrateLegacyBtw(); check('empty source and missing target commit a valid empty note once', complete(f) && fs.statSync(f.target).size === 0);
    f = fixture('same-suffix', 'A', 'A'); context(f.cwd).migrateLegacyBtw(); fs.writeFileSync(f.old, 'A'); context(f.cwd).migrateLegacyBtw();
    check('new identical legacy input is not wrongly deduplicated by content suffix', same(f.target, 'AAA') && !fs.existsSync(f.old) && !fs.existsSync(f.journal));
    f = fixture('delete-denied'); const occupied = context(f.cwd, { unlinkSync(file) { if (file === f.old) throw io('occupied legacy'); return fs.unlinkSync(file); } });
    assert.throws(() => occupied.migrateLegacyBtw(), /occupied legacy/); const first = fs.readFileSync(f.target);
    assert.throws(() => context(f.cwd, { unlinkSync(file) { if (file === f.old) throw io('occupied legacy'); return fs.unlinkSync(file); } }).migrateLegacyBtw(), /occupied legacy/);
    check('two failed legacy deletes do not append the same source twice or replace prior snapshot', fs.readFileSync(f.target).equals(first) && same(f.old, f.legacy) && same(f.target + '.7coder-prev', f.before) && fs.existsSync(f.journal));
    context(f.cwd).migrateLegacyBtw(); check('next available startup finishes cleanup without duplicate append', complete(f) && fs.readFileSync(f.target).equals(first));
    f = fixture('journal-cleanup-denied'); assert.throws(() => context(f.cwd, { unlinkSync(file) { if (file === f.journal) throw io('journal cleanup'); return fs.unlinkSync(file); } }).migrateLegacyBtw(), /journal cleanup/);
    check('journal cleanup failure after source removal retains committed data and recovery journal', !fs.existsSync(f.old) && same(f.target, f.before + f.legacy) && fs.existsSync(f.journal));
    context(f.cwd).migrateLegacyBtw(); check('source-absent recovery clears journal only after target-content verification', complete(f));
    f = fixture('prepare-denied'); assert.throws(() => context(f.cwd, { renameSync(a, b) { if (b === f.journal) throw io('journal publish'); return fs.renameSync(a, b); } }).migrateLegacyBtw(), /journal publish/);
    check('failed intent publication leaves source and target unchanged with no target backup', same(f.old, f.legacy) && same(f.target, f.before) && !fs.existsSync(f.journal) && !fs.existsSync(f.target + '.7coder-prev'));
    f = fixture('target-denied'); assert.throws(() => context(f.cwd, { renameSync(a, b) { if (b === f.target) throw io('target publish'); return fs.renameSync(a, b); } }).migrateLegacyBtw(), /target publish/);
    check('target replacement failure keeps source/target and prepared intent for retry', same(f.old, f.legacy) && same(f.target, f.before) && fs.existsSync(f.journal));
    context(f.cwd).migrateLegacyBtw(); check('prepared intent retries the append exactly once', complete(f));
    f = fixture('target-conflict'); let reads = 0; assert.throws(() => context(f.cwd, { openSync(file, flags, mode) { if (file === f.target && flags === 'r' && ++reads === 2) fs.writeFileSync(file, 'EXTERNAL_TARGET'); return fs.openSync(file, flags, mode); } }).migrateLegacyBtw(), /State changed before commit/);
    assert.throws(() => context(f.cwd).migrateLegacyBtw(), /target changed/);
    check('optimistic content check preserves external target edits and source instead of overwriting them', same(f.target, 'EXTERNAL_TARGET') && same(f.old, f.legacy) && fs.existsSync(f.journal));
    f = fixture('source-conflict'); assert.throws(() => context(f.cwd, { renameSync(a, b) { fs.renameSync(a, b); if (b === f.target) fs.writeFileSync(f.old, 'EXTERNAL_SOURCE'); } }).migrateLegacyBtw(), /source changed before cleanup/);
    assert.throws(() => context(f.cwd).migrateLegacyBtw(), /legacy source changed/);
    check('changed source after target commit is not deleted or appended again', same(f.old, 'EXTERNAL_SOURCE') && same(f.target, f.before + f.legacy) && fs.existsSync(f.journal));
    f = fixture('source-missing-conflict'); assert.throws(() => context(f.cwd, { unlinkSync(file) { if (file === f.journal) throw io('journal cleanup'); return fs.unlinkSync(file); } }).migrateLegacyBtw(), /journal cleanup/); fs.writeFileSync(f.target, 'EXTERNAL_TARGET');
    assert.throws(() => context(f.cwd).migrateLegacyBtw(), /source absent and target/); check('source-absent conflicting target cannot silently discard recovery evidence', !fs.existsSync(f.old) && same(f.target, 'EXTERNAL_TARGET') && fs.existsSync(f.journal));
    f = fixture('bad-journal'); fs.writeFileSync(f.journal, '{invalid'); assert.throws(() => context(f.cwd).migrateLegacyBtw(), /repair before retrying/);
    check('invalid journal preserves both notes and corruption evidence instead of guessing phase', same(f.old, f.legacy) && same(f.target, f.before) && fs.readdirSync(path.dirname(f.journal)).some(n => n.startsWith('btw-migration.json.7coder-corrupt-')));
    f = fixture('hardlink', 'SAME_BYTES', null); fs.linkSync(f.target, f.old); assert.throws(() => context(f.cwd).migrateLegacyBtw(), /same file/);
    check('hardlinked legacy and current paths are refused before append/journal creation', same(f.old, 'SAME_BYTES') && same(f.target, 'SAME_BYTES') && !fs.existsSync(f.journal));
    f = fixture('bounded'); const fd = fs.openSync(f.old, 'w'); fs.ftruncateSync(fd, 100 * 1024 * 1024); fs.closeSync(fd); let dataReads = 0;
    assert.throws(() => context(f.cwd, { readSync(...args) { dataReads++; return fs.readSync(...args); } }).migrateLegacyBtw(), e => e.code === 'EFILETOOLARGE');
    check('oversized legacy input remains intact and creates no transaction intent', fs.statSync(f.old).size === 100 * 1024 * 1024 && same(f.target, f.before) && !fs.existsSync(f.journal));
    fs.writeFileSync(f.old, 'x'.repeat(8 * 1024 * 1024)); assert.throws(() => context(f.cwd).migrateLegacyBtw(), e => e.code === 'EFILETOOLARGE');
    check('merged output limit fails before publishing intent or replacing current notes', same(f.target, f.before) && !fs.existsSync(f.journal));
    const crashScript = path.join(S.runDir, 'btw-commit-boundary.js'); fs.writeFileSync(crashScript, `const fs=require('fs'),path=require('path'),vm=require('vm'),{loadContext}=require(${JSON.stringify(path.join(__dirname, 'download-commit.js'))});const [idx,cwd,phase]=process.argv.slice(2),source=fs.readFileSync(idx,'utf8'),old=path.join(cwd,'BTW.md'),target=path.join(cwd,'.7coder','BTW.md'),journal=path.join(cwd,'.7coder','btw-migration.json');
const c=loadContext(source,cwd,{renameSync(a,b){fs.renameSync(a,b);if((phase==='prepared'&&b===journal)||(phase==='applied'&&b===target))process.exit(73);},unlinkSync(file){fs.unlinkSync(file);if((phase==='source-removed'&&file===old)||(phase==='complete'&&file===journal))process.exit(73);}},{Buffer,appDir:path.dirname(idx)});vm.runInContext(source.slice(source.indexOf('function parseBtwMigrationState('),source.indexOf('function migrateWorkspaceRootFiles()',source.indexOf('function parseBtwMigrationState('))),c);c.migrateLegacyBtw();process.exit(74);`);
    let real;
    for (const phase of ['prepared', 'applied', 'source-removed', 'complete']) {
      f = fixture('crash-' + phase); const result = S.spawnSync(S.NODE_BIN, [crashScript, S.IDX, f.cwd, phase], { encoding: 'utf8', timeout: 8000 }); assert.strictEqual(result.status, 73, result.stderr || 'commit boundary not reached');
      if (phase === 'applied') { real = f; check('actual abrupt exit after target publication leaves source and intent for full-Agent recovery', same(f.target, f.before + f.legacy) && same(f.old, f.legacy) && fs.existsSync(f.journal)); continue; }
      context(f.cwd).migrateLegacyBtw(); check('next process after abrupt ' + phase + ' retains one exact append', complete(f));
    }
    let calls = 0; server = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { calls++; const body = JSON.parse(raw); if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'BTW_RECOVERED' } }] }) + '\n\ndata: [DONE]\n\n'); } else res.end(JSON.stringify({ choices: [{ message: { content: 'BTW_RECOVERED' } }] })); }); }); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    const cli = await S.runCli({ port: server.address().port, args: ['--prompt', 'recover task'], cwd: real.cwd, env: { DREAM_ALLOW: 'false', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1' }, timeoutMs: 8000 });
    check('actual next Agent startup resumes applied transaction without duplicate data before task', cli.code === 0 && cli.out.includes('BTW_RECOVERED') && calls === 1 && complete(real) && same(real.target + '.7coder-prev', real.before));
    console.log('BTW/MIGRATION ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally { clearTimeout(deadline); S.cleanup(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
