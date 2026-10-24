// T22-18: exact process lifecycle, passive GUI policy, bounded repair, real
// owned Node/CMD fixtures. Never sends desktop input or invokes a real model.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const S = require('./_shared').create({ suite: 'debug-lifecycle' });
const source = fs.readFileSync(S.IDX, 'utf8'), contexts = [], nativeChildren = [];
let checks = 0;
const deadline = setTimeout(() => { console.error('DEBUG/LIFECYCLE deadline'); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundary: ' + from);
  return source.slice(start, end);
}
function childFixture() {
  const child = new EventEmitter();
  child.pid = 424242; child.exitCode = null; child.signalCode = null; child.kills = 0;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.kills++; process.nextTick(() => {
    child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM');
  }); return true; };
  return child;
}
function context(spawn, extra) {
  const ctx = vm.createContext(Object.assign({ Buffer, path, process: { platform: process.platform, execPath: S.NODE_BIN, env: process.env },
    setTimeout, clearTimeout, setInterval, clearInterval, EXECUTION_TIMEOUT_MS: 10000,
    console: { log() {}, warn() {}, error() {} }, launchDir: S.freshCwd('debug 中文 空格'),
    child_process: { spawn, execSync() { throw Error('numeric-PID cleanup or sync compilation is forbidden'); } },
    findBash: () => null, ENABLE_COMPUTER_USE: true, ENABLE_AUTO_DEBUG: true,
    findOptionalExecutable: () => null, findCSharpCompiler: () => 'fixture-csc.exe',
    persistentBashExecutable: value => value, persistentBashEnvironment: () => process.env,
    DEBUG_TEST_MINUTES: 3, autoDebugActive: false, systemPrompt: 'fixture', sanitizePath: String,
    quoteForShell: value => '"' + value + '"', executeToolRaw() { throw Error('desktop injection is forbidden'); }
  }, extra || {}));
  vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') +
    cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
    cut('async function runDebugCycle(', '// AST-R2: reason of the most recent auto-approval') +
    'async function debug(args,cancelled,modelContext) { const name="auto_debug_tool";\n' +
    cut("  if (name === 'auto_debug_tool') {", '  return `Unknown tool:') + '\n}', ctx);
  contexts.push(ctx); return ctx;
}
function close(child, code) { child.exitCode = code; child.emit('exit', code, null); child.emit('close', code, null); }
async function until(predicate, label) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
const cycle = over => Object.assign({ log: '', stdout: '', stderr: '', exitCode: 0, signal: null,
  stoppedByAgent: false, spawnFailed: false, cleanupFailed: false, outputExceeded: false, ioError: false }, over || {});
(async () => {
  try {
    let child = childFixture(), ctx = context(() => child);
    const silent = ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'cli', 1);
    close(child, 7);
    check('silent nonzero exit is observed immediately and never killed by saved PID', (await silent).exitCode === 7 && child.kills === 0);

    child = childFixture(); ctx = context(() => child);
    const gui = ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'gui', 1);
    close(child, 0);
    check('GUI observation is passive and does not claim validated desktop behavior', (await gui).log.includes('automatic desktop input disabled') && child.kills === 0);

    child = childFixture(); ctx = context(() => child);
    const control = ctx.createExecutionControl(10000), cancelling = ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'cli', 1, control);
    control.cancel('stop debug'); const stopped = await cancelling;
    check('cancellation stops direct child once and awaits close', stopped.stoppedByAgent && !stopped.cleanupFailed && child.kills === 1 && child.signalCode === 'SIGTERM');
    control.dispose();

    let starts = 0; ctx = context(() => { starts++; return childFixture(); });
    const pre = ctx.createExecutionControl(10000); pre.cancel('before spawn');
    let preError; try { await ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'cli', 1, pre); } catch (e) { preError = e; }
    check('pre-cancelled cycle does not spawn a process', preError && preError.code === 'EXECUTION_CANCELLED' && starts === 0); pre.dispose();

    ctx = context(() => { const c = new EventEmitter(); process.nextTick(() => c.emit('error', Error('EMFILE'))); return c; });
    const missing = await ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'cli', 1);
    check('Node13 spawn error without pid or stdio settles without uncaught error', missing.spawnFailed && missing.log.includes('EMFILE') && !missing.log.includes('[OK]'));
    ctx = context(() => { throw Error('synchronous spawn failure'); });
    check('synchronous spawn failure reports failure', (await ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'cli', 1)).spawnFailed);

    child = childFixture(); ctx = context(() => child, { setTimeout: (fn, ms) => setTimeout(fn, ms === 5000 ? 20 : ms) });
    const orphanPipe = ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'cli', 1);
    child.exitCode = 0; child.emit('exit', 0, null);
    const unclosed = await orphanPipe;
    check('exit without close is unknown and does not kill a potentially reused PID', unclosed.cleanupFailed && child.kills === 0 && unclosed.log.includes('result unknown'));

    child = childFixture(); ctx = context(() => child);
    const flooded = ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'cli', 1);
    child.stdout.write('x'.repeat(5 * 1024 * 1024)); child.stderr.write('y'.repeat(4 * 1024 * 1024));
    const capped = await flooded;
    check('combined stdout/stderr is bounded at capture and terminates observation', capped.outputExceeded && Buffer.byteLength(capped.stdout + capped.stderr) <= 8 * 1024 * 1024 && child.kills === 1);

    child = childFixture(); ctx = context(() => child);
    const pipe = ctx.runDebugCycle('fixture.exe', 'fixture.exe', 'cli', 1); child.stdout.emit('error', Error('EPIPE'));
    check('output pipe errors settle observation and stop child', (await pipe).ioError && child.kills === 1);

    ctx = context(() => { throw Error('unit branch must not spawn'); });
    ctx.ENABLE_AUTO_DEBUG = false;
    check('disabled debug is an explicit blocked result', (await ctx.debug({ path: 'fixture.js' })).status === 'blocked');
    ctx.ENABLE_AUTO_DEBUG = true;
    let rounds = 0, fixes = 0;
    ctx.runDebugCycle = async () => { rounds++; return cycle({ exitCode: 7 }); };
    ctx.processWithTools = async () => { fixes++; return 'repair attempted'; };
    const failed = await ctx.debug({ path: 'fixture.js' });
    check('silent failure after maximum repairs remains error rather than blanket success', failed.status === 'error' && failed.data.exitCode === 7 && rounds === 4 && fixes === 3 && !ctx.autoDebugActive);

    for (const flag of ['spawnFailed', 'cleanupFailed', 'outputExceeded', 'ioError']) {
      fixes = 0; ctx.runDebugCycle = async () => cycle({ [flag]: true });
      const result = await ctx.debug({ path: 'fixture.js' });
      check(flag + ' refuses automatic repair/relaunch of unknown result', result.status === 'error' && fixes === 0 && !ctx.autoDebugActive);
    }
    rounds = 0; let nested;
    ctx.runDebugCycle = async () => cycle({ exitCode: rounds++ === 0 ? 1 : 0 });
    ctx.processWithTools = async () => { nested = await ctx.debug({ path: 'nested.js' }); };
    const repaired = await ctx.debug({ path: 'fixture.js' });
    check('repair cannot recursively enter debug and outer guard restores on success', nested.status === 'error' && nested.text.includes('reentry') && repaired.status === 'ok' && rounds === 2 && !ctx.autoDebugActive);

    const fixerCancel = ctx.createExecutionControl(10000); rounds = 0;
    ctx.runDebugCycle = async () => { rounds++; return cycle({ exitCode: 1 }); };
    ctx.processWithTools = async () => { fixerCancel.cancel('cancel fixer'); return '[aborted]'; };
    const cancelled = await ctx.debug({ path: 'fixture.js' }, fixerCancel);
    check('fixer cancellation cannot start another process cycle', cancelled.status === 'cancelled' && rounds === 1 && !ctx.autoDebugActive); fixerCancel.dispose();

    let compiles = 0; rounds = 0;
    ctx.runCommandAsync = () => { compiles++; return {}; };
    ctx.awaitCommandCancellable = async () => ({ r: { error: null } });
    ctx.runDebugCycle = async () => cycle({ exitCode: rounds++ === 0 ? 1 : 0 });
    ctx.processWithTools = async () => 'source repaired';
    check('C# source is recompiled before retesting after repair', (await ctx.debug({ path: 'fixture.cs' })).status === 'ok' && compiles === 2 && rounds === 2);

    let selected, realChild, observedOutput = '';
    const real = context((command, args, opts) => {
      selected = command;
      const options = Object.assign({}, opts, { env: Object.assign({}, process.env, { PATH: '' }) });
      if (command === S.NODE_BIN) realChild = S.spawn(command, args, options);
      else {
        // Explicitly owned non-Node fixture: generated .cmd path, direct
        // handle, manifest and independent timeout. No global name kills.
        realChild = cp.spawn(command, args, options); nativeChildren.push(realChild);
        if (realChild.pid) fs.appendFileSync(S.manifest, realChild.pid + '\t' + args[args.length - 1] + '\n');
        const owned = realChild;
        const timer = setTimeout(() => { try { owned.kill(); } catch (e) {} }, 5000);
        owned.once('close', () => clearTimeout(timer));
      }
      if (realChild.stdout) realChild.stdout.on('data', d => { observedOutput += d.toString(); }); return realChild;
    });
    const script = path.join(real.launchDir, '脚本 空格.js');
    fs.writeFileSync(script, 'console.log("REAL_DEBUG_OUTPUT");process.exit(7);');
    const realExit = await real.runDebugCycle(script, script, 'cli', 0.05);
    check('real JS uses bundled executable without PATH Node and reports exit 7 on Chinese/space path', selected === S.NODE_BIN && realExit.exitCode === 7 && realExit.stdout.includes('REAL_DEBUG_OUTPUT') && !realExit.cleanupFailed);
    observedOutput = ''; fs.writeFileSync(script, 'console.log("READY_CANCEL");setInterval(function(){},1000);');
    const realToken = real.createExecutionControl(10000), realWait = real.runDebugCycle(script, script, 'cli', 1, realToken);
    await until(() => observedOutput.includes('READY_CANCEL'), 'real app ready'); realToken.cancel('cancel real app');
    const realStopped = await realWait;
    check('real debug cancellation observes direct child close before returning', realStopped.stoppedByAgent && !realStopped.cleanupFailed && (realChild.exitCode !== null || realChild.signalCode !== null)); realToken.dispose();
    if (process.platform === 'win32') {
      const batch = path.join(real.launchDir, '命令 空格.cmd'); fs.writeFileSync(batch, '@echo off\r\necho REAL_CMD_OUTPUT\r\nexit /b 0\r\n');
      const cmd = await real.runDebugCycle(batch, batch, 'cli', 0.05);
      check('real cmd script with Chinese/space path preserves quoting and exit status', cmd.exitCode === 0 && cmd.stdout.includes('REAL_CMD_OUTPUT') && !cmd.spawnFailed);
    }
    console.log('DEBUG/LIFECYCLE ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline);
    for (const ctx of contexts) for (const token of Array.from(ctx.createExecutionControl.active || [])) { token.cancel('fixture cleanup'); token.dispose(); }
    for (const child of nativeChildren) if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch (e) {} }
    S.cleanup();
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
