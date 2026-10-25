const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'audit-commit-budget' }), source = fs.readFileSync(S.IDX, 'utf8'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(name, overrides, extra) { const cwd = S.freshCwd(name), file = path.join(cwd, '.7coder', 'audit.jsonl'), warnings = []; fs.mkdirSync(path.dirname(file));
  const c = loadContext(source, cwd, overrides, Object.assign({ Buffer, appDir: path.dirname(S.IDX), TOOL_METADATA: { read_file: {}, write_file: {}, git_status_tool: {}, sleep_tool: {} }, console: { warn: s => warnings.push(s) } }, extra));
  vm.runInContext(cut('function runtimeText(', 'function recordRuntimeEvent(') + cut('function auditCommitMessage(', 'function git(argsArr, opts)'), c); return { cwd, file, c, warnings }; }
const record = tool => JSON.stringify({ type: 'tool', tool }) + '\n';
try {
  let f = context('normal'); check('missing log retains no-activity message without creating a file', f.c.auditCommitMessage() === 'chore: session changes (no tool activity)' && !fs.existsSync(f.file));
  fs.writeFileSync(f.file, record('read_file') + record('write_file') + record('read_file') + record('git_status_tool') + record('sleep_tool'));
  check('valid known tools retain frequency order and top-three hints', f.c.auditCommitMessage() === 'chore: session changes (tools: read_file, write_file, git_status_tool)');
  fs.writeFileSync(f.file, record('constructor') + record('__proto__') + record('read_file'));
  check('unknown and inherited property names cannot pollute counts', f.c.auditCommitMessage() === 'chore: session changes (tools: read_file; partial audit)');
  fs.writeFileSync(f.file, record('write_file') + '{bad}\n' + JSON.stringify({ type: 'tool', tool: 'read_file', text: 'x'.repeat(20000) }) + '\n' + JSON.stringify({ type: 'tool', tool: 'sleep_tool' }));
  check('invalid overlong and torn records are skipped and partial hints are explicit', f.c.auditCommitMessage() === 'chore: session changes (tools: write_file; partial audit)');
  let reads = 0, open = 0; f = context('huge', { openSync(...args) { const fd = fs.openSync(...args); open++; return fd; }, closeSync(fd) { fs.closeSync(fd); open--; }, readSync(...args) { reads++; return fs.readSync(...args); } });
  const fd = fs.openSync(f.file, 'w'); fs.ftruncateSync(fd, 100 * 1024 * 1024); fs.closeSync(fd); assert.throws(() => f.c.auditCommitMessage(), e => e.code === 'EFILETOOLARGE');
  check('100MiB audit hints fail before data reads and always close', reads === 0 && open === 0 && fs.statSync(f.file).size === 100 * 1024 * 1024);
  const before = reads; assert.throws(() => f.c.auditCommitMessage(() => true), e => e.code === 'EXECUTION_CANCELLED'); check('pre-cancelled hint collection performs no read', reads === before);
  let tick = 0; class Deadline extends Date { static now() { tick += 101; return tick; } } f = context('deadline', {}, { Date: Deadline }); fs.writeFileSync(f.file, record('read_file').repeat(20));
  check('parse CPU budget returns explicitly partial hints', f.c.auditCommitMessage().includes('partial audit'));
  class Frozen extends Date { static now() { return 1; } } f = context('line-count', {}, { Date: Frozen }); fs.writeFileSync(f.file, '\n'.repeat(50001) + record('read_file'));
  check('many tiny lines stop at a separate count ceiling without split arrays', f.c.auditCommitMessage() === 'chore: session changes (no tool activity; partial audit)');
  f = context('encoding'); fs.writeFileSync(f.file, Buffer.from([0xD6, 0xD0])); assert.throws(() => f.c.auditCommitMessage(), /encoding/); check('invalid UTF8 is not treated as trustworthy hint text', true);
  f = context('real-git'); const config = path.join(S.runDir, 'git-global-empty'); fs.writeFileSync(config, ''); const env = {};
  for (const key of Object.keys(process.env)) if (!/^GIT_/i.test(key)) env[key] = process.env[key]; Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0' });
  const git = argv => cp.execFileSync('git', argv, { cwd: f.cwd, env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  git(['init']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
  const tracked = path.join(f.cwd, 'tracked.txt'); fs.writeFileSync(tracked, 'initial'); git(['add', 'tracked.txt']); git(['commit', '-m', 'initial']);
  Object.assign(f.c, { git, inGitRepo: () => true, recordOwnedGitSnapshot: () => '' });
  vm.runInContext('function commit(args,cancelled){const name="git_commit_tool";' + cut("  if (name === 'git_commit_tool') {", "  if (name === 'synthetic_output_tool') {") + '}', f.c);
  fs.writeFileSync(f.file, record('write_file')); fs.writeFileSync(tracked, 'first change'); let committed = f.c.commit({});
  check('actual private Git commit uses valid audit hints and keeps internal audit untracked', committed.status === 'ok' && git(['log', '-1', '--format=%s']).trim() === 'chore: session changes (tools: write_file)' && !git(['ls-files']).includes('.7coder'));
  const huge = fs.openSync(f.file, 'w'); fs.ftruncateSync(huge, 100 * 1024 * 1024); fs.closeSync(huge); fs.writeFileSync(tracked, 'second change'); committed = f.c.commit({});
  check('unavailable hints still allow intended commit with bounded warning and source intact', committed.status === 'ok' && git(['log', '-1', '--format=%s']).trim() === 'chore: session changes' && f.warnings.some(s => s.includes('hints unavailable')) && fs.statSync(f.file).size === 100 * 1024 * 1024);
  const head = git(['rev-parse', 'HEAD']).trim(); fs.writeFileSync(tracked, 'must not commit after cancel'); assert.throws(() => f.c.commit({}, () => true), e => e.code === 'EXECUTION_CANCELLED');
  check('cancelled hint generation cannot fall through into a Git commit', git(['rev-parse', 'HEAD']).trim() === head);
  committed = f.c.commit({ message: 'explicit user message' }); check('explicit message bypasses broken hints without changing requested title', committed.status === 'ok' && git(['log', '-1', '--format=%s']).trim() === 'explicit user message');
  console.log('AUDIT/COMMIT/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0; snapshot helper stubbed, retention protocol not retested');
} finally { S.cleanup(); }
