// Windows roots use a virtual filesystem mapped only into this suite's private
// directory: no drive root or remote UNC share is written during validation.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'path-boundaries' });
const source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
function virtualRoot(root, name) {
  const actual = S.freshCwd(name), wp = path.win32;
  const mapped = file => {
    if (typeof file !== 'string') return file;
    const rel = wp.relative(root, wp.resolve(file));
    if (wp.isAbsolute(rel) || rel === '..' || rel.startsWith('..\\')) throw Object.assign(Error('Virtual root escape'), { code: 'EPERM' });
    const target = path.resolve(actual, ...rel.split('\\').filter(Boolean));
    assert.ok(target === actual || target.startsWith(actual + path.sep), 'all backing IO stays in the private fixture');
    return target;
  };
  const overrides = {};
  for (const name of ['existsSync', 'lstatSync', 'statSync', 'mkdirSync', 'openSync', 'readFileSync', 'writeFileSync', 'unlinkSync', 'readdirSync']) {
    overrides[name] = (file, ...args) => fs[name](mapped(file), ...args);
  }
  overrides.renameSync = (from, to) => fs.renameSync(mapped(from), mapped(to));
  overrides.realpathSync = file => {
    const real = fs.realpathSync(mapped(file)), rel = path.relative(actual, real);
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) return wp.resolve(root, rel.split(path.sep).join('\\'));
    return real; // external junction remains outside the virtual workspace
  };
  const ctx = loadContext(source, root, overrides, { Buffer, require, path: wp, appDir: wp.join(root, 'app'),
    process: { platform: 'win32', pid: process.pid, env: process.env }, DANGER_MODE: false, workflowStepDepth: 0,
    effectivePermissionMode: () => 'default', console: { log() {}, warn() {}, error() {} },
    getToolMetadata: () => ({ autoSafe: false, risk: 'MEDIUM', explain: () => 'fixture' }),
    askApproval: async () => false, isSuperDangerous: () => false });
  vm.runInContext(cut('const PROTECTED_FILES =', 'function loadPermRules()') +
    cut('function permRuleArgText(', '// Quotes a token') +
    cut('async function safeExecuteToolInner(', '// ====================== APPROVAL') +
    'async function executeToolRaw(name,args) {\n' + cut("  if (name === 'write_file') {", "  if (name === 'append_file') {") + '\n}' +
    'this.rules=permRules;', ctx);
  return { ctx, actual, mapped, root };
}
const text = result => typeof result === 'string' ? result : result.text;
(async () => {
  try {
    const ctx = vm.createContext({ path: path.win32, process: { platform: 'win32' } });
    vm.runInContext(cut('function isInsideDir(', '// Resolves symlinks/junctions'), ctx);
    const cases = [
      ['drive root child', 'C:\\', 'C:\\folder\\file.txt', true], ['drive equality', 'C:\\', 'c:\\', true],
      ['other drive', 'C:\\', 'D:\\file.txt', false], ['case difference', 'C:\\Work', 'c:\\work\\file.txt', true],
      ['prefix collision', 'C:\\work', 'C:\\workspace\\file.txt', false], ['parent escape', 'C:\\work', 'C:\\other.txt', false],
      ['UNC share root', '\\\\server\\share\\', '\\\\server\\share\\folder\\file.txt', true],
      ['UNC case', '\\\\SERVER\\SHARE\\', '\\\\server\\share\\file.txt', true],
      ['other share', '\\\\server\\share\\', '\\\\server\\other\\file.txt', false],
      ['other server', '\\\\server\\share\\', '\\\\different\\share\\file.txt', false]
    ];
    for (const [label, base, target, expected] of cases) check(label + ' containment', ctx.isInsideDir(base, target) === expected);
    const posix = vm.createContext({ path: path.posix, process: { platform: 'linux' } });
    vm.runInContext(cut('function isInsideDir(', '// Resolves symlinks/junctions'), posix);
    check('POSIX root works while case sensitivity and sibling rejection remain', posix.isInsideDir('/', '/tmp/file') && !posix.isInsideDir('/Work', '/work/file') && !posix.isInsideDir('/work', '/workspace'));

    for (const [root, name] of [['Z:\\', 'virtual-drive'], ['\\\\server\\share\\', 'virtual-unc']]) {
      const f = virtualRoot(root, name), c = f.ctx, wp = path.win32;
      const state = c.internalStatePath('.7coder', 'todos.json');
      c.writeStateFile(state, JSON.stringify({ items: [] }), c.parseTodoState);
      c.writeStateFile(state, JSON.stringify({ items: [{ id: 't1', title: 'root test', status: 'pending' }] }), c.parseTodoState);
      check(name + ': real backing state IO and previous-version writes work at a root workspace', c.readStateRecord(state, c.parseTodoState).value.items[0].title === 'root test' && fs.existsSync(f.mapped(state + '.7coder-prev')));
      const call = (file, value = 'MEMORY_OK') => c.safeExecuteToolInner({ function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: value }) } }, [], null, null, {});
      const note = '.7coder\\memory\\notes.md';
      const written = await call(note);
      check(name + ': backslash memory note auto-writes in default mode without approval', written.status === 'ok' && fs.readFileSync(f.mapped(wp.join(root, note)), 'utf8') === 'MEMORY_OK');
      check(name + ': ordinary source writes still require approval', text(await call('source.txt')).includes('declined') && !fs.existsSync(f.mapped(wp.join(root, 'source.txt'))));
      c.rules.deny.push(c.compilePermRule('write_file(.7coder/memory/blocked.md)', 'deny'));
      check(name + ': user deny wins over memory auto-safe on backslash input', text(await call('.7coder\\memory\\blocked.md')).includes('BLOCKED by user permission rule'));
      c.rules.protectedExtra.push({ argRe: /^\.7coder\/memory\/protected\.md$/i }); c.effectivePermissionMode = () => 'bypass';
      check(name + ': protected-extra wins in bypass mode', text(await call('.7coder\\memory\\protected.md')).includes('BLOCKED: protected file'));
      c.effectivePermissionMode = () => 'denial';
      check(name + ': denial still blocks all memory writes', text(await call('.7coder\\memory\\denied.md')).includes('Permission mode = denial'));
      c.effectivePermissionMode = () => 'bypass';
      const outside = S.freshCwd(name + '-outside'), link = f.mapped(wp.join(root, '.7coder', 'memory', 'link'));
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      const escaped = await call('.7coder\\memory\\link\\escape.md');
      check(name + ': real external junction remains fail-closed', escaped.status === 'error' && !fs.existsSync(path.join(outside, 'escape.md')));
    }
    console.log('PATH/BOUNDARIES ' + checks + '/' + checks + '; roots backed only by private temp files');
  } finally { S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
