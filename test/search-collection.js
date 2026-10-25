const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'search-collection' }), source = fs.readFileSync(S.IDX, 'utf8'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(name, overrides) { const cwd = S.freshCwd(name), c = loadContext(source, cwd, overrides, { Buffer, SCAN_SKIP_DIRS: [] }); vm.runInContext(cut('function globToRegex(', '// P2-3: heavy directories') + cut('function grepSearch(', '// Keep the handle until close'), c); return { cwd, c }; }
try {
  let visited = 0, closed = 0, opened = 0, f;
  const io = { readdirSync() { throw Error('whole directory read forbidden'); }, opendirSync() { opened++; let index = 0; return { readSync() { visited++; return { name: 'unmatched-' + index++ + '.bin' }; }, closeSync() { closed++; } }; }, statSync(file) { if (file === f.cwd) return fs.statSync(file); return { size: 3 * 1024 * 1024, isDirectory: () => false, isFile: () => true }; } };
  f = context('logical-million', io); let results = f.c.recursiveReaddir('', '*.missing', { maxEntries: 3 });
  check('glob reads only visit budget plus one probe from logical unbounded directory', results.length === 1 && results[0].includes('visit limit 12') && visited === 13 && opened === closed);
  visited = 0; let text = f.c.grepSearch('needle', '', { skipHeavy: true, maxVisited: 6 }); check('grep skipped large files consume visits without materializing names or file content', text.includes('visit limit 6') && visited === 7 && opened === closed);
  let active = 0, peak = 0;
  f = context('native-tree', { opendirSync(dir) { const h = fs.opendirSync(dir); active++; peak = Math.max(peak, active); return { readSync: () => h.readSync(), closeSync() { h.closeSync(); active--; } }; } });
  fs.mkdirSync(path.join(f.cwd, 'sub', 'nested'), { recursive: true }); fs.writeFileSync(path.join(f.cwd, 'sub', 'nested', 'match.txt'), 'needle'); fs.writeFileSync(path.join(f.cwd, 'root.txt'), 'needle');
  results = f.c.recursiveReaddir('', '*.txt', { maxEntries: 1 }); check('match-cap early return closes child and parent directory handles', results.length === 2 && active === 0);
  text = f.c.grepSearch('needle', '', { skipHeavy: true, maxFiles: 1 }); check('file-cap early return closes all recursive handles', text.includes('truncated after 1 files scanned') && active === 0 && peak <= 3);
  const normalGlob = f.c.globToRegex; f.c.globToRegex = () => ({ test() { throw Error('fixture matcher failure'); } }); assert.throws(() => f.c.recursiveReaddir('', '*.txt', { maxEntries: 100 }), /glob matching failed/); f.c.globToRegex = normalGlob;
  check('matching exception closes the whole open traversal chain', active === 0);
  let cancelled = false; const nativeOpen = f.c.fs.opendirSync; f.c.fs.opendirSync = dir => { const h = nativeOpen(dir); return { readSync() { const e = h.readSync(); cancelled = true; return e; }, closeSync: () => h.closeSync() }; };
  assert.throws(() => f.c.recursiveReaddir('', '*', { maxEntries: 100, cancelled: () => cancelled }), e => e.code === 'EXECUTION_CANCELLED'); check('glob cancellation during enumeration closes its owned handle', active === 0);
  cancelled = false; assert.throws(() => f.c.grepSearch('needle', '', { skipHeavy: true, cancelled: () => cancelled }), e => e.code === 'EXECUTION_CANCELLED'); check('grep cancellation during enumeration closes its owned handle', active === 0);
  let data = 0, descriptors = 0, changed = false;
  f = context('growth-before-open', { openSync(file, flags, mode) { if (file === path.join(f.cwd, 'grow.txt') && flags === 'r' && !changed) { changed = true; const fd = fs.openSync(file, 'r+'); fs.ftruncateSync(fd, 100 * 1024 * 1024); fs.closeSync(fd); } const fd = fs.openSync(file, flags, mode); descriptors++; return fd; }, readSync(...args) { const n = fs.readSync(...args); data += n; return n; }, closeSync(fd) { fs.closeSync(fd); descriptors--; } });
  fs.writeFileSync(path.join(f.cwd, 'grow.txt'), 'needle'); text = f.c.grepSearch('needle', 'grow.txt', { skipHeavy: true });
  check('file growing between initial stat and open is refused before any data read', text.includes('EFILETOOLARGE') && !text.startsWith('No matches') && data === 0 && descriptors === 0);
  data = 0; descriptors = 0; changed = false;
  f = context('growth-during-read', { openSync(...args) { const fd = fs.openSync(...args); descriptors++; return fd; }, readSync(...args) { const n = fs.readSync(...args); data += n; if (n && !changed) { changed = true; const fd = fs.openSync(path.join(f.cwd, 'grow.txt'), 'r+'); fs.ftruncateSync(fd, 100 * 1024 * 1024); fs.closeSync(fd); } return n; }, closeSync(fd) { fs.closeSync(fd); descriptors--; } });
  fs.writeFileSync(path.join(f.cwd, 'grow.txt'), 'needle'); text = f.c.grepSearch('needle', 'grow.txt', { skipHeavy: true });
  check('file growing during collection stops at 2MiB plus probe and closes without matching partial data', text.includes('EFILETOOLARGE') && !text.includes(': matches') && data <= 2 * 1024 * 1024 + 1 && descriptors === 0);
  changed = false; f = context('replacement', { readSync(...args) { const n = fs.readSync(...args); if (n && !changed) { changed = true; const file = path.join(f.cwd, 'input.txt'); fs.renameSync(file, file + '.retained'); fs.writeFileSync(file, 'needle'); } return n; } });
  fs.writeFileSync(path.join(f.cwd, 'input.txt'), 'needle'); text = f.c.grepSearch('needle', 'input.txt', { skipHeavy: true }); check('detected same-size file replacement is incomplete rather than a stale successful match', text.includes('changed during read') && !text.includes(': matches'));
  f = context('legacy'); fs.writeFileSync(path.join(f.cwd, 'line.txt'), 'one\ntwo'); fs.writeFileSync(path.join(f.cwd, 'other.txt'), 'other');
  check('no-options internal traversal and whole-file cross-line grep retain legacy semantics', f.c.recursiveReaddir().length === 2 && f.c.grepSearch('one\ntwo', 'line.txt').includes(': matches') && f.c.grepSearch('one\ntwo', 'line.txt', { skipHeavy: true }).startsWith('No matches'));
  f = context('directory-read-error', { opendirSync() { return { readSync() { throw Object.assign(Error('fixture read error'), { code: 'EIO' }); }, closeSync() { closed++; } }; } }); const before = closed;
  check('directory read error is visible and closes each opened handle', f.c.recursiveReaddir('', '*', { maxEntries: 10 })[0].includes('EIO') && f.c.grepSearch('needle', '', { skipHeavy: true }).includes('EIO') && closed === before + 2);
  console.log('SEARCH/COLLECTION ' + checks + '/' + checks + ' passed; SKIP 0');
} finally { S.cleanup(); }
