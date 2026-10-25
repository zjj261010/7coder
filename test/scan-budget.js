// Original search functions, real private files/junctions, and counted IO.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'scan-budget' });
const source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
function context(name, overrides) {
  const cwd = S.freshCwd(name);
  const ctx = loadContext(source, cwd, overrides, { Buffer, SCAN_SKIP_DIRS: ['node_modules', '.git', 'dist', '.cache'] });
  vm.runInContext(cut('function globToRegex(', '// P2-3: heavy directories') +
    cut('function grepSearch(', '// Keep the handle until close') +
    'async function tool(name,args,cancelled=null) {\n' + cut("  if (name === 'glob_tool') {", "  if (name === 'list_dir') {") + '\n}', ctx);
  return { cwd, ctx };
}
(async () => {
  try {
    let { cwd, ctx } = context('中文 空格');
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'needle\r\nplain\nNEEDLE\n');
    check('explicit file path is searched', ctx.grepSearch('needle', 'file.txt', { skipHeavy: true }).includes('file.txt: matches'));
    check('complete file scan can honestly report no match', ctx.grepSearch('absent', 'file.txt', { skipHeavy: true }) === 'No matches for pattern: absent');
    check('missing input path is a structured tool error', (await ctx.tool('grep_tool', { path: 'missing', pattern: 'needle' })).status === 'error');
    fs.writeFileSync(path.join(cwd, 'binary.dat'), 'needle\0');
    fs.writeFileSync(path.join(cwd, 'big.dat'), Buffer.alloc(2 * 1024 * 1024 + 1));
    check('explicit binary input reports skipped rather than no match', ctx.grepSearch('needle', 'binary.dat', { skipHeavy: true }).includes('binary file skipped'));
    check('explicit oversized input reports its limit', ctx.grepSearch('needle', 'big.dat', { skipHeavy: true }).includes('2MiB limit'));
    fs.writeFileSync(path.join(cwd, 'lines.txt'), 'needle\n'.repeat(60));
    check('per-file match reporting remains bounded', ctx.grepSearch('needle', 'lines.txt', { skipHeavy: true }).includes('more matches in this file'));
    check('nested-quantifier rejection remains active', ctx.grepSearch('(a+)+$', 'file.txt', { skipHeavy: true }).startsWith('Tool error: grep pattern contains nested quantifiers'));
    const outside = S.freshCwd('outside'); fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle');
    fs.symlinkSync(outside, path.join(cwd, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => ctx.grepSearch('needle', 'outside/secret.txt', { skipHeavy: true }), /Security: Path traversal blocked/);
    check('explicit external junction path is refused by original sanitizer', true);

    let statCalls = 0;
    ({ cwd, ctx } = context('no-match', { statSync(file) { statCalls++; return fs.statSync(file); } }));
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(cwd, 'f' + i + '.txt'), 'plain');
    statCalls = 0;
    let found = ctx.recursiveReaddir('', '*.missing', { maxEntries: 3 });
    check('glob counts nonmatching files against actual visit budget', statCalls === 12 && found.length === 1 && found[0].includes('visit limit 12'));
    statCalls = 0;
    found = ctx.recursiveReaddir('', '*.txt', { maxEntries: 3 });
    check('glob match cap keeps existing sentinel and bounds IO', statCalls === 3 && found.length === 4 && found[3] === '[truncated at 3 entries]');
    check('internal no-opts traversal retains every file and no markers', ctx.recursiveReaddir().length === 20);
    statCalls = 0;
    let text = ctx.grepSearch('absent', '', { maxFiles: 100, maxVisited: 6 });
    check('grep nonmatches exhaust visit budget with bounded-read consistency stats and no false no-match', statCalls === 13 && text.includes('visit limit 6') && !text.startsWith('No matches'));
    text = ctx.grepSearch('plain', '', { maxFiles: 2 });
    check('grep successful file-count cap retains truncation marker', text.includes('truncated after 2 files scanned'));

    ({ cwd, ctx } = context('skips'));
    fs.mkdirSync(path.join(cwd, 'node_modules')); fs.writeFileSync(path.join(cwd, 'node_modules', 'hidden.txt'), 'needle');
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(cwd, 'b' + i + '.bin'), 'needle\0');
    text = ctx.grepSearch('needle', '', { skipHeavy: true, maxVisited: 4 });
    check('binary/skipped entries consume visit budget', text.includes('visit limit 4') && !text.includes(': matches'));
    check('heavy directories still excluded from glob', !ctx.recursiveReaddir('', '*.txt', { skipHeavy: true, maxEntries: 100 }).some(s => s.includes('hidden')));
    fs.mkdirSync(path.join(cwd, 'deep')); fs.writeFileSync(path.join(cwd, 'deep', 'deep.txt'), 'needle');
    check('glob depth cap is visible', ctx.recursiveReaddir('', '*.txt', { maxEntries: 100, maxDepth: 0 }).some(s => s.includes('depth limit 0')));
    check('grep depth cap is visible', ctx.grepSearch('absent', '', { skipHeavy: true, maxDepth: 0 }).includes('depth limit 0'));
    fs.symlinkSync(cwd, path.join(cwd, 'deep', 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
    check('internal junction cycle is visited once', ctx.grepSearch('needle', 'deep', { skipHeavy: true }).split('\n').filter(s => s.includes('deep.txt:')).length === 1);

    ({ cwd, ctx } = context('unreadable', {
      openSync(file, ...args) { if (path.basename(file) === 'denied.txt') throw Object.assign(Error('fixture ACL'), { code: 'EACCES' }); return fs.openSync(file, ...args); },
      opendirSync(file, ...args) { if (path.basename(file) === 'blocked') throw Object.assign(Error('fixture ACL'), { code: 'EACCES' }); return fs.opendirSync(file, ...args); },
      readdirSync(file, ...args) { if (path.basename(file) === 'blocked') throw Object.assign(Error('fixture ACL'), { code: 'EACCES' }); return fs.readdirSync(file, ...args); }
    }));
    fs.writeFileSync(path.join(cwd, 'denied.txt'), 'needle'); fs.mkdirSync(path.join(cwd, 'blocked'));
    check('unreadable file includes errno and never says no-match', ctx.grepSearch('needle', 'denied.txt', { skipHeavy: true }).includes('unreadable file (EACCES)'));
    check('unreadable directory is visible to glob and grep', ctx.recursiveReaddir('blocked', '*', { maxEntries: 10 })[0].includes('EACCES') && ctx.grepSearch('needle', 'blocked', { skipHeavy: true }).includes('EACCES'));
    check('missing glob directory is not reported as empty', ctx.recursiveReaddir('missing', '*', { maxEntries: 10 })[0].includes('ENOENT'));
    console.log('SCAN/BUDGET ' + checks + '/' + checks);
  } finally { S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
