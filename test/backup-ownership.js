// T22-26 owned backup store: ownership, ordering, retention and budgets.
// Real filesystem + the original backup functions loaded from index.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'backup-ownership' });
const source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0;
const deadline = setTimeout(() => { console.error('BACKUP/OWNERSHIP suite deadline'); S.cleanup(); process.exit(1); }, 120000);
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
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => /^\d{16}-[0-9a-f]{32}$/.test(n)).sort();
}
function readManifest(cwd, name) { return JSON.parse(fs.readFileSync(path.join(v1Dir(cwd), name, 'manifest.json'), 'utf8')); }
function storePath(cwd) { return path.join(v1Dir(cwd), 'store.json'); }
function stageResidue(cwd) {
  const dir = v1Dir(cwd);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.indexOf('.stage-') === 0 || n.indexOf('.deleting-') === 0) : [];
}
function ioError(code) { return Object.assign(Error('injected ' + code), { code }); }

async function main() {
  try {
    // 1. Owned create + manifest shape + sequence restore selection.
    {
      const f = fixture('owned-basic');
      const ctx = ctxAt(f.cwd);
      const first = ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'v1\n');
      const second = ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'v2\n');
      const dirs = recordDirs(f.cwd);
      check('owned create publishes sequenced records with manifests',
        typeof first === 'string' && first.endsWith('data.bak') && second !== first &&
        dirs.length === 2 && dirs[0].startsWith('0000000000000001-') && dirs[1].startsWith('0000000000000002-'));
      const manifest = readManifest(f.cwd, dirs[1]);
      check('manifest carries verified ownership fields',
        manifest.sourceRel === 'target.txt' && manifest.bytes === 3 && manifest.sha256 === crypto.createHash('sha256').update('v1\n').digest('hex') &&
        manifest.storeId === JSON.parse(fs.readFileSync(storePath(f.cwd), 'utf8')).storeId);
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('detailed undo restores the newest owned generation', outcome.status === 'restored' && outcome.format === 'v1' && outcome.sequence === 2 && same(f.file, 'v1\n'));
      check('restore consumes no backup and leaves no residue', recordDirs(f.cwd).length === 2 && stageResidue(f.cwd).length === 0 &&
        !fs.readdirSync(f.cwd).some(n => n.indexOf('.7coder-restore-') === 0));
    }
    // 2. Legacy flat files are preserved and never counted with owned records.
    {
      const f = fixture('legacy-preserved');
      const root = path.join(f.cwd, '.7coder', 'backups');
      fs.mkdirSync(root, { recursive: true });
      const legacy = path.join(root, 'target.txt.2026-01-01T00-00-00-000000-abc123Z.bak');
      fs.writeFileSync(legacy, 'ancient');
      fs.writeFileSync(path.join(root, 'pad.001.bak'), 'pad');
      ctxAt(f.cwd).backupExistingFile(f.file);
      check('legacy and loose .bak files survive an owned publish',
        same(legacy, 'ancient') && same(path.join(root, 'pad.001.bak'), 'pad') && recordDirs(f.cwd).length === 1);
    }
    // 3. Foreign storeId records are preserved and excluded from allocation.
    {
      const f = fixture('foreign-store');
      const ctx = ctxAt(f.cwd);
      for (let i = 1; i <= 7; i++) { fs.writeFileSync(f.file, 'g' + i + '\n'); ctx.backupExistingFile(f.file); }
      const oldest = recordDirs(f.cwd)[0];
      const manifest = readManifest(f.cwd, oldest);
      manifest.storeId = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(path.join(v1Dir(f.cwd), oldest, 'manifest.json'), JSON.stringify(manifest));
      fs.writeFileSync(f.file, 'g8\n');
      ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'g9\n');
      const after = recordDirs(f.cwd);
      // Quotas count every owned record including the just-published seq 8:
      // the source keeps exactly its five newest owned records (3..7,8).
      check('foreign record preserved while owned retention still applies',
        fs.existsSync(path.join(v1Dir(f.cwd), oldest, 'data.bak')) && after.length === 6 &&
        after.filter(n => n !== oldest).length === 5 &&
        ctx.restoreLatestBackupDetailed('target.txt').status === 'restored' && same(f.file, 'g8\n'));
    }
    // 4. Unknown-version record directories are kept and ignored.
    {
      const f = fixture('unknown-version');
      const ctx = ctxAt(f.cwd);
      fs.writeFileSync(f.file, 'a\n'); ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'b\n'); ctx.backupExistingFile(f.file);
      const odd = path.join(v1Dir(f.cwd), '0000000000000009-' + 'ab'.repeat(16));
      fs.mkdirSync(odd);
      fs.writeFileSync(path.join(odd, 'manifest.json'), JSON.stringify(Object.assign(readManifest(f.cwd, recordDirs(f.cwd)[0]), { version: 2, snapshotId: 'ab'.repeat(16), sequence: 9 })));
      fs.writeFileSync(path.join(odd, 'data.bak'), 'x');
      const oddOutcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('unknown-version record is neither claimed nor deleted',
        fs.existsSync(odd) && recordDirs(f.cwd).filter(n => n !== path.basename(odd)).length === 2 &&
        oddOutcome.status === 'unknown' && same(f.file, 'b\n'));
      fs.writeFileSync(f.file, 'c\n');
      ctx.backupExistingFile(f.file);
      const owned = recordDirs(f.cwd).filter(n => n !== path.basename(odd));
      check('allocation stays above the damaged foreign-version sequence',
        owned.length === 3 && owned.every((n, i) => i === 0 || parseInt(n.slice(0, 16), 10) > parseInt(owned[i - 1].slice(0, 16), 10)));
    }
    // 5. Duplicate sequence refuses allocation and preserves everything.
    {
      const f = fixture('dup-sequence');
      const ctx = ctxAt(f.cwd);
      fs.writeFileSync(f.file, 'a\n'); ctx.backupExistingFile(f.file);
      const real = recordDirs(f.cwd)[0];
      const clone = '0000000000000001-' + 'cd'.repeat(16);
      fs.mkdirSync(path.join(v1Dir(f.cwd), clone));
      const manifest = readManifest(f.cwd, real);
      manifest.snapshotId = 'cd'.repeat(16);
      fs.writeFileSync(path.join(v1Dir(f.cwd), clone, 'manifest.json'), JSON.stringify(manifest));
      fs.copyFileSync(path.join(v1Dir(f.cwd), real, 'data.bak'), path.join(v1Dir(f.cwd), clone, 'data.bak'));
      let refused = '';
      try { fs.writeFileSync(f.file, 'b\n'); ctx.backupExistingFile(f.file); } catch (e) { refused = e.message; }
      check('duplicate sequence blocks the next backup without touching the file',
        /duplicate sequence 1/.test(refused) && same(f.file, 'b\n') && fs.existsSync(path.join(v1Dir(f.cwd), clone)) && recordDirs(f.cwd).length === 2);
    }
    // 6. Damaged newest payload fails undo explicitly; no silent older pick.
    {
      const f = fixture('corrupt-newest');
      const ctx = ctxAt(f.cwd);
      fs.writeFileSync(f.file, 'one\n'); ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'two\n'); ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'three\n');
      const newest = recordDirs(f.cwd)[1];
      const payload = path.join(v1Dir(f.cwd), newest, 'data.bak');
      const bytes = fs.readFileSync(payload);
      bytes[0] = bytes[0] ^ 0xff;
      fs.writeFileSync(payload, bytes);
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('damaged newest snapshot reports failure and keeps the current file',
        outcome.status === 'failed' && same(f.file, 'three\n') && fs.existsSync(payload));
    }
    // 7. Single-snapshot and hard-admission byte budgets reject before copy.
    {
      const f = fixture('budgets', '0123456789');
      let refused = '';
      try { ctxAt(f.cwd).backupExistingFile(f.file, null, { singleMax: 2 }); } catch (e) { refused = e.message; }
      check('single-snapshot budget rejects without publishing', /single-snapshot budget/.test(refused) && same(f.file, '0123456789') && recordDirs(f.cwd).length === 0);
      const other = fixture('budget-hard', 'abc');
      const ctx = ctxAt(other.cwd);
      ctx.backupExistingFile(other.file, null, { hardAdmit: 5 });
      fs.writeFileSync(other.file, 'defgh');
      let hardRefused = '';
      try { ctx.backupExistingFile(other.file, null, { hardAdmit: 5 }); } catch (e) { hardRefused = e.message; }
      check('hard admission budget counts published bytes plus the new snapshot',
        /hard budget/.test(hardRefused) && same(other.file, 'defgh') && recordDirs(other.cwd).length === 1);
    }
    // 8. ENOSPC mid-payload fails cleanly; the sequence gap is tolerated.
    {
      const f = fixture('enospc-gap');
      const denied = ctxAt(f.cwd, { writeSync(fd, buffer, off, len) { throw ioError('ENOSPC'); } });
      let refused = '';
      try { denied.backupExistingFile(f.file); } catch (e) { refused = e.message; }
      check('ENOSPC during payload leaves no staging residue or record',
        /ENOSPC/.test(refused) && same(f.file, 'v0\n') && recordDirs(f.cwd).length === 0 && stageResidue(f.cwd).length === 0);
      fs.writeFileSync(f.file, 'after\n');
      ctxAt(f.cwd).backupExistingFile(f.file);
      const dirs = recordDirs(f.cwd);
      check('reserved-but-unpublished sequence numbers remain gaps, not duplicates',
        dirs.length === 1 && dirs[0].startsWith('0000000000000002-'));
    }
    // 9. Lost store identity with existing records refuses to re-claim.
    {
      const f = fixture('identity-loss');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(f.file);
      fs.unlinkSync(storePath(f.cwd));
      try { fs.unlinkSync(storePath(f.cwd) + '.7coder-prev'); } catch (e) {}
      let refused = '';
      try { ctx.backupExistingFile(f.file); } catch (e) { refused = e.message; }
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('missing store identity fails backup and marks undo unknown, records intact',
        /identity is missing/.test(refused) && outcome.status === 'unknown' && recordDirs(f.cwd).length === 1);
    }
    // 10. A rolled-back lastSequence cannot undercut published records.
    {
      const f = fixture('counter-rollback');
      const ctx = ctxAt(f.cwd);
      fs.writeFileSync(f.file, 'a\n'); ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'b\n'); ctx.backupExistingFile(f.file);
      const store = JSON.parse(fs.readFileSync(storePath(f.cwd), 'utf8'));
      store.lastSequence = 0;
      fs.writeFileSync(storePath(f.cwd), JSON.stringify(store));
      fs.writeFileSync(f.file, 'c\n');
      ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'd\n');
      const dirs = recordDirs(f.cwd);
      check('counter rollback still allocates above the published maximum',
        dirs.length === 3 && dirs[2].startsWith('0000000000000003-') && ctx.restoreLatestBackupDetailed('target.txt').status === 'restored' && same(f.file, 'c\n'));
    }
    // 11. Per-source and global caps with interleaved sources.
    {
      const f = fixture('caps');
      const ctx = ctxAt(f.cwd);
      const a = path.join(f.cwd, 'a.txt'), b = path.join(f.cwd, 'b.txt');
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(a, 'a' + i + '\n'); ctx.backupExistingFile(a);
        fs.writeFileSync(b, 'b' + i + '\n'); ctx.backupExistingFile(b);
      }
      fs.writeFileSync(a, 'a3\n'); ctx.backupExistingFile(a, null, { globalKeep: 3 });
      const dirs = recordDirs(f.cwd);
      // The global cap counts every record including the just-published seq 7:
      // exactly the three newest sequences remain.
      check('global cap evicts the oldest sequences across sources',
        dirs.length === 3 && dirs[0].startsWith('0000000000000005-') && dirs[2].startsWith('0000000000000007-') && stageResidue(f.cwd).length === 0);
    }
    // 12. Active restore pins protect records from retention.
    {
      const f = fixture('pinned');
      const ctx = ctxAt(f.cwd);
      for (let i = 1; i <= 6; i++) { fs.writeFileSync(f.file, 'p' + i + '\n'); ctx.backupExistingFile(f.file); }
      const oldest = recordDirs(f.cwd)[0];
      ctx.activeBackupRestorePins.add(path.join(v1Dir(f.cwd), oldest));
      fs.writeFileSync(f.file, 'p7\n');
      ctx.backupExistingFile(f.file);
      check('pinned record survives retention even beyond the per-source cap',
        recordDirs(f.cwd).length === 6 && fs.existsSync(path.join(v1Dir(f.cwd), oldest, 'data.bak')));
      ctx.activeBackupRestorePins.delete(path.join(v1Dir(f.cwd), oldest));
      fs.writeFileSync(f.file, 'p8\n');
      ctx.backupExistingFile(f.file);
      check('released pin becomes eligible again',
        recordDirs(f.cwd).length === 5 && recordDirs(f.cwd)[0].startsWith('0000000000000004-'));
    }
    // 13. Deletion failure keeps .deleting evidence instead of faking success.
    {
      const f = fixture('deleting-evidence');
      const ctx = ctxAt(f.cwd, {
        unlinkSync(file) {
          if (String(file).indexOf('.deleting-') >= 0 && String(file).endsWith('manifest.json')) throw ioError('EPERM');
          return fs.unlinkSync(file);
        }
      });
      for (let i = 1; i <= 7; i++) { fs.writeFileSync(f.file, 'd' + i + '\n'); ctx.backupExistingFile(f.file); }
      const residue = stageResidue(f.cwd);
      const kept = recordDirs(f.cwd);
      // The 7th publish plans to evict seq 1 and 2; both manifest unlinks are
      // denied, so both renamed records remain as .deleting evidence, never
      // as records, and the byte/count targets are reported as unmet.
      check('failed member deletion leaves .deleting evidence and a full report',
        residue.length === 2 && residue.every(n => n.indexOf('.deleting-') === 0 &&
          fs.existsSync(path.join(v1Dir(f.cwd), n, 'manifest.json')) &&
          !fs.existsSync(path.join(v1Dir(f.cwd), n, 'data.bak'))) && kept.length === 5);
      // The evidence directory is never selected by undo.
      fs.writeFileSync(f.file, 'd8\n');
      check('deleting evidence is never an undo candidate',
        ctx.restoreLatestBackupDetailed('target.txt').status === 'restored' && same(f.file, 'd7\n'));
    }
    // 14. Discovery budgets refuse allocation instead of guessing a maximum.
    {
      const f = fixture('index-budget');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(f.file);
      const store = JSON.parse(fs.readFileSync(storePath(f.cwd), 'utf8'));
      for (let seq = 2; seq <= 1100; seq++) {
        const dir = path.join(v1Dir(f.cwd), String(seq).padStart(16, '0') + '-' + seq.toString(16).padStart(32, '0'));
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'data.bak'), 'x');
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
          kind: '7coder-backup-manifest-v1', version: 1, storeId: store.storeId,
          snapshotId: seq.toString(16).padStart(32, '0'), sequence: seq, createdAt: '2026-10-25T00:00:00.000Z',
          sourceRel: 'pad.txt', sourceKey: 'pad.txt', bytes: 1, sha256: crypto.createHash('sha256').update('x').digest('hex')
        }));
      }
      let refused = '';
      try { fs.writeFileSync(f.file, 'more\n'); ctx.backupExistingFile(f.file); } catch (e) { refused = e.message; }
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('exhausted candidate budget blocks new backups and marks undo unknown',
        /index incomplete/.test(refused) && outcome.status === 'unknown' && same(f.file, 'more\n'));
    }
    // 15. Chinese/space/dotted paths and case-insensitive lookup on Windows.
    {
      const rel = path.join('中文 空格', 'lib.v2', 'util.2026.txt');
      const f = fixture('unicode-path');
      const file = path.join(f.cwd, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '一代\n');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(file);
      fs.writeFileSync(file, '二代\n');
      ctx.backupExistingFile(file);
      fs.writeFileSync(file, '三代\n');
      const ask = process.platform === 'win32' ? path.join('中文 空格', 'LIB.V2', 'UTIL.2026.TXT') : rel;
      const outcome = ctx.restoreLatestBackupDetailed(ask);
      check('unicode/space/dot paths back up and restore case-insensitively on Windows',
        outcome.status === 'restored' && same(file, '二代\n') &&
        readManifest(f.cwd, recordDirs(f.cwd)[1]).sourceKey === normalize(rel));
      function normalize(p) { const s = p.split(path.sep).join('/'); return process.platform === 'win32' ? s.toLowerCase() : s; }
    }
    // 16. Staging collision fails and never reuses a foreign directory.
    {
      const f = fixture('stage-collision');
      const zeros = '0'.repeat(32);
      fs.mkdirSync(path.join(v1Dir(f.cwd), '.stage-' + zeros), { recursive: true });
      fs.writeFileSync(path.join(v1Dir(f.cwd), '.stage-' + zeros, 'sentinel'), 'FOREIGN');
      const ctx = ctxAt(f.cwd, {}, { crypto: { randomBytes: n => Buffer.alloc(n) } });
      let refused = '';
      try { ctx.backupExistingFile(f.file); } catch (e) { refused = e.message; }
      check('staging collision neither overwrites nor deletes a foreign directory',
        /exclusive staging/.test(refused) && same(f.file, 'v0\n') &&
        same(path.join(v1Dir(f.cwd), '.stage-' + zeros, 'sentinel'), 'FOREIGN') && recordDirs(f.cwd).length === 0);
    }
    // 17. Hard-linked payloads are corrupt, never followed for deletion.
    {
      const f = fixture('hardlink-payload');
      const ctx = ctxAt(f.cwd);
      fs.writeFileSync(f.file, 'one\n'); ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'two\n'); ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'three\n');
      const newest = recordDirs(f.cwd)[1];
      const payload = path.join(v1Dir(f.cwd), newest, 'data.bak');
      const scratch = path.join(f.cwd, 'scratch.bin');
      fs.writeFileSync(scratch, 'two\n');
      fs.unlinkSync(payload);
      fs.linkSync(scratch, payload);
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('hard-linked payload is rejected as damaged and both links survive',
        outcome.status === 'failed' && same(f.file, 'three\n') && same(payload, 'two\n') && same(scratch, 'two\n'));
    }
    // 18. The backup store never backs itself up.
    {
      const f = fixture('self-backup');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(f.file);
      const before = fs.readFileSync(storePath(f.cwd));
      let refused = '';
      try { ctx.backupExistingFile(storePath(f.cwd)); } catch (e) { refused = e.message; }
      const legacy = path.join(f.cwd, '.7coder', 'backups', 'target.txt.2026-01-01T00-00-00-000Z.bak');
      fs.writeFileSync(legacy, 'legacy-bytes');
      let legacyRefused = '';
      try { ctx.backupExistingFile(legacy); } catch (e) { legacyRefused = e.message; }
      check('backup store members and legacy backups are refused as sources',
        /never backs itself up/.test(refused) && /never backs itself up/.test(legacyRefused) && fs.readFileSync(storePath(f.cwd)).equals(before));
    }
    // 19. Cross-process residue is preserved and never claimed or cleaned.
    {
      const f = fixture('residue');
      const stage = path.join(v1Dir(f.cwd), '.stage-' + 'e'.repeat(32));
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(stage, 'data.bak'), 'ABANDONED');
      const deleting = path.join(v1Dir(f.cwd), '.deleting-0000000000000001-' + 'f'.repeat(32) + '-aaaa');
      fs.mkdirSync(deleting, { recursive: true });
      fs.writeFileSync(path.join(deleting, 'manifest.json'), '{}');
      const ctx = ctxAt(f.cwd);
      check('residue is not an undo candidate', ctx.restoreLatestBackupDetailed('target.txt').status === 'not-found');
      fs.writeFileSync(path.join(f.cwd, 'other.txt'), 'o1\n');
      ctx.backupExistingFile(path.join(f.cwd, 'other.txt'));
      check('successful later transactions leave foreign residue untouched',
        same(path.join(stage, 'data.bak'), 'ABANDONED') && fs.existsSync(path.join(deleting, 'manifest.json')) &&
        recordDirs(f.cwd).length === 1 && ctx.restoreLatestBackupDetailed('other.txt').status === 'restored');
    }
    // 20. Quotas count the just-published record (recheck R3).
    {
      const f = fixture('quota-counts-new');
      const ctx = ctxAt(f.cwd);
      for (let i = 1; i <= 8; i++) { fs.writeFileSync(f.file, 'q' + i + '\n'); ctx.backupExistingFile(f.file); }
      const dirs = recordDirs(f.cwd);
      check('single source keeps exactly 5 owned records with no pins',
        dirs.length === 5 && dirs[0].startsWith('0000000000000004-') && dirs[4].startsWith('0000000000000008-'));
    }
    // 21. Count and byte rules share one survivor set (recheck R2).
    {
      const f = fixture('survivor-matrix');
      const ctx = ctxAt(f.cwd);
      for (let i = 1; i <= 5; i++) { fs.writeFileSync(path.join(f.cwd, 's' + i + '.txt'), 'aaa'); ctx.backupExistingFile(path.join(f.cwd, 's' + i + '.txt')); }
      fs.writeFileSync(path.join(f.cwd, 's6.txt'), 'aaa');
      ctx.backupExistingFile(path.join(f.cwd, 's6.txt'), null, { globalKeep: 2, retainTarget: 9 });
      const both = recordDirs(f.cwd).map(n => parseInt(n.slice(0, 16), 10));
      check('combined count+byte budget keeps exactly the newest two sequences',
        both.length === 2 && both[0] === 5 && both[1] === 6);
      const g = fixture('survivor-bytes-only');
      const ctx2 = ctxAt(g.cwd);
      for (let i = 1; i <= 5; i++) { fs.writeFileSync(path.join(g.cwd, 't' + i + '.txt'), 'aaa'); ctx2.backupExistingFile(path.join(g.cwd, 't' + i + '.txt')); }
      fs.writeFileSync(path.join(g.cwd, 't6.txt'), 'aaa');
      ctx2.backupExistingFile(path.join(g.cwd, 't6.txt'), null, { retainTarget: 9 });
      const bytes = recordDirs(g.cwd).map(n => parseInt(n.slice(0, 16), 10));
      check('byte-only budget evicts oldest sequences down to the target',
        bytes.length === 3 && bytes[0] === 4 && bytes[2] === 6);
    }
    // 22. Extra member: reject BEFORE any destructive step (recheck R1C).
    {
      const f = fixture('extra-member');
      const ctx = ctxAt(f.cwd);
      for (let i = 1; i <= 6; i++) { fs.writeFileSync(f.file, 'x' + i + '\n'); ctx.backupExistingFile(f.file); }
      const oldest = recordDirs(f.cwd)[0];
      fs.writeFileSync(path.join(v1Dir(f.cwd), oldest, 'extra.txt'), 'USER-DATA');
      fs.writeFileSync(f.file, 'x7\n');
      ctx.backupExistingFile(f.file);
      const kept = recordDirs(f.cwd);
      check('record with unknown extra members is preserved intact and unrenamed',
        kept.length === 6 && kept.indexOf(oldest) >= 0 &&
        fs.existsSync(path.join(v1Dir(f.cwd), oldest, 'data.bak')) &&
        fs.existsSync(path.join(v1Dir(f.cwd), oldest, 'manifest.json')) &&
        same(path.join(v1Dir(f.cwd), oldest, 'extra.txt'), 'USER-DATA') && stageResidue(f.cwd).length === 0);
    }
    // 23. storeId swapped after discovery: the record is no longer ours (recheck R1B).
    {
      const f = fixture('storeid-swap');
      const ctx = ctxAt(f.cwd);
      for (let i = 1; i <= 6; i++) { fs.writeFileSync(f.file, 'y' + i + '\n'); ctx.backupExistingFile(f.file); }
      const oldest = recordDirs(f.cwd)[0];
      const manifestPath = path.join(v1Dir(f.cwd), oldest, 'manifest.json');
      let swapped = false;
      const hooked = ctxAt(f.cwd, {
        lstatSync(p) {
          if (!swapped && path.resolve(String(p)) === path.resolve(path.join(v1Dir(f.cwd), oldest))) {
            swapped = true;
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifest.storeId = crypto.randomBytes(16).toString('hex');
            fs.writeFileSync(manifestPath, JSON.stringify(manifest));
          }
          return fs.lstatSync(p);
        }
      });
      fs.writeFileSync(f.file, 'y7\n');
      hooked.backupExistingFile(f.file);
      check('record whose storeId changed after discovery is kept, not deleted',
        swapped && fs.existsSync(path.join(v1Dir(f.cwd), oldest, 'data.bak')) &&
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')).storeId !== JSON.parse(fs.readFileSync(storePath(f.cwd), 'utf8')).storeId &&
        recordDirs(f.cwd).filter(n => n !== oldest).length === 5 && stageResidue(f.cwd).length === 0);
    }
    // 24. Directory swapped for a junction between discovery and deletion (recheck R1A).
    if (process.platform === 'win32') {
      const f = fixture('junction-swap');
      const ctx = ctxAt(f.cwd);
      for (let i = 1; i <= 6; i++) { fs.writeFileSync(f.file, 'j' + i + '\n'); ctx.backupExistingFile(f.file); }
      const oldest = recordDirs(f.cwd)[0];
      const victimDir = path.join(v1Dir(f.cwd), oldest);
      const outsideWs = S.freshCwd('junction-outside');
      const outsideDir = path.join(outsideWs, 'stolen');
      fs.mkdirSync(outsideDir);
      fs.copyFileSync(path.join(victimDir, 'manifest.json'), path.join(outsideDir, 'manifest.json'));
      fs.copyFileSync(path.join(victimDir, 'data.bak'), path.join(outsideDir, 'data.bak'));
      const saveDir = path.join(f.cwd, 'saved-record');
      let swapped = false;
      const hooked = ctxAt(f.cwd, {
        realpathSync(p) {
          if (!swapped && path.resolve(String(p)) === path.resolve(victimDir)) {
            swapped = true;
            fs.renameSync(victimDir, saveDir);
            const mk = spawnSync('cmd', ['/c', 'mklink', '/J', victimDir, outsideDir]);
            if (mk.status !== 0) throw Object.assign(Error('mklink failed'), { code: 'ELINK' });
          }
          return fs.realpathSync(p);
        }
      });
      fs.writeFileSync(f.file, 'j7\n');
      hooked.backupExistingFile(f.file);
      check('junction-swapped record is never renamed or deleted through; outside files intact',
        swapped && fs.realpathSync(victimDir) === outsideDir &&
        fs.existsSync(path.join(outsideDir, 'data.bak')) && fs.existsSync(path.join(outsideDir, 'manifest.json')) &&
        fs.existsSync(path.join(saveDir, 'data.bak')) && stageResidue(f.cwd).length === 0);
    } else {
      console.log('INFO  junction-swap repro is Windows-only');
    }
    // 25. Corrupt sequences still constrain allocation after a counter rollback (recheck R4A).
    {
      const f = fixture('corrupt-seq-rollback');
      const ctx = ctxAt(f.cwd);
      fs.writeFileSync(f.file, 'a\n'); ctx.backupExistingFile(f.file);
      fs.writeFileSync(f.file, 'b\n'); ctx.backupExistingFile(f.file);
      const dirs = recordDirs(f.cwd);
      fs.writeFileSync(path.join(v1Dir(f.cwd), dirs[1], 'manifest.json'), 'CORRUPT-MANIFEST');
      fs.unlinkSync(storePath(f.cwd)); // previous store.json (lastSequence=1) is restored by the reliable protocol
      const other = path.join(f.cwd, 'other.txt');
      fs.writeFileSync(other, 'o1\n');
      ctx.backupExistingFile(other);
      const seqs = recordDirs(f.cwd).map(n => parseInt(n.slice(0, 16), 10)).sort((a, b) => a - b);
      check('allocation stays above damaged records after counter rollback',
        seqs.length === 3 && seqs[0] === 1 && seqs[1] === 2 && seqs[2] === 3);
    }
    // 26. Same-sequence damaged record makes the newest ambiguous (recheck R4B).
    {
      const f = fixture('same-seq-ambiguity', 'one\n');
      const ctx = ctxAt(f.cwd);
      ctx.backupExistingFile(f.file);
      const clone = '0000000000000001-' + 'dd'.repeat(16);
      fs.mkdirSync(path.join(v1Dir(f.cwd), clone));
      fs.writeFileSync(path.join(v1Dir(f.cwd), clone, 'manifest.json'), 'CORRUPT');
      fs.writeFileSync(path.join(v1Dir(f.cwd), clone, 'data.bak'), 'x');
      fs.writeFileSync(f.file, 'now\n');
      const outcome = ctx.restoreLatestBackupDetailed('target.txt');
      check('damaged record sharing the newest sequence reports unknown',
        outcome.status === 'unknown' && same(f.file, 'now\n'));
    }
    // 27. Store identity scan budget (recheck R5).
    {
      const f = fixture('occupied-budget');
      fs.mkdirSync(v1Dir(f.cwd), { recursive: true });
      for (let i = 0; i < 4200; i++) fs.writeFileSync(path.join(v1Dir(f.cwd), 'junk-' + i), '');
      let refused = '';
      try { ctxAt(f.cwd).backupExistingFile(f.file); } catch (e) { refused = e.message; }
      check('unprovable v1 directory fails closed within the scan budget',
        /not provably empty/.test(refused) && recordDirs(f.cwd).length === 0 && same(f.file, 'v0\n'));
    }
    // 28. Cancellation inside the prune digest keeps the candidate (recheck R5).
    {
      const f = fixture('cleanup-cancel');
      ctxAt(f.cwd).backupExistingFile(f.file);
      const victimData = path.join(v1Dir(f.cwd), recordDirs(f.cwd)[0], 'data.bak');
      const token = function () { return !!token.reason; };
      token.reason = '';
      token.cancel = reason => { token.reason = reason || 'Execution cancelled.'; };
      const ctx = ctxAt(f.cwd, {
        openSync(file, flags) {
          const fd = fs.openSync(file, flags);
          if (path.resolve(String(file)) === path.resolve(victimData)) token.cancel('halt cleanup digest');
          return fd;
        }
      });
      // The per-source cap first evicts seq 1 at the 6th publish; the digest
      // of that victim is where the cancellation lands.
      for (let i = 2; i <= 6; i++) { fs.writeFileSync(f.file, 'c' + i + '\n'); ctx.backupExistingFile(f.file, token); }
      check('cancellation during the prune digest preserves the candidate',
        token.reason === 'halt cleanup digest' && fs.existsSync(victimData) &&
        recordDirs(f.cwd).length === 6 && stageResidue(f.cwd).length === 0);
    }
    console.log('BACKUP/OWNERSHIP: ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline);
    S.cleanup();
  }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
