// Bounded state reads preserve originals rather than buffering/quarantining huge files.
const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { loadContext } = require('./download-commit');
const H = require('./_endpoint').create({ suite: 'state-budget', endpoint: 'http://127.0.0.1:1', key: 'fixture', model: 'fixture' });
const S = H.S, source = fs.readFileSync(S.IDX, 'utf8'), limit = 8 * 1024 * 1024;
let checks = 0;
const deadline = setTimeout(() => { console.error('STATE/BUDGET deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function context(cwd, overrides) { return loadContext(source, cwd, overrides, { Buffer, appDir: path.dirname(S.IDX), console: { warn() {}, log() {} } }); }
function fixture(name) { const cwd = S.freshCwd(name), file = path.join(cwd, 'note.md'); return { cwd, file }; }
function sparse(file, size) { const fd = fs.openSync(file, 'w'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } }
function same(file, text) { return fs.readFileSync(file).equals(Buffer.from(text)); }
function tracked(overrides) {
  const open = new Set(), io = { reads: 0, bytes: 0, wholeReads: 0, open };
  return Object.assign(io, { overrides: Object.assign({
    openSync(file, flags, mode) { const fd = fs.openSync(file, flags, mode); open.add(fd); return fd; },
    closeSync(fd) { fs.closeSync(fd); open.delete(fd); },
    readFileSync() { io.wholeReads++; throw Error('unbounded read is forbidden in state reader'); },
    readSync(fd, buffer, offset, length, position) { io.reads++; const n = fs.readSync(fd, buffer, offset, length, position); io.bytes += n; return n; }
  }, overrides) });
}
(async () => {
  try {
    const exact = fixture('中文 空格-boundary');
    // 8MiB is not divisible by three; construct the boundary by bytes explicitly.
    const boundary = Buffer.concat([Buffer.from('\uFEFF中😀'), Buffer.alloc(limit - Buffer.byteLength('\uFEFF中😀'), 65)]);
    fs.writeFileSync(exact.file, boundary); const io = tracked(), c = context(exact.cwd, io.overrides);
    check('exact 8MiB UTF8 state succeeds without whole-file read and closes descriptor', c.readStateRecord(exact.file).bytes.equals(boundary) && io.bytes === limit && io.wholeReads === 0 && io.open.size === 0);
    const huge = fixture('oversize'), old = 'previous valid'; sparse(huge.file, 100 * 1024 * 1024); fs.writeFileSync(huge.file + '.7coder-prev', old);
    const hugeIO = tracked(), hugeCtx = context(huge.cwd, hugeIO.overrides);
    for (const readOnly of [false, true]) assert.throws(() => hugeCtx.readStateRecord(huge.file, hugeCtx.parseStateText, readOnly), e => e.code === 'EFILETOOLARGE' && e.message.includes(huge.file));
    assert.throws(() => hugeCtx.writeStateFile(huge.file, 'replacement'), e => e.code === 'EFILETOOLARGE');
    check('oversized primary/read-only/save preserve original and previous with zero data reads or new evidence', hugeIO.reads === 0 && hugeIO.open.size === 0 && fs.statSync(huge.file).size === 100 * 1024 * 1024 && same(huge.file + '.7coder-prev', old) && fs.readdirSync(huge.cwd).length === 2);
    const missing = fixture('large-previous'); sparse(missing.file + '.7coder-prev', limit + 1); const previousIO = tracked(), previous = context(missing.cwd, previousIO.overrides);
    assert.throws(() => previous.readStateRecord(missing.file), e => e.code === 'EFILETOOLARGE');
    check('oversized previous is refused before data read and cannot create a primary', previousIO.reads === 0 && previousIO.open.size === 0 && !fs.existsSync(missing.file) && fs.statSync(missing.file + '.7coder-prev').size === limit + 1);
    const bad = fixture('invalid-large-previous'); fs.writeFileSync(bad.file, '{broken'); sparse(bad.file + '.7coder-prev', limit + 1); const badCtx = context(bad.cwd);
    assert.throws(() => badCtx.readStateRecord(bad.file, badCtx.parseTodoState), e => e.code === 'EFILETOOLARGE');
    check('bounded corrupt primary keeps exact evidence even when previous is oversized', same(bad.file, '{broken') && same(bad.file + '.7coder-corrupt-' + crypto.createHash('sha256').update('{broken').digest('hex'), '{broken'));
    const collision = fixture('evidence-oversize'); fs.writeFileSync(collision.file, '{bad'); fs.writeFileSync(collision.file + '.7coder-prev', '{"items":[]}');
    const evidence = collision.file + '.7coder-corrupt-' + crypto.createHash('sha256').update('{bad').digest('hex'); sparse(evidence, limit + 1);
    const collisionCtx = context(collision.cwd); assert.throws(() => collisionCtx.readStateRecord(collision.file, collisionCtx.parseTodoState), e => e.code === 'EFILETOOLARGE');
    check('oversized existing evidence is neither fully read nor overwritten to permit recovery', same(collision.file, '{bad') && same(collision.file + '.7coder-prev', '{"items":[]}') && fs.statSync(evidence).size === limit + 1);
    const proposed = fixture('proposed'), proposedCtx = context(proposed.cwd); fs.writeFileSync(proposed.file, 'old'); let parsed = false;
    assert.throws(() => proposedCtx.writeStateFile(proposed.file, '中'.repeat(Math.floor(limit / 3) + 1), () => { parsed = true; }), e => e.code === 'EFILETOOLARGE');
    check('proposed state uses UTF8 bytes before parsing or creating previous/staging files', !parsed && same(proposed.file, 'old') && fs.readdirSync(proposed.cwd).length === 1);
    const growth = fixture('growth-race'); fs.writeFileSync(growth.file, 'a'); let grown = false;
    const growthIO = tracked({ readSync(fd, buffer, offset, length, position) { if (!grown) { grown = true; sparse(growth.file, limit + 100); } const n = fs.readSync(fd, buffer, offset, length, position); growthIO.bytes += n; return n; } });
    assert.throws(() => context(growth.cwd, growthIO.overrides).readStateRecord(growth.file), e => e.code === 'EFILETOOLARGE');
    check('file growing after fstat stops at max+1 bytes and closes without evidence copy', growthIO.bytes === limit + 1 && growthIO.open.size === 0 && fs.readdirSync(growth.cwd).length === 1);
    const changed = fixture('changed'); fs.writeFileSync(changed.file, 'old'); let touched = false;
    const changedIO = tracked({ readSync(fd, buffer, offset, length, position) { const n = fs.readSync(fd, buffer, offset, length, position); if (!touched) { touched = true; fs.appendFileSync(changed.file, 'x'); } return n; } });
    assert.throws(() => context(changed.cwd, changedIO.overrides).readStateRecord(changed.file), /changed during read/);
    check('detected file changes fail outside corruption recovery and preserve bytes', same(changed.file, 'oldx') && changedIO.open.size === 0 && fs.readdirSync(changed.cwd).length === 1);
    const failing = fixture('read-error'); fs.writeFileSync(failing.file, 'data'); const failIO = tracked({ readSync() { throw Object.assign(Error('injected read EIO'), { code: 'EIO' }); } });
    assert.throws(() => context(failing.cwd, failIO.overrides).readStateRecord(failing.file), /injected read EIO/);
    check('read failure closes descriptor and does not classify file as corrupt', failIO.open.size === 0 && same(failing.file, 'data') && fs.readdirSync(failing.cwd).length === 1);
    const recovery = fixture('normal-recovery'); fs.writeFileSync(recovery.file, '{bad'); fs.writeFileSync(recovery.file + '.7coder-prev', '{"items":[]}'); const recovered = context(recovery.cwd);
    check('bounded normal corrupt state still restores validated previous with original evidence', recovered.readStateRecord(recovery.file, recovered.parseTodoState).value.items.length === 0 && same(recovery.file, '{"items":[]}') && fs.readdirSync(recovery.cwd).some(n => n.includes('.7coder-corrupt-')));
    const cwd = S.freshCwd('startup'); fs.mkdirSync(path.join(cwd, '.7coder')); const models = path.join(cwd, '.7coder', 'models.json'); sparse(models, 100 * 1024 * 1024);
    const failed = S.spawnSync(S.NODE_BIN, [S.IDX, '--server'], { cwd, encoding: 'utf8', timeout: 8000 });
    check('actual Agent rejects oversized model config before ready with nonzero exit and intact original', failed.status === 1 && failed.stderr.includes('model configuration load failed') && failed.stderr.includes('8388608-byte limit') && !failed.stdout.includes('endpoint ready') && fs.statSync(models).size === 100 * 1024 * 1024 && fs.readdirSync(path.dirname(models)).length === 1);
    fs.writeFileSync(models, '{}'); await H.start(cwd);
    check('after explicit config repair next startup acquires released lease and answers health', JSON.parse((await H.api('/api/info')).body).runtime !== undefined);
    console.log('STATE/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally { clearTimeout(deadline); await H.stop(); S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
