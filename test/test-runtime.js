const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const S = require('./_shared').create({ suite: 'test-runtime' });
const source = fs.readFileSync(S.IDX, 'utf8'), native = [];
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
function context(cwd) {
  const calls = [], ctx = vm.createContext({ fs, path, Buffer, launchDir: cwd, process: { versions: { node: '13.14.0' }, execPath: S.NODE_BIN },
    console: { log() {} }, setTimeout, clearTimeout, setInterval, clearInterval, withUtf8Codepage: command => command,
    findOptionalExecutable: () => 'npm', quoteForShell: file => file,
    runCommandAsync: (spec, options) => { calls.push({ spec, options }); return { promise: Promise.resolve({ stdout: '1 passing', stderr: '', error: null, exitCode: 0 }) }; } });
  vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') +
    cut('async function awaitCommandCancellable(', '// ====================== PERSISTENT SHELL') +
    cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
    cut('function supportsBuiltinTestRunner(', "  if (name === 'run_tests_tool') {") +
    'async function run(args,cancelled) { const name="run_tests_tool";\n' +
    cut('function parseTestOutput(', '// ====================== DIAGNOSTICS FORMATTING') + '\n}', ctx);
  ctx.calls = calls; return ctx;
}
(async () => {
  try {
    const cwd = S.freshCwd('test 中文 空格'), ctx = context(cwd), file = path.join(cwd, 'project.test.js');
    fs.writeFileSync(file, 'require("fs").writeFileSync("MUST_NOT_RUN", "wrong runtime")');
    const versions = [['13.14.0', false], ['16.16.0', false], ['16.17.0', true], ['17.9.1', false], ['18.0.0', false], ['18.1.0', true], ['24.0.0', true], ['18.1.0-rc.1', false], ['invalid', false]];
    check('built-in test runner selection follows documented introduction versions', versions.every(([v, expected]) => ctx.supportsBuiltinTestRunner(v) === expected));
    const old = await ctx.run({});
    check('Node13 loose test files return a precise error without spawning', old.status === 'error' && old.text.includes('Node 13.14.0') && old.text.includes('explicit command') && ctx.calls.length === 0 && !fs.existsSync(path.join(cwd, 'MUST_NOT_RUN')));
    ctx.process.versions.node = '18.1.0'; ctx.process.execPath = 'C:\\随包 Runtime %!\\node.exe';
    const modern = await ctx.run({}), spec = ctx.calls[0].spec;
    check('supported runtime uses execFile argv and its own executable, independent of PATH/quoting', modern.status === 'ok' && spec.file === ctx.process.execPath && spec.args.join(' ') === '--test' && spec.cmd === undefined);

    ctx.process.versions.node = '13.14.0';
    const pkg = path.join(cwd, 'package.json');
    fs.writeFileSync(pkg, '\ufeff' + JSON.stringify({ scripts: { test: 'custom framework' } }));
    await ctx.run({});
    check('BOM package test script retains npm lifecycle priority over loose files', ctx.calls[1].spec.cmd === 'npm test --silent');
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: '' } }));
    check('empty npm script falls back to runtime-aware detection', (await ctx.run({})).text.includes('does not support --test') && ctx.calls.length === 2);
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: ['invalid'] } }));
    check('invalid test script type cannot trigger automatic execution', (await ctx.run({})).text.includes('must be a string') && ctx.calls.length === 2);
    fs.writeFileSync(pkg, '{broken');
    check('corrupt package configuration is diagnosed rather than silently bypassed', (await ctx.run({})).text.includes('cannot read/parse package.json') && ctx.calls.length === 2);
    await ctx.run({ command: 'custom explicit command' });
    check('explicit command is preserved even when autodetection configuration is invalid', ctx.calls[2].spec.cmd === 'custom explicit command');
    fs.unlinkSync(pkg); fs.unlinkSync(file); fs.mkdirSync(file);
    ctx.process.versions.node = '24.0.0';
    check('directory named test.js is not mistaken for a runnable file', (await ctx.run({})).text.includes('nothing to auto-detect') && ctx.calls.length === 3);
    fs.rmdirSync(file);

    const real = context(cwd), script = path.join(cwd, 'standalone 中文.js'), runDir = path.dirname(path.dirname(S.IDX));
    fs.writeFileSync(script, 'console.log("1 passing"); console.log("中文fixture");');
    real.child_process = { exec(cmd, options, done) {
      const env = Object.assign({}, process.env);
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
      env.PATH = '';
      const child = cp.exec(cmd, Object.assign({}, options, { env }), done);
      native.push(child); if (child.pid) fs.appendFileSync(path.join(runDir, 'owned-processes.tsv'), child.pid + '\t--7coder-test-owner=' + runDir + '\n'); return child;
    } };
    vm.runInContext(cut('function runCommandAsync(', 'async function awaitCommandCancellable('), real);
    const command = '"' + S.NODE_BIN + '" "' + script + '" --7coder-test-owner="' + runDir + '"';
    const result = await real.run({ command });
    check('real Node13 explicit command works with empty PATH and a Chinese/spaced script path', result.status === 'ok' && result.data.exitCode === 0 && result.data.passed === 1 && result.text.includes('中文fixture'));
    let cancelled;
    try { await real.run({ command }, () => true); } catch (error) { cancelled = error; }
    check('cancellation before runner dispatch starts no additional child', cancelled && cancelled.code === 'EXECUTION_CANCELLED' && native.length === 1);
    console.log('TEST/RUNTIME ' + checks + '/' + checks);
  } finally {
    for (const child of native) if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch (error) {} }
    S.cleanup();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
