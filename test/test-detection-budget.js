const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), { create } = require('./_endpoint'), S = require('./_shared').create({ suite: 'test-detection-budget' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set(); let checks = 0, H, server;
const deadline = setTimeout(() => { console.error('TEST/DETECTION/BUDGET deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(cwd, overrides) { const calls = [], c = loadContext(source, cwd, overrides, { Buffer, appDir: path.dirname(S.IDX), process: { versions: { node: '13.14.0' }, execPath: S.NODE_BIN }, console: { log() {} },
  findOptionalExecutable: () => 'private-npm', quoteForShell: s => s, withUtf8Codepage: s => s,
  runCommandAsync(spec) { calls.push(spec); return { promise: Promise.resolve({ stdout: '1 passing', stderr: '', error: null, exitCode: 0 }) }; } });
  vm.runInContext(cut('async function awaitCommandCancellable(', '// ====================== PERSISTENT SHELL') + 'async function run(args,cancelled){const name="run_tests_tool";' + cut('function parseTestOutput(', '// ====================== DIAGNOSTICS FORMATTING') + '}', c); c.calls = calls; return c; }
(async () => { try {
  const cwd = S.freshCwd('unit 中文 空格'), pkg = path.join(cwd, 'package.json'); let dataReads = 0, handles = 0;
  const c = context(cwd, { openSync(...args) { handles++; return fs.openSync(...args); }, closeSync(fd) { fs.closeSync(fd); handles--; }, readSync(...args) { dataReads++; return fs.readSync(...args); } });
  const fd = fs.openSync(pkg, 'w'); fs.ftruncateSync(fd, 100 * 1024 * 1024); fs.closeSync(fd); let result = await c.run({});
  check('oversized manifest fails before data read, discovery or execution and closes descriptor', result.status === 'error' && result.text.includes('cannot read/parse package.json') && result.text.includes('1048576') && c.calls.length === 0 && dataReads === 0 && handles === 0 && fs.statSync(pkg).size === 100 * 1024 * 1024);
  result = await c.run({ command: 'explicit framework' }); check('explicit command bypasses unavailable autodetection metadata', result.status === 'ok' && c.calls[0].cmd === 'explicit framework' && dataReads === 0);
  for (const [label, content] of [['root', '[]'], ['null', 'null'], ['scripts', '{"scripts":[]}'], ['scripts-null', '{"scripts":null}'], ['type', '{"scripts":{"test":3}}'], ['gbk', Buffer.from([0xD6, 0xD0])]]) {
    fs.writeFileSync(pkg, content); const before = c.calls.length; result = await c.run({}); check('invalid ' + label + ' manifest cannot select a fallback test runner', result.status === 'error' && c.calls.length === before && handles === 0);
  }
  const prefix = '\uFEFF{"scripts":{"test":"fixture framework"}}'; fs.writeFileSync(pkg, prefix + ' '.repeat(1024 * 1024 - Buffer.byteLength(prefix)));
  result = await c.run({}); check('exact 1MiB UTF8/BOM manifest preserves npm script priority', result.status === 'ok' && c.calls[c.calls.length - 1].cmd === 'private-npm test --silent');
  fs.unlinkSync(pkg); let reads = 0, closed = 0; const many = context(cwd, { readdirSync() { throw Error('whole-directory read forbidden'); }, opendirSync() { let index = 0; return { readSync() { reads++; return { name: 'not-test-' + index++, isFile: () => true }; }, closeSync() { closed++; } }; } });
  result = await many.run({}); check('incomplete loose-file discovery is explicit failure after 1001 bounded reads', result.status === 'error' && result.text.includes('discovery incomplete') && result.text.includes('explicit command') && many.calls.length === 0 && reads === 1001 && closed === 1);
  fs.writeFileSync(path.join(cwd, 'real.test.js'), 'throw Error("must not run on Node13")'); let visits = 0;
  const found = context(cwd, { opendirSync() { let n = 0; return { readSync() { visits++; return { name: n++ ? 'other-' + n : 'real.test.js', isFile: () => true }; }, closeSync() {} }; } });
  result = await found.run({}); check('observed loose test still reports precise unsupported Node13 even in large directory', result.status === 'error' && result.text.includes('does not support --test') && found.calls.length === 0 && visits === 1001);
  found.process.versions.node = '18.1.0'; result = await found.run({}); check('supported-runtime decision uses captured execFile argv without executing a modern runtime here', result.status === 'ok' && found.calls[0].file === S.NODE_BIN && found.calls[0].args[0] === '--test');
  const before = dataReads; await assert.rejects(c.run({}, () => true), e => e.code === 'EXECUTION_CANCELLED'); check('pre-cancelled detection reads no configuration and creates no process', dataReads === before);
  const real = S.freshCwd('actual'), manifest = path.join(real, 'package.json'), large = fs.openSync(manifest, 'w'); fs.ftruncateSync(large, 100 * 1024 * 1024); fs.closeSync(large); fs.writeFileSync(path.join(real, 'must-not.test.js'), 'require("fs").writeFileSync("MUST_NOT_RUN", "bad autodetect")');
  server = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { const body = JSON.parse(raw), hasTool = body.messages.some(m => m.role === 'tool'); const delta = hasTool ? { content: 'DETECTION_RECOVERED' } : { tool_calls: [{ index: 0, id: 'auto-rejected', type: 'function', function: { name: 'run_tests_tool', arguments: '{}' } }, { index: 1, id: 'explicit-ok', type: 'function', function: { name: 'run_tests_tool', arguments: JSON.stringify({ command: 'echo 1 passing' }) } }] }; res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n'); }); });
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  H = create({ suite: 'test-detection-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: '', model: 'fixture', permissionMode: 'bypass' }); await H.start(real);
  const chat = await H.chat([{ role: 'user', content: 'Detect framework and run explicit fallback' }], 5000), done = chat.tools.filter(t => t.type === 'result');
  check('actual Agent returns error for automatic detection and completed explicit run with correct IDs', chat.content === 'DETECTION_RECOVERED' && done.some(t => t.callId === 'auto-rejected' && t.status === 'error' && t.result.includes('cannot read/parse package.json')) && done.some(t => t.callId === 'explicit-ok' && t.status === 'completed' && t.result.includes('1 passing')) && !fs.existsSync(path.join(real, 'MUST_NOT_RUN')) && fs.statSync(manifest).size === 100 * 1024 * 1024);
  const info = JSON.parse((await H.api('/api/info')).body); check('detection refusal leaves core and tool activity settled', info.runtime.activeTasks === 0 && info.runtime.activeTools === 0);
  console.log('TEST/DETECTION/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0');
} finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } for (const s of sockets) s.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
