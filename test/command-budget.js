const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'command-budget' });
const source = fs.readFileSync(S.IDX, 'utf8'), a = source.indexOf('function readWorkspaceCommand('), b = source.indexOf('// ====================== LIGHT/HEAVY CALLER', a);
assert.ok(a >= 0 && b > a); let checks = 0, child, closed = false, server; const sockets = new Set();
const deadline = setTimeout(() => { console.error('COMMAND/BUDGET deadline'); if (child && !closed) child.kill(); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(predicate, label) { const end = Date.now() + 6000; while (!predicate()) { if (Date.now() > end) throw Error('Timeout ' + label); await new Promise(r => setTimeout(r, 10)); } }
(async () => { try {
  const cwd = S.freshCwd('unit'), root = path.join(cwd, '.7coder', 'commands'); fs.mkdirSync(root, { recursive: true });
  const open = new Set(); let reads = 0;
  const c = loadContext(source, cwd, { openSync(...args) { const fd = fs.openSync(...args); open.add(fd); return fd; }, closeSync(fd) { fs.closeSync(fd); open.delete(fd); }, readSync(...args) { reads++; return fs.readSync(...args); } }, { Buffer, appDir: path.dirname(S.IDX) }); vm.runInContext(source.slice(a, b), c);
  check('only absent command returns the literal-input fallback sentinel', c.readWorkspaceCommand('absent') === null && open.size === 0);
  fs.writeFileSync(path.join(root, 'valid.md'), '\uFEFF  中文😀\r\nlast instruction\r\n');
  check('complete UTF8/BOM/CRLF command keeps final instructions and emoji', c.readWorkspaceCommand('valid') === '中文😀\r\nlast instruction' && open.size === 0);
  fs.writeFileSync(path.join(root, 'boundary.md'), 'x'.repeat(65536)); check('exact 64KiB command is admitted without truncation', c.readWorkspaceCommand('boundary').length === 65536);
  fs.writeFileSync(path.join(root, 'boundary.md'), '中'.repeat(21846)); assert.throws(() => c.readWorkspaceCommand('boundary'), e => e.code === 'EFILETOOLARGE');
  check('limit counts UTF8 bytes rather than JS characters', open.size === 0);
  const huge = path.join(root, 'huge.md'), fd = fs.openSync(huge, 'w'); fs.ftruncateSync(fd, 100 * 1024 * 1024); fs.closeSync(fd); const before = reads;
  assert.throws(() => c.readWorkspaceCommand('huge'), e => e.code === 'EFILETOOLARGE'); check('huge command performs zero data reads and closes its descriptor', reads === before && open.size === 0 && fs.statSync(huge).size === 100 * 1024 * 1024);
  for (const [name, bytes] of [['empty', ' \r\n\uFEFF'], ['gbk', Buffer.from([0xD6, 0xD0])], ['binary', Buffer.from([65, 0, 66])]]) { fs.writeFileSync(path.join(root, name + '.md'), bytes); assert.throws(() => c.readWorkspaceCommand(name), /empty|encoding|binary/); check(name + ' command fails explicitly instead of fallback or replacement decoding', open.size === 0); }
  const bad = loadContext(source, cwd, { openSync(file) { throw Object.assign(Error('fixture occupied'), { code: 'EACCES' }); } }, { Buffer, appDir: path.dirname(S.IDX) }); vm.runInContext(source.slice(a, b), bad);
  assert.throws(() => bad.readWorkspaceCommand('valid'), /occupied/); assert.throws(() => c.readWorkspaceCommand('../escape'), /Invalid/); check('read errors and traversal names are not missing-command fallbacks', true);
  const real = S.freshCwd('actual'), commands = path.join(real, '.7coder', 'commands'); fs.mkdirSync(commands, { recursive: true });
  fs.writeFileSync(path.join(commands, 'bad.md'), 'PARTIAL_COMMAND_MUST_NOT_RUN'.repeat(3000) + '\nFINAL_STOP_GUARD'); fs.writeFileSync(path.join(commands, 'empty.md'), ' \n');
  fs.writeFileSync(path.join(commands, 'gbk.md'), Buffer.from([0xD6, 0xD0])); const body = 'UTF8_BODY 中文😀\r\nFINAL_COMMAND_GUARD'; fs.writeFileSync(path.join(commands, 'valid.md'), body);
  const main = []; server = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { const request = JSON.parse(raw); let content = 'fixture summary'; if (request.tools) { main.push(request); content = 'COMMAND_TASK_' + main.length; }
    if (request.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n'); } else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })); }); });
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  let output = '', code = null; child = S.spawn(S.NODE_BIN, [S.IDX], { cwd: real, env: Object.assign({}, process.env, { OPENAI_API_KEY: 'fixture', OPENAI_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/v1', HEAVY_MODEL: 'fixture', LIGHT_MODEL: 'fixture', SUMMARY_MODEL: 'fixture', DREAM_ALLOW: 'false', ENABLE_HTTP_SERVER: 'false', ENABLE_RALPH_MODE: 'false', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1' }) });
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d); child.stdin.on('error', () => {}); child.once('close', value => { closed = true; code = value; });
  const wait = (predicate, label) => until(() => { if (closed && !predicate()) throw Error('early exit: ' + output); return predicate(); }, label);
  await wait(() => output.includes('Commands:'), 'REPL ready'); child.stdin.write('SAFE_DRAFT\n/bad\n/empty\n/gbk\n/execute-task-now\n');
  await wait(() => output.includes('COMMAND_TASK_1') && output.includes('[USAGE]'), 'first task'); const user = main[0].messages.filter(m => m.role === 'user').slice(-1)[0].content;
  check('real rejected commands never execute a truncated body or queue their slash names', user.includes('SAFE_DRAFT') && !/PARTIAL_COMMAND|FINAL_STOP_GUARD|\/bad|\/empty|\/gbk/.test(user));
  check('all three existing command failures report not queued', ['bad', 'empty', 'gbk'].every(name => output.includes('[CMD] ' + name + ' not queued:')));
  child.stdin.write('/valid\n/unknown\n/execute-task-now\n'); await wait(() => output.includes('COMMAND_TASK_2') && (output.match(/\[USAGE\]/g) || []).length === 2, 'second task');
  const next = main[1].messages.filter(m => m.role === 'user').slice(-1)[0].content;
  check('same REPL recovers with entire valid command and literal unknown command', next === body + '\n/unknown' && output.includes('[CMD] valid 展开为'));
  child.stdin.write('/bye\n'); await until(() => closed, 'close'); check('actual Agent exits cleanly with rejected source unchanged', code === 0 && fs.readFileSync(path.join(commands, 'bad.md'), 'utf8').endsWith('FINAL_STOP_GUARD'));
  console.log('COMMAND/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0');
} finally { clearTimeout(deadline); if (child && !closed) child.kill(); for (const s of sockets) s.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
