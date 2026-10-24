// T22-13: original state functions, real temporary files, injected IO failures,
// abrupt commit-boundary exits and actual HTTP/restart paths. No real model.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'state-store' });
const source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0;
const children = [];
const deadline = setTimeout(() => { console.error('STATE/STORE suite deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'source boundary: ' + from);
  return source.slice(a, b);
}
function context(cwd, overrides) {
  const warnings = [];
  const ctx = loadContext(source, cwd, overrides, { Buffer, require, appDir: path.dirname(S.IDX),
    console: { log() {}, warn: s => warnings.push(String(s)), error: s => warnings.push(String(s)) },
    permRules: { protectedExtra: [] }, MEMORY_MAX_FILES: 100,
    makeToolResult: (status, text) => ({ status, text }), messages: [{ role: 'system', content: 'fixture' }] });
  vm.runInContext(cut('const PROTECTED_FILES =', '// ====================== USER PERMISSION RULES') +
    cut('const TODO_STATUSES =', '// ====================== TOOL EXECUTION') +
    cut('function memoryTopicValid(', '// keyword-overlap score') +
    cut('function sessionFilePath()', 'async function summarizeAction(') +
    cut('const LOG_START =', '// ====================== CORE EXECUTION') +
    cut('  function writeWorkspaceEnv(', '  function hUi(') +
    'async function invoke(name,args,cancelled=null) {\n' +
    cut("  if (name === 'read_file') {", "  if (name === 'agent_tool') {") +
    cut("  if (name === 'todo_write_tool') {", "  if (name === 'memory_tool') {") + '\n}', ctx);
  ctx.warnings = warnings;
  return ctx;
}
const todo = title => ({ items: [{ id: 't1', title, status: 'pending', updated: 'fixture' }] });
const old = '\uFEFF' + JSON.stringify(todo('旧版 中文😀'));
const older = JSON.stringify(todo('更早版本'));
const next = JSON.stringify(todo('新版本'));
const same = (file, bytes) => fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
function fixture(name, initial = old) {
  const cwd = S.freshCwd(name), file = path.join(cwd, '.7coder', 'todos.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (initial !== null) fs.writeFileSync(file, initial);
  return { cwd, file };
}
function evidence(file) { return fs.readdirSync(path.dirname(file)).filter(n => n.startsWith(path.basename(file) + '.7coder-corrupt-')); }
function error(code) { return Object.assign(Error('injected ' + code), { code }); }
async function bounded(promise, ms = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function unit() {
  const f = fixture('中文 空格'), ctx = context(f.cwd);
  ctx.writeStateFile(f.file, next, ctx.parseTodoState);
  check('replace publishes complete new JSON and byte-exact BOM/Unicode previous version', same(f.file, next) && same(f.file + '.7coder-prev', old));
  ctx.writeStateFile(f.file, next, ctx.parseTodoState);
  check('saving identical state does not discard the last distinct version', same(f.file + '.7coder-prev', old));
  check('successful commit leaves no owned staging files', !fs.readdirSync(path.dirname(f.file)).some(n => n.includes('.7coder-tmp-')));
  assert.throws(() => ctx.writeStateFile(f.file, '{invalid', ctx.parseTodoState), /invalid JSON/);
  check('proposed invalid JSON is rejected before changing primary or previous', same(f.file, next) && same(f.file + '.7coder-prev', old));
  const empty = fixture('new-store', null), emptyCtx = context(empty.cwd);
  check('only absent primary and absent previous means an empty todo list', emptyCtx.loadTodos().length === 0);
  emptyCtx.saveTodos(todo('first').items);
  check('first save creates a complete state without a fabricated previous version', same(empty.file, JSON.stringify(todo('first'), null, 2)) && !fs.existsSync(empty.file + '.7coder-prev'));

  for (const [phase, op, code] of [
    ['primary', 'open', 'EACCES'], ['previous', 'write', 'ENOSPC'], ['primary', 'write', 'ENOSPC'],
    ['previous', 'fsync', 'EIO'], ['primary', 'fsync', 'EIO'],
    ['primary', 'close', 'EIO'], ['previous', 'rename', 'EBUSY'], ['primary', 'rename', 'EPERM']
  ]) {
    const x = fixture(phase + '-' + op), descriptors = new Map();
    fs.writeFileSync(x.file + '.7coder-prev', older);
    let injected = false, originalUnlinked = false;
    const target = p => String(p).startsWith(x.file + (phase === 'previous' ? '.7coder-prev.7coder-tmp-' : '.7coder-tmp-'));
    const inject = p => !injected && target(p);
    const failCtx = context(x.cwd, {
      openSync(p, flags, mode) {
        if (op === 'open' && inject(p)) { injected = true; throw error(code); }
        const fd = fs.openSync(p, flags, mode); descriptors.set(fd, p); return fd;
      },
      writeFileSync(fd, bytes, options) {
        if (op === 'write' && inject(descriptors.get(fd))) {
          injected = true; fs.writeFileSync(fd, bytes.slice(0, 5)); throw error(code);
        }
        return fs.writeFileSync(fd, bytes, options);
      },
      fsyncSync(fd) { if (op === 'fsync' && inject(descriptors.get(fd))) { injected = true; throw error(code); } return fs.fsyncSync(fd); },
      closeSync(fd) { if (op === 'close' && inject(descriptors.get(fd))) { injected = true; throw error(code); } return fs.closeSync(fd); },
      renameSync(a, b) { if (op === 'rename' && inject(a)) { injected = true; throw error(code); } return fs.renameSync(a, b); },
      unlinkSync(p) { if (p === x.file) originalUnlinked = true; return fs.unlinkSync(p); }
    });
    assert.throws(() => failCtx.writeStateFile(x.file, next, failCtx.parseTodoState));
    check(phase + ' ' + op + ' ' + code + ': old primary survives without unlink; previous is complete',
      injected && !originalUnlinked && same(x.file, old) && (same(x.file + '.7coder-prev', old) || same(x.file + '.7coder-prev', older)));
    check(phase + ' ' + op + ': incomplete staging cannot appear as committed state', !fs.readdirSync(path.dirname(x.file)).some(n => n.includes('.7coder-tmp-')));
  }
  const lost = fixture('corrupt-primary', '{bad-json'), lostCtx = context(lost.cwd);
  fs.writeFileSync(lost.file + '.7coder-prev', old);
  check('corrupt primary restores validated previous version with exact evidence and warning', lostCtx.loadTodos()[0].title === '旧版 中文😀' && same(lost.file, old) &&
    same(path.join(path.dirname(lost.file), evidence(lost.file)[0]), '{bad-json') && lostCtx.warnings.some(s => s.includes('restored')));
  lostCtx.loadTodos();
  check('re-reading recovered state creates no duplicate corruption evidence', evidence(lost.file).length === 1 && same(lost.file + '.7coder-prev', old));
  const bad = fixture('no-backup', '{unrecoverable'), badCtx = context(bad.cwd);
  assert.throws(() => badCtx.loadTodos(), /repair before retrying/);
  assert.throws(() => badCtx.saveTodos(todo('must not overwrite').items), /repair before retrying/);
  check('unrecoverable JSON is never treated as empty or overwritten by the next save', same(bad.file, '{unrecoverable') && evidence(bad.file).length === 1);
  const malformed = fixture('invalid-schema', '{"items":[null]}'), malformedCtx = context(malformed.cwd);
  assert.throws(() => malformedCtx.loadTodos(), /repair before retrying/);
  check('valid JSON with invalid item schema is preserved rather than filtered away', same(malformed.file, '{"items":[null]}') && evidence(malformed.file).length === 1);
  const both = fixture('both-corrupt', '{bad'), bothCtx = context(both.cwd);
  fs.writeFileSync(both.file + '.7coder-prev', '{also-bad');
  assert.throws(() => bothCtx.loadTodos(), /also invalid/);
  check('invalid previous version cannot overwrite primary or silently reset data', same(both.file, '{bad') && same(both.file + '.7coder-prev', '{also-bad') && evidence(both.file + '.7coder-prev').length === 1);
  const archive = fixture('archive-failure', '{invalid'), archiveCtx = context(archive.cwd, {
    openSync(p, flags, mode) { if (String(p).includes('.7coder-corrupt-')) throw error('ENOSPC'); return fs.openSync(p, flags, mode); }
  });
  fs.writeFileSync(archive.file + '.7coder-prev', old);
  assert.throws(() => archiveCtx.loadTodos(), /ENOSPC/);
  check('failed evidence preservation blocks recovery rather than erasing corrupt primary', same(archive.file, '{invalid') && same(archive.file + '.7coder-prev', old));
  const denied = fixture('unreadable'), deniedCtx = context(denied.cwd, { readFileSync(p, enc) { if (p === denied.file) throw error('EACCES'); return fs.readFileSync(p, enc); } });
  fs.writeFileSync(denied.file + '.7coder-prev', older);
  assert.throws(() => deniedCtx.loadTodos(), /EACCES/);
  check('permission error is not misclassified as corruption or replaced by older data', same(denied.file, old) && evidence(denied.file).length === 0);
  const missing = fixture('missing-primary', null), missingCtx = context(missing.cwd);
  fs.writeFileSync(missing.file + '.7coder-prev', old);
  check('missing primary with valid previous is restored rather than reset', missingCtx.loadTodos()[0].title === '旧版 中文😀' && same(missing.file, old));
  missingCtx.deleteStateFile(missing.file);
  check('explicit deletion removes previous too and cannot resurrect on read', missingCtx.readStateRecord(missing.file, missingCtx.parseTodoState) === null);
  const unreadablePrevious = fixture('previous-guard'), guardCtx = context(unreadablePrevious.cwd);
  fs.mkdirSync(unreadablePrevious.file + '.7coder-prev');
  assert.throws(() => guardCtx.saveTodos(todo('blocked').items), /regular file/);
  check('non-file previous target fails closed before replacing the primary', same(unreadablePrevious.file, old));
  const outside = S.freshCwd('outside'), linked = S.freshCwd('junction');
  fs.symlinkSync(outside, path.join(linked, '.7coder'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => context(linked).saveTodos(todo('blocked').items), /outside/);
  check('existing junction/real-path gate still rejects out-of-workspace state', fs.readdirSync(outside).length === 0);

  const notes = S.freshCwd('memory-worklog'), notesCtx = context(notes);
  notesCtx.saveMemoryFile('topic', '原始记忆😀'); notesCtx.saveMemoryFile('topic', '新记忆');
  const note = path.join(notes, '.7coder', 'memory', 'topic.md');
  fs.writeFileSync(note, Buffer.from([0xD6, 0xD0]));
  check('legacy/binary memory bytes restore lossless previous text without destroying evidence', notesCtx.readMemoryFile('topic') === '原始记忆😀' && evidence(note).length === 1);
  notesCtx.updateCompleteSummary('first'); notesCtx.updateCompleteSummary('second');
  check('worklog preserves preceding complete version and newest summary', fs.readFileSync(path.join(notes, '7CODER.md'), 'utf8').includes('second') && fs.readFileSync(path.join(notes, '7CODER.md.7coder-prev'), 'utf8').includes('first'));
  const logFile = path.join(notes, '7CODER.md'), logBefore = fs.readFileSync(logFile);
  context(notes, { readFileSync(p, enc) { if (p === logFile) throw error('EACCES'); return fs.readFileSync(p, enc); } }).updateCompleteSummary('must-not-replace');
  check('unreadable existing worklog is not replaced with an empty-based new log', same(logFile, logBefore));
  const saved = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'remember 中文' }, { role: 'assistant', content: 'done', tool_calls: [{ id: 'stripped' }] }];
  notesCtx.messages = saved; notesCtx.saveSession();
  const session = path.join(notes, '.7coder', 'session.json');
  check('original CLI session writer uses reliable store and strips unpaired tool_calls', !JSON.parse(fs.readFileSync(session, 'utf8')).messages[2].tool_calls);
  notesCtx.messages = [{ role: 'system', content: 'new' }];
  check('original CLI session loader restores saved conversation', notesCtx.loadSession() && notesCtx.messages[1].content === 'remember 中文');
  for (const p of ['.env.7coder-prev', '.env.7coder-tmp-42-abcd', '.7coder/models.json.7coder-corrupt-' + 'a'.repeat(64), '.env.7coder-prev.7coder-corrupt-' + 'b'.repeat(64)]) {
    check('credential artifact inherits protected read/write: ' + p.split('/').pop().slice(0, 40), notesCtx.isProtectedTarget('write_file', { path: p }) && notesCtx.isProtectedTarget('read_file', { path: p }));
  }
  notesCtx.permRules.protectedExtra.push({ argRe: /^custom\.md$/i });
  check('user protected_extra also applies to the original path of a companion', notesCtx.isProtectedTarget('write_file', { path: 'custom.md.7coder-prev' }));
  const envFile = path.join(notes, '.env');
  fs.writeFileSync(envFile, '# keep\r\nCUSTOM="first\\nsecond"\r\n HEAVY_MODEL = old\r\n');
  notesCtx.writeWorkspaceEnv({ HEAVY_MODEL: 'new', OPENAI_API_KEY: ' "fixture quoted" ' });
  const envText = fs.readFileSync(envFile, 'utf8');
  check('settings survive dotenv8 restart exactly while preserving unrelated values/comments', require('dotenv').parse(envText).OPENAI_API_KEY === ' "fixture quoted" ' && require('dotenv').parse(envText).HEAVY_MODEL === 'new' && envText.includes('CUSTOM="first\\nsecond"') && same(envFile + '.7coder-prev', '# keep\r\nCUSTOM="first\\nsecond"\r\n HEAVY_MODEL = old\r\n'));
  const result = await notesCtx.invoke('write_file', { path: '.7coder/todos.json', content: next });
  const refused = await notesCtx.invoke('append_file', { path: '.7coder/todos.json', content: 'not JSON' });
  check('generic writers route managed JSON through validation/replace and reject invalid append', result.text.startsWith('Written:') && refused.text.startsWith('Append error:') && same(path.join(notes, '.7coder', 'todos.json'), next));
}

function gitArtifacts() {
  const cwd = S.freshCwd('git-artifacts'); fs.mkdirSync(path.join(cwd, 'nested')); fs.mkdirSync(path.join(cwd, '.7coder'));
  for (const name of ['visible.txt', '.env.7coder-prev', 'nested/keys.json.7coder-prev', '.7coder/models.json']) fs.writeFileSync(path.join(cwd, name), 'fixture');
  const matched = source.match(/if \(args.stage_all !== false\) git\((\[[^\n]+\])\);/);
  assert.ok(matched, 'original stage_all argv boundary');
  for (const argv of [['init'], JSON.parse(matched[1])]) {
    const r = S.spawnSync('git', argv, { cwd, encoding: 'utf8', timeout: 8000 }); assert.strictEqual(r.status, 0, r.stderr);
  }
  const staged = S.spawnSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8', timeout: 8000 });
  check('original Git stage_all argv excludes root/nested state artifacts without workspace ignore rules', staged.status === 0 && staged.stdout.trim() === 'visible.txt');
}

function abruptExits() {
  const script = path.join(S.runDir, 'commit-boundary.js');
  fs.writeFileSync(script, `const fs=require('fs'),path=require('path');
const {loadContext}=require(${JSON.stringify(path.join(__dirname, 'download-commit.js'))});
const [idx,cwd,phase]=process.argv.slice(2), file=path.join(cwd,'.7coder','todos.json');
const ctx=loadContext(fs.readFileSync(idx,'utf8'),cwd,{renameSync(a,b){
  if(phase==='before-primary'&&b===file)process.exit(73);
  fs.renameSync(a,b);
  if((phase==='after-primary'&&b===file)||(phase==='after-previous'&&b===file+'.7coder-prev'))process.exit(73);
}},{Buffer,require,appDir:path.dirname(idx)});
ctx.writeStateFile(file,${JSON.stringify(next)},ctx.parseTodoState);process.exit(74);
`);
  for (const phase of ['after-previous', 'before-primary', 'after-primary']) {
    const f = fixture('abrupt-' + phase);
    const r = S.spawnSync(S.NODE_BIN, [script, S.IDX, f.cwd, phase], { timeout: 8000, encoding: 'utf8' });
    assert.strictEqual(r.status, 73, r.stderr || 'did not reach commit boundary');
    const reopened = context(f.cwd).loadTodos();
    check('new process after abrupt ' + phase + ' reads a complete committed version', reopened[0].title === (phase === 'after-primary' ? '新版本' : '旧版 中文😀') && same(f.file + '.7coder-prev', old));
  }
}
async function backend(cwd) {
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const child = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, {
    HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', OPENAI_API_KEY: 'fixture-key',
    OPENAI_ENDPOINT: 'http://127.0.0.1:1/v1', HEAVY_MODEL: 'fixture-model', DREAM_ALLOW: 'false'
  }) });
  children.push(child);
  let output = '';
  await bounded(new Promise((resolve, reject) => {
    const collect = d => { output += d.toString(); if (output.includes('endpoint ready at')) resolve(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', reject); child.once('exit', code => reject(Error('backend exited ' + code + ': ' + output)));
  }));
  return { child, output: () => output, api: (method, url, data = null) => bounded(S.httpReq(port, method, url, data)) };
}
async function integration() {
  const f = fixture('native-HTTP', '{broken'), stateDir = path.dirname(f.file);
  const app = await backend(f.cwd);
  const invalidTodos = await app.api('GET', '/api/todos');
  check('unrecoverable todos returns HTTP500 while /api/info remains live', invalidTodos.status === 500 && (await app.api('GET', '/api/info')).status === 200 && same(f.file, '{broken'));
  fs.writeFileSync(f.file + '.7coder-prev', old);
  const restoredTodos = await app.api('GET', '/api/todos');
  check('actual HTTP todos recovers previous JSON and retains invalid evidence', restoredTodos.status === 200 && JSON.parse(restoredTodos.body).todos[0].title === '旧版 中文😀' && evidence(f.file).length === 1);
  const env = path.join(f.cwd, '.env');
  const first = await app.api('POST', '/api/settings', { model: 'fixture-first' });
  const envFirst = fs.readFileSync(env);
  const second = await app.api('POST', '/api/settings', { model: 'fixture-second' });
  check('HTTP settings commit then update runtime with complete previous .env', first.status === 200 && second.status === 200 && JSON.parse((await app.api('GET', '/api/info')).body).model === 'fixture-second' && same(env + '.7coder-prev', envFirst));
  fs.unlinkSync(env + '.7coder-prev'); fs.mkdirSync(env + '.7coder-prev');
  const before = fs.readFileSync(env), fail = await app.api('POST', '/api/settings', { model: 'must-not-apply' });
  check('settings persistence failure leaves runtime and on-disk configuration unchanged', fail.status === 500 && same(env, before) && JSON.parse((await app.api('GET', '/api/info')).body).model === 'fixture-second');
  fs.rmdirSync(env + '.7coder-prev');
  const profiles = { fixture: { endpoint: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only-key' } };
  const profilePost = await app.api('POST', '/api/models-config', { profiles });
  const modelFile = path.join(stateDir, 'models.json');
  fs.mkdirSync(modelFile + '.7coder-prev');
  const profileFail = await app.api('POST', '/api/models-config', { profiles: {} });
  check('failed model-profile replacement preserves current runtime routes and bytes', profilePost.status === 200 && profileFail.status === 400 && JSON.parse((await app.api('GET', '/api/models-config')).body).profiles.fixture.apiKey === 'fixture-only-key' && JSON.parse(fs.readFileSync(modelFile, 'utf8')).fixture);
  fs.rmdirSync(modelFile + '.7coder-prev');
  const save1 = await app.api('POST', '/api/sessions/save', { messages: [{ role: 'user', content: 'original 中文' }] });
  const name = JSON.parse(save1.body).file, saved = path.join(stateDir, 'sessions', name), savedBytes = fs.readFileSync(saved);
  const save2 = await app.api('POST', '/api/sessions/save', { file: name, messages: [{ role: 'user', content: 'newer' }] });
  fs.writeFileSync(saved, '{bad-session');
  const loaded = await app.api('POST', '/api/sessions/load', { file: name });
  check('actual web session overwrite and corrupt-load recover byte-exact previous record', save1.status === 200 && save2.status === 200 && loaded.status === 200 && JSON.parse(loaded.body).messages[0].content === 'original 中文' && same(saved, savedBytes) && evidence(saved).length === 1);
  const deleted = await app.api('POST', '/api/sessions/delete', { file: name });
  check('deleted web session cannot be resurrected from previous version', deleted.status === 200 && !fs.existsSync(saved + '.7coder-prev') && (await app.api('POST', '/api/sessions/load', { file: name })).status === 400);

  // A separate startup validates recovery before the server announces ready.
  const restart = fixture('startup-recovery', null), models = path.join(path.dirname(restart.file), 'models.json');
  fs.writeFileSync(models, '{broken-profile'); fs.writeFileSync(models + '.7coder-prev', JSON.stringify(profiles));
  const envRestart = path.join(restart.cwd, '.env');
  fs.writeFileSync(envRestart, Buffer.from([0xFF])); fs.writeFileSync(envRestart + '.7coder-prev', 'HEAVY_MODEL=restored-fixture\n');
  const reopened = await backend(restart.cwd), info = JSON.parse((await reopened.api('GET', '/api/info')).body);
  check('second startup restores model profiles and non-UTF8 .env before reporting ready', info.model === 'restored-fixture' && info.models.includes('fixture') && evidence(models).length === 1 && evidence(envRestart).length === 1 && reopened.output().includes('[STATE] restored'));
  const unusable = fixture('startup-fail', null), unusableModels = path.join(path.dirname(unusable.file), 'models.json');
  fs.writeFileSync(unusableModels, '{"apiKey":"fixture-hidden-secret"');
  const failed = S.spawnSync(S.NODE_BIN, [S.IDX, '--server'], { cwd: unusable.cwd, encoding: 'utf8', timeout: 8000, env: Object.assign({}, process.env, { DREAM_ALLOW: 'false' }) });
  check('unrecoverable profile makes startup fail nonzero with no ready or secret excerpt', failed.status === 1 && failed.stderr.includes('model configuration load failed') && !failed.stdout.includes('endpoint ready') && !failed.stderr.includes('fixture-hidden-secret') && same(unusableModels, '{"apiKey":"fixture-hidden-secret"'));
  const repl = fixture('resume-restart', null), session = path.join(path.dirname(repl.file), 'session.json');
  fs.writeFileSync(session, '{interrupted');
  fs.writeFileSync(session + '.7coder-prev', JSON.stringify({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'remember-on-restart' }] }));
  const resumed = S.spawnSync(S.NODE_BIN, [S.IDX, '--resume'], { cwd: repl.cwd, encoding: 'utf8', input: '/bye\n', timeout: 8000,
    env: Object.assign({}, process.env, { ENABLE_HTTP_SERVER: 'false', DREAM_ALLOW: 'false', OPENAI_API_KEY: 'fixture-key' }) });
  check('actual --resume recovers interrupted session and exits normally on /bye', resumed.status === 0 && resumed.stdout.includes('Previous session resumed') && evidence(session).length === 1 && JSON.parse(fs.readFileSync(session, 'utf8')).messages[1].content === 'remember-on-restart');
}
(async () => {
  try {
    await unit(); gitArtifacts(); abruptExits(); await integration();
    console.log('STATE/STORE ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    clearTimeout(deadline); S.cleanup();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
