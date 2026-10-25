// Transaction cleanup must not delete whatever happens to occupy an old path.
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'temp-ownership' }), source = fs.readFileSync(S.IDX, 'utf8');
const sockets = new Set(); let checks = 0, server;
const deadline = setTimeout(() => { console.error('TEMP/OWNERSHIP deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const same = (file, text) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
function context(cwd, overrides, extra) {
  const fds = new Map(), warnings = [];
  const ctx = loadContext(source, cwd, Object.assign({
    openSync(file, flags, mode) { const fd = fs.openSync(file, flags, mode); fds.set(fd, String(file)); return fd; },
    closeSync(fd) { try { fs.closeSync(fd); } finally { fds.delete(fd); } }
  }, overrides), Object.assign({ console: { warn: text => warnings.push(text), log() {} } }, extra));
  return { ctx, fds, warnings };
}
function fixture(name, actor) {
  const cwd = S.freshCwd(name), parent = path.join(cwd, 'nested'), target = path.join(parent, 'target.txt');
  fs.mkdirSync(parent); fs.writeFileSync(target, 'OLD');
  if (actor === 'restore') { context(cwd).ctx.backupExistingFile(target); fs.writeFileSync(target, 'CURRENT'); }
  return { cwd, parent, target };
}
function actorTemp(actor, file) {
  return actor === 'state' ? file.includes('.7coder-tmp-') : actor === 'backup' ? file.includes('.stage-') && file.endsWith('data.bak') :
    actor === 'restore' ? path.basename(file).startsWith('.7coder-restore-') : file.includes('.part-');
}
async function operate(c, f, actor, url) {
  try {
    if (actor === 'state') { c.ctx.replaceStateBytes(f.target, Buffer.from('NEW')); return { status: 'ok' }; }
    if (actor === 'backup') { c.ctx.backupExistingFile(f.target); return { status: 'ok' }; }
    if (actor === 'restore') return c.ctx.restoreLatestBackupDetailed('nested/target.txt');
    return await c.ctx.download({ path: 'nested/target.txt', url });
  } catch (error) { return { status: 'error', message: error.message }; }
}
async function main() {
  try {
    server = http.createServer((req, res) => res.end('DOWNLOADED'));
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port + '/file';
    // Keep the old inode alive by renaming it; the replacement is guaranteed
    // to be a different object, avoiding a false test from inode reuse.
    for (const actor of ['state', 'backup', 'restore', 'download']) {
      for (const phase of process.platform === 'win32' ? ['same-parent', 'parent-junction'] : ['same-parent']) {
        const f = fixture(actor + '-' + phase, actor), outside = S.freshCwd(actor + '-' + phase + '-outside');
        const parent = actor === 'backup' ? path.join(f.cwd, '.7coder', 'backups', 'v1') : f.parent;
        const moved = path.join(outside, 'moved'); let changed = false, foreign = null, preserved = null;
        let c;
        function replace(file) {
          if (changed) return;
          if (phase === 'parent-junction') { fs.renameSync(parent, moved); fs.symlinkSync(moved, parent, 'junction'); }
          foreign = phase === 'parent-junction' ? path.join(moved, path.relative(parent, file)) : file;
          preserved = foreign + '.preserved'; fs.renameSync(foreign, preserved); fs.writeFileSync(foreign, 'FOREIGN'); changed = true;
        }
        c = context(f.cwd, {
          closeSync(fd) {
            const file = c.fds.get(fd); fs.closeSync(fd); c.fds.delete(fd);
            if (!changed && actor !== 'download' && file && actorTemp(actor, file)) replace(file);
          },
          createWriteStream(file, options) {
            const writer = fs.createWriteStream(file, options);
            writer.once('close', () => { c.fds.delete(options.fd); if (!changed) replace(file); }); return writer;
          }
        });
        try {
          const outcome = await operate(c, f, actor, url);
          const current = actor === 'backup' || phase === 'same-parent' ? f.target : path.join(moved, 'target.txt');
          check(actor + ': changed ' + phase + ' temp identity blocks commit and preserves both objects', changed &&
            ['error', 'failed', 'conflict'].includes(outcome.status) && same(foreign, 'FOREIGN') && fs.existsSync(preserved) &&
            same(current, actor === 'restore' ? 'CURRENT' : 'OLD') && c.fds.size === 0);
          check(actor + ': changed ' + phase + ' cleanup reports retained evidence',
            actor === 'restore' ? !!outcome.residue : actor === 'download' ? /temporary file retained/.test(outcome.text) : c.warnings.some(s => /retained/.test(s)));
        } finally { if (changed && phase === 'parent-junction') fs.rmdirSync(parent); }
      }
    }
    // Force a rename failure after the final pre-commit check. Even this
    // last-gap change must not authorize the failure cleanup to unlink it.
    {
      const f = fixture('state-rename-failure', 'state'), outside = S.freshCwd('rename-outside'), moved = path.join(outside, 'moved');
      let changed = false, foreign;
      const c = context(f.cwd, { renameSync(from, to) {
        if (to !== f.target) return fs.renameSync(from, to);
        fs.renameSync(f.parent, moved); fs.symlinkSync(moved, f.parent, 'junction'); changed = true;
        foreign = path.join(moved, path.basename(from)); fs.renameSync(foreign, foreign + '.owned'); fs.writeFileSync(foreign, 'FOREIGN');
        throw Object.assign(Error('rename failed after parent replacement'), { code: 'EIO' });
      } });
      if (process.platform === 'win32') {
        try {
          const outcome = await operate(c, f, 'state');
          check('state: final-gap rename failure cannot delete replacement through a junction', changed && outcome.status === 'error' && same(foreign, 'FOREIGN') && same(path.join(moved, 'target.txt'), 'OLD') && c.fds.size === 0);
        } finally { if (changed) fs.rmdirSync(f.parent); }
      }
    }
    // Staging does not grant ownership of files created by another writer.
    {
      const f = fixture('manifest-collision', 'backup'); let foreign, payload;
      let c;
      c = context(f.cwd, { closeSync(fd) {
        const file = c.fds.get(fd); fs.closeSync(fd); c.fds.delete(fd);
        if (!foreign && file && actorTemp('backup', file)) {
          payload = file; foreign = path.join(path.dirname(file), 'manifest.json'); fs.writeFileSync(foreign, 'FOREIGN-MANIFEST');
        }
      } });
      const outcome = await operate(c, f, 'backup');
      check('backup: exclusive manifest collision neither overwrites foreign data nor deletes owned payload', outcome.status === 'error' && same(foreign, 'FOREIGN-MANIFEST') && same(payload, 'OLD') && same(f.target, 'OLD') && c.fds.size === 0 && c.warnings.some(s => /retained/.test(s)));
    }
    for (const actor of ['state', 'restore', 'download']) {
      const f = fixture('identity-unavailable-' + actor, actor); let temp;
      let c;
      c = context(f.cwd, { fstatSync(fd) {
        const file = c.fds.get(fd);
        if (file && actorTemp(actor, file)) { temp = file; throw Object.assign(Error('creation identity unavailable'), { code: 'EIO' }); }
        return fs.fstatSync(fd);
      } });
      const outcome = await operate(c, f, actor, url);
      check(actor + ': failed creation-identity capture closes descriptors and preserves unproven residue', temp && fs.existsSync(temp) &&
        ['error', 'failed'].includes(outcome.status) && same(f.target, actor === 'restore' ? 'CURRENT' : 'OLD') && c.fds.size === 0);
    }
    {
      const f = fixture('idempotent-owner', 'state'), c = context(f.cwd), temp = path.join(f.parent, 'temporary');
      const parent = c.ctx.captureTempParent(temp), fd = fs.openSync(temp, 'wx');
      const owned = c.ctx.captureOwnedTempFile(temp, fd, parent); fs.closeSync(fd);
      c.ctx.removeOwnedTempFile(owned); c.ctx.removeOwnedTempFile(owned);
      check('owned missing-file cleanup is idempotent under an unchanged parent', !fs.existsSync(temp) && same(f.target, 'OLD'));
    }
    {
      const f = fixture('hardlink-temp', 'state'), c = context(f.cwd), temp = path.join(f.parent, 'temporary');
      const parent = c.ctx.captureTempParent(temp), fd = fs.openSync(temp, 'wx');
      const owned = c.ctx.captureOwnedTempFile(temp, fd, parent); fs.closeSync(fd); fs.linkSync(temp, path.join(f.parent, 'alias'));
      assert.throws(() => c.ctx.removeOwnedTempFile(owned), e => e.code === 'ETEMPOWNERSHIP');
      check('a newly shared hard-linked temp is not deleted by its former owner', fs.statSync(temp).nlink === 2 && fs.existsSync(path.join(f.parent, 'alias')));
    }
    {
      const f = fixture('private-install', 'state'), install = S.freshCwd('installation'), file = path.join(install, 'models.json');
      const c = context(f.cwd, {}, { appDir: install }); c.ctx.replaceStateBytes(file, Buffer.from('{}'));
      assert.throws(() => c.ctx.replaceStateBytes(path.join(install, 'unrelated.txt'), Buffer.from('NO')), /outside/);
      check('explicit install config retains its allowed root without granting unrelated external writes', same(file, '{}') && !fs.existsSync(path.join(install, 'unrelated.txt')) && c.fds.size === 0 && fs.readdirSync(install).length === 1);
    }
    console.log('TEMP/OWNERSHIP ' + checks + '/' + checks);
  } finally { clearTimeout(deadline); for (const socket of sockets) socket.destroy(); if (server) await new Promise(resolve => server.close(resolve)); S.cleanup(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
