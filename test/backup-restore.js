// T22-26 atomic /undo restore: staging, verification, single-rename commit,
// conflicts, managed state and cross-process/crash behavior. Real functions.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'backup-restore' });
const source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0;
const deadline = setTimeout(() => { console.error('BACKUP/RESTORE suite deadline'); S.cleanup(); process.exit(1); }, 120000);
function check(label, ok, detail) { assert.ok(ok, label + (detail ? ' :: ' + String(detail).substring(0, 200) : '')); checks++; console.log('PASS ' + label); }
const same = (file, bytes) => fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
function ctxAt(cwd, overrides, extra) { return loadContext(source, cwd, overrides || {}, extra); }
function fixture(name, bytes) {
  const cwd = S.freshCwd(name), file = path.join(cwd, 'target.txt');
  fs.writeFileSync(file, bytes === undefined ? 'v0\n' : bytes);
  return { cwd, file };
}
function v1Dir(cwd) { return path.join(cwd, '.7coder', 'backups', 'v1'); }
function recordDirs(cwd) {
  const dir = v1Dir(cwd);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^\d{16}-[0-9a-f]{32}$/.test(n)).sort() : [];
}
function restoreResidue(cwd) {
  let names = fs.readdirSync(cwd).filter(n => n.indexOf('.7coder-restore-') === 0);
  const nested = path.join(cwd, 'nested');
  if (fs.existsSync(nested)) {
    names = names.concat(fs.readdirSync(nested).filter(n => n.indexOf('.7coder-restore-') === 0).map(n => path.join('nested', n)));
  }
  return names;
}
function ioError(code) { return Object.assign(Error('injected ' + code), { code }); }
function legacyStamp(name, date) {
  const file = name;
  fs.writeFileSync(file, 'legacy-old');
  fs.utimesSync(file, date, date);
}

async function main() {
  try {
    // 1. Happy path detail + idempotent repeat restore.
    {
      const f = fixture('happy', 'one\n');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'two\n');
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      const repeat = ctx.restoreLatestBackupDetailed('target.txt');
      check('restore reports detailed success and stays idempotent',
        outcome.status === 'restored' && outcome.format === 'v1' && outcome.sequence === 1 &&
        outcome.bytes === 4 && Array.isArray(outcome.warnings) && outcome.warnings.length === 0 &&
        repeat.status === 'restored' && same(f.file, 'one\n') && recordDirs(f.cwd).length === 1 && restoreResidue(f.cwd).length === 0);
      check('boolean wrapper stays compatible', ctx.restoreLatestBackup('target.txt') === true && ctx.restoreLatestBackup('missing.txt') === false);
    }
    // 2. Initially-absent target is created by the commit rename.
    {
      const f = fixture('absent-target', 'gone\n');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(f.file);
      fs.unlinkSync(f.file);
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('absent target is recreated with exactly the backup bytes',
        outcome.status === 'restored' && same(f.file, 'gone\n') && restoreResidue(f.cwd).length === 0);
    }
    // 3. Missing parent directory fails without residue.
    {
      const f = fixture('missing-parent', 'x\n');
      const ctx = ctxAt(f.cwd);
      fs.mkdirSync(path.join(f.cwd, 'nested'));
      const nested = path.join(f.cwd, 'nested', 'deep.txt');
      fs.writeFileSync(nested, 'deep\n');
      ctx.backupExistingFile(nested);
      fs.rmSync ? fs.rmSync(path.join(f.cwd, 'nested'), { recursive: true }) : fs.rmdirSync(path.join(f.cwd, 'nested'), { recursive: true });
      const outcome = ctx.restoreLatestBackupDetailed('nested/deep.txt');
      check('missing parent directory fails the restore cleanly',
        outcome.status === 'failed' && !fs.existsSync(path.join(f.cwd, 'nested')) && recordDirs(f.cwd).length === 1);
    }
    // 4. Managed state: valid restore passes the parser gate.
    {
      const f = fixture('managed-valid');
      const todos = path.join(f.cwd, '.7coder', 'todos.json');
      fs.mkdirSync(path.dirname(todos), { recursive: true });
      fs.writeFileSync(todos, '{"items":[{"id":"t1","title":"a","status":"done"}]}');
      ctxAt(f.cwd).backupExistingFile(todos);
      fs.writeFileSync(todos, 'CORRUPT-NOT-JSON');
      const outcome = ctxAt(f.cwd).restoreLatestBackupDetailed('.7coder/todos.json');
      check('managed state restore validates the recovered content',
        outcome.status === 'restored' && same(todos, '{"items":[{"id":"t1","title":"a","status":"done"}]}'));
    }
    // 5. Managed state: a crafted record with invalid payload is blocked.
    {
      const f = fixture('managed-invalid');
      const todos = path.join(f.cwd, '.7coder', 'todos.json');
      fs.mkdirSync(path.dirname(todos), { recursive: true });
      fs.writeFileSync(todos, '{"items":[]}');
      const ctx = ctxAt(f.cwd);
      const scratch = path.join(f.cwd, 'scratch.txt');
      fs.writeFileSync(scratch, 'seed');
      ctx.backupExistingFile(scratch);
      const record = recordDirs(f.cwd)[0];
      const payload = Buffer.from('{"items":'); // truncated JSON: digest-consistent, semantically invalid
      fs.writeFileSync(path.join(v1Dir(f.cwd), record, 'data.bak'), payload);
      const manifest = JSON.parse(fs.readFileSync(path.join(v1Dir(f.cwd), record, 'manifest.json'), 'utf8'));
      manifest.sourceRel = '.7coder/todos.json';
      manifest.sourceKey = '.7coder/todos.json';
      manifest.bytes = payload.length;
      manifest.sha256 = crypto.createHash('sha256').update(payload).digest('hex');
      fs.writeFileSync(path.join(v1Dir(f.cwd), record, 'manifest.json'), JSON.stringify(manifest));
      const outcome = ctx.restoreLatestBackupDetailed('.7coder/todos.json');
      check('invalid managed-state payload never overwrites the live target',
        outcome.status === 'failed' && /managed state/.test(outcome.message) && same(todos, '{"items":[]}'));
    }
    // 6. Legacy-only fallback picks the newest mtime and restores exactly.
    {
      const f = fixture('legacy-only', 'current\n');
      const root = path.join(f.cwd, '.7coder', 'backups');
      fs.mkdirSync(root, { recursive: true });
      legacyStamp(path.join(root, 'target.txt.2026-01-01T00-00-00-000Z.bak'), new Date('2026-01-01'));
      legacyStamp(path.join(root, 'target.txt.2026-06-01T00-00-00-000Z.bak'), new Date('2026-06-01'));
      const outcome = ctxAt(f.cwd).restoreLatestBackupDetailed('target.txt');
      check('legacy fallback restores the newest legacy snapshot verbatim',
        outcome.status === 'restored' && outcome.format === 'legacy' && same(f.file, 'legacy-old'));
    }
    // 7. Legacy mtime tie is reported as unknown instead of guessed.
    {
      const f = fixture('legacy-tie', 'current\n');
      const root = path.join(f.cwd, '.7coder', 'backups');
      fs.mkdirSync(root, { recursive: true });
      const tie = new Date('2026-06-01');
      legacyStamp(path.join(root, 'target.txt.2026-05-01T00-00-00-000Z.bak'), new Date('2026-05-01'));
      legacyStamp(path.join(root, 'target.txt.2026-06-01T00-00-00-000Z.bak'), tie);
      legacyStamp(path.join(root, 'target.txt.2026-06-02T00-00-00-000Z.bak'), tie);
      const outcome = ctxAt(f.cwd).restoreLatestBackupDetailed('target.txt');
      check('tied legacy mtimes yield an explicit unknown result',
        outcome.status === 'unknown' && same(f.file, 'current\n'));
    }
    // 8. Damaged newest v1 record does NOT silently fall back to legacy.
    {
      const f = fixture('v1-damaged-no-legacy-fallback', 'now\n');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(f.file);
      const root = path.join(f.cwd, '.7coder', 'backups');
      fs.mkdirSync(root, { recursive: true });
      legacyStamp(path.join(root, 'target.txt.2026-06-01T00-00-00-000Z.bak'), new Date('2026-06-01'));
      const payload = path.join(v1Dir(f.cwd), recordDirs(f.cwd)[0], 'data.bak');
      const bytes = fs.readFileSync(payload);
      bytes[0] = bytes[0] ^ 0xff;
      fs.writeFileSync(payload, bytes);
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('damaged v1 newest fails instead of restoring the legacy copy',
        outcome.status === 'failed' && same(f.file, 'now\n') && fs.existsSync(path.join(root, 'target.txt.2026-06-01T00-00-00-000Z.bak')));
    }
    // 9. Conflict: existing target edited during restore staging.
    {
      const f = fixture('conflict-edited', 'original\n');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(f.file);
      let raced = false;
      const hooked = ctxAt(f.cwd, {
        writeSync(fd, buffer, off, len) {
          const wrote = fs.writeSync(fd, buffer, off, len);
          if (!raced) { raced = true; fs.writeFileSync(f.file, 'RACED\n'); }
          return wrote;
        }
      });
      const outcome = hooked.restoreLatestBackupDetailed('target.txt');
      check('target edited mid-restore is preserved and reported as conflict',
        outcome.status === 'conflict' && same(f.file, 'RACED\n') && restoreResidue(f.cwd).length === 0 && recordDirs(f.cwd).length === 1);
    }
    // 10. Conflict: absent target appears during restore staging.
    {
      const f = fixture('conflict-appeared', 'original\n');
      ctxAt(f.cwd).backupExistingFile(f.file);
      fs.unlinkSync(f.file);
      let raced = false;
      const hooked = ctxAt(f.cwd, {
        writeSync(fd, buffer, off, len) {
          const wrote = fs.writeSync(fd, buffer, off, len);
          if (!raced) { raced = true; fs.writeFileSync(f.file, 'APPEARED\n'); }
          return wrote;
        }
      });
      const outcome = hooked.restoreLatestBackupDetailed('target.txt');
      check('target that appears mid-restore keeps its content and conflicts',
        outcome.status === 'conflict' && same(f.file, 'APPEARED\n') && restoreResidue(f.cwd).length === 0);
    }
    // 11. Commit rename failure keeps the target and the record.
    {
      const f = fixture('rename-eperm', 'current\n');
      ctxAt(f.cwd).backupExistingFile(f.file);
      const outcome = ctxAt(f.cwd, {
        renameSync(from, to) { if (to === f.file) throw ioError('EPERM'); return fs.renameSync(from, to); }
      }).restoreLatestBackupDetailed('target.txt');
      const retry = ctxAt(f.cwd).restoreLatestBackupDetailed('target.txt');
      check('failed commit rename preserves the target and allows a retry',
        outcome.status === 'failed' && same(f.file, 'current\n') && restoreResidue(f.cwd).length === 0 &&
        retry.status === 'restored' && same(f.file, 'current\n') && recordDirs(f.cwd).length === 1);
    }
    // 12. Read-only target on Windows: rename must fail, not truncate.
    if (process.platform === 'win32') {
      const f = fixture('readonly-target', 'first\n');
      ctxAt(f.cwd).backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'second\n');
      fs.chmodSync(f.file, 0o444);
      let outcome;
      try {
        outcome = ctxAt(f.cwd).restoreLatestBackupDetailed('target.txt');
      } finally {
        try { fs.chmodSync(f.file, 0o666); } catch (e) {}
      }
      check('read-only target blocks the commit rename without byte loss',
        outcome.status === 'failed' && same(f.file, 'second\n') && restoreResidue(f.cwd).length === 0);
    } else {
      console.log('SKIP  read-only rename semantics are Windows-only here');
    }
    // 13. Binary/BOM/CRLF/emoji payloads restore byte-for-byte.
    {
      const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF, 0x00, 0xFF]), Buffer.from('中文😀\r\n', 'utf8'), Buffer.from([0x00, 0x0D, 0x0A])]);
      const f = fixture('binary-exact', bytes);
      ctxAt(f.cwd).backupExistingFile(f.file);
      fs.writeFileSync(f.file, Buffer.from('overwritten'));
      const outcome = ctxAt(f.cwd).restoreLatestBackupDetailed('target.txt');
      check('binary NUL/BOM/CRLF/emoji content restores byte-for-byte',
        outcome.status === 'restored' && same(f.file, bytes));
    }
    // 14. Cross-process: a second Node process restores the newest record.
    {
      const f = fixture('cross-process');
      const gen = S.spawnSync(S.NODE_BIN, ['-e',
        'const fs=require("fs"),path=require("path");' +
        'const load=require(' + JSON.stringify(path.join(__dirname, 'download-commit')) + ').loadContext;' +
        'const cwd=' + JSON.stringify(f.cwd) + ',file=path.join(cwd,"target.txt");' +
        'const ctx=load(fs.readFileSync(' + JSON.stringify(S.IDX) + ',"utf8"),cwd);' +
        'fs.writeFileSync(file,"gen1\\n");ctx.backupExistingFile(file);' +
        'fs.writeFileSync(file,"gen2\\n");ctx.backupExistingFile(file);' +
        'fs.writeFileSync(file,"gen3\\n");'
      ], { timeout: 30000, encoding: 'utf8' });
      check('first process creates two owned generations', gen.status === 0 && recordDirs(f.cwd).length === 2 && same(f.file, 'gen3\n'));
      const restore = S.spawnSync(S.NODE_BIN, ['-e',
        'const fs=require("fs");' +
        'const load=require(' + JSON.stringify(path.join(__dirname, 'download-commit')) + ').loadContext;' +
        'const ctx=load(fs.readFileSync(' + JSON.stringify(S.IDX) + ',"utf8"),' + JSON.stringify(f.cwd) + ');' +
        'if(!ctx.restoreLatestBackup("target.txt"))process.exit(2);console.log("RESTORED");'
      ], { timeout: 30000, encoding: 'utf8' });
      check('second process restores the newest owned generation',
        restore.status === 0 && restore.stdout.includes('RESTORED') && same(f.file, 'gen2\n'));
    }
    // 15. Abrupt exit on both sides of the restore commit rename.
    {
      const worker = path.join(S.runDir, 'restore-worker.js');
      fs.writeFileSync(worker,
        'const fs=require("fs"),path=require("path");' +
        'const load=require(' + JSON.stringify(path.join(__dirname, 'download-commit')) + ').loadContext;' +
        'const cwd=process.argv[2],mode=process.argv[3],target=path.join(cwd,"target.txt");' +
        'const ctx=load(fs.readFileSync(' + JSON.stringify(S.IDX) + ',"utf8"),cwd,{renameSync(from,to){' +
        'if(to===target){if(mode==="before")process.exit(86);fs.renameSync(from,to);process.exit(87);}return fs.renameSync(from,to);}});' +
        'ctx.restoreLatestBackupDetailed("target.txt");process.exit(99);'
      );
      for (const mode of ['before', 'after']) {
        const f = fixture('crash-' + mode, 'live\n');
        ctxAt(f.cwd).backupExistingFile(f.file);
        fs.writeFileSync(f.file, 'changed\n');
        const stopped = S.spawnSync(S.NODE_BIN, [worker, f.cwd, mode], { timeout: 30000, encoding: 'utf8' });
        const targetPreserved = mode === 'before' ? same(f.file, 'changed\n') : same(f.file, 'live\n');
        const recovery = ctxAt(f.cwd).restoreLatestBackupDetailed('target.txt');
        check('abrupt exit ' + mode + ' restore commit preserves the stated bytes and stays recoverable',
          stopped.status === (mode === 'before' ? 86 : 87) && targetPreserved &&
          recordDirs(f.cwd).length === 1 && recovery.status === 'restored');
      }
    }
    // 16. Hard-linked legacy payloads are excluded; older regular wins (recheck R7).
    {
      const f = fixture('legacy-hardlink', 'current\n');
      const root = path.join(f.cwd, '.7coder', 'backups');
      fs.mkdirSync(root, { recursive: true });
      legacyStamp(path.join(root, 'target.txt.2026-01-01T00-00-00-000Z.bak'), new Date('2026-01-01'));
      const newest = path.join(root, 'target.txt.2026-06-01T00-00-00-000Z.bak');
      fs.writeFileSync(newest, 'HARD-NEW');
      fs.linkSync(newest, path.join(root, 'alias.bak')); // nlink = 2 on both names
      const outcome = ctxAt(f.cwd).restoreLatestBackupDetailed('target.txt');
      check('hard-linked newest legacy candidate is excluded for the older regular one',
        outcome.status === 'restored' && outcome.format === 'legacy' && same(f.file, 'legacy-old') &&
        Array.isArray(outcome.warnings) && outcome.warnings.some(w => /no creation-time digest/.test(w)));
    }
    // 17. Only hard-linked legacy candidates: report why nothing restorable.
    {
      const f = fixture('legacy-only-hardlink', 'current\n');
      const root = path.join(f.cwd, '.7coder', 'backups');
      fs.mkdirSync(root, { recursive: true });
      const only = path.join(root, 'target.txt.2026-06-01T00-00-00-000Z.bak');
      fs.writeFileSync(only, 'HARD-ONLY');
      fs.linkSync(only, path.join(root, 'alias.bak'));
      const outcome = ctxAt(f.cwd).restoreLatestBackupDetailed('target.txt');
      check('legacy-only hard-linked candidates report why nothing is restorable',
        outcome.status === 'not-found' && /hard-linked/.test(outcome.message) && same(f.file, 'current\n'));
    }
    // 18. Managed-state restore warns that running state was not reloaded.
    {
      const f = fixture('managed-warn');
      const todos = path.join(f.cwd, '.7coder', 'todos.json');
      fs.mkdirSync(path.dirname(todos), { recursive: true });
      fs.writeFileSync(todos, '{"items":[]}');
      ctxAt(f.cwd).backupExistingFile(todos);
      fs.writeFileSync(todos, '{"items":[]}   ');
      const outcome = ctxAt(f.cwd).restoreLatestBackupDetailed('.7coder/todos.json');
      check('managed-state restore carries the reload warning',
        outcome.status === 'restored' && Array.isArray(outcome.warnings) && outcome.warnings.some(w => /reload/.test(w)) && same(todos, '{"items":[]}'));
    }
    // 19. Restore staging exceeding its operation budget never commits (recheck R5).
    {
      const f = fixture('restore-budget', 'one\n');
      ctxAt(f.cwd).backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'two\n');
      let clock = Date.now();
      const ctx = ctxAt(f.cwd, {
        writeSync(fd, buffer, off, len) {
          const wrote = fs.writeSync(fd, buffer, off, len);
          clock += 301000; // past BACKUP_IO_BUDGET_MS for the next phase check
          return wrote;
        }
      }, { Date: class extends Date { static now() { return clock; } } });
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('restore that outlives its operation budget fails without touching the target',
        outcome.status === 'failed' && /budget/.test(outcome.message) && same(f.file, 'two\n') && restoreResidue(f.cwd).length === 0);
    }
    console.log('BACKUP/RESTORE: ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline);
    S.cleanup();
  }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
