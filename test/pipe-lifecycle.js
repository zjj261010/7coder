// T22-12: original transports + real Node streams, then owned MCP/bash children.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const S = require('./_shared').create({ suite: 'pipe-lifecycle' });
const source = fs.readFileSync(S.IDX, 'utf8');
const contexts = [], bashChildren = [], controls = [];
let checks = 0, skipped = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundary: ' + from);
  return source.slice(start, end);
}
function stopOwnedBash() {
  for (const child of bashChildren) if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch (e) {} }
}
const suiteDeadline = setTimeout(() => { console.error('PIPE/LIFECYCLE suite deadline'); stopOwnedBash(); S.cleanup(); process.exit(1); }, 60000);
async function bounded(promise, ms = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('pending request did not settle')), ms); })]); }
  finally { clearTimeout(timer); }
}
const observed = promise => promise.then(value => ({ value }), error => ({ error: error.message }));
function fakeChild() {
  const child = new EventEmitter();
  child.writes = []; child.kills = 0;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, callback) { child.writes.push(chunk.toString()); callback(); } });
  child.kill = () => { child.kills++; return true; }; // allow explicit late exit events
  return child;
}
function environment(spawn, cwd) {
  const ctx = { Buffer, process, fs, path, setTimeout, clearTimeout, setInterval, clearInterval, console: { log() {}, warn() {} },
    APP_VERSION: 'fixture', launchDir: cwd || S.freshCwd('unit'), agentDepth: 0, workflowStepDepth: 0,
    mcpServers: { fixture: { command: 'fixture' } }, mcpClients: {}, resolveCommandOnWindows: () => false,
    findBash: () => 'fixture-bash', child_process: { spawn, execSync: cp.execSync } };
  vm.createContext(ctx);
  vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') +
    cut('const MCP_CALL_TIMEOUT =', '// One lazily-created client') +
    cut('function mcpContentToText(', '// A2-19:') + cut('function createMcpStdioClient(', '// Redact secrets') +
    cut('const persistentShells =', '// Converts a glob pattern') +
    '\nthis.state={shells:persistentShells,mcpLimit:MCP_MAX_FRAME_BYTES,shellLimit:SHELL_MAX_OUTPUT_BYTES};', ctx);
  contexts.push(ctx);
  return ctx;
}
function unit() {
  const children = [];
  const ctx = environment(() => { const child = fakeChild(); children.push(child); return child; });
  return { ctx, children };
}
const reply = (child, id, result) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
function control(ctx) { const token = ctx.createExecutionControl(5000); controls.push(token); return token; }
function marker(child) { const match = child.writes[child.writes.length - 1].match(/7CODER-SHELL-END-\d+-\d+/); assert.ok(match, 'shell marker exists'); return match[0]; }
function shellReply(child, out, code) { child.stdout.write(out + '\n' + marker(child) + ' ' + code + '\n'); }
(async () => {
  try {
    const pre = unit(), preToken = control(pre.ctx); preToken.cancel('already cancelled');
    let preError;
    try { pre.ctx.getMcpClient('fixture', preToken); } catch (e) { preError = e; }
    check('cancelled MCP entry never spawns a client', preError && preError.code === 'EXECUTION_CANCELLED' && pre.children.length === 0);

    const init = unit(), initClient = init.ctx.getMcpClient('fixture'), initToken = control(init.ctx);
    const initResult = observed(initClient.callTool('echo', {}, initToken));
    reply(init.children[0], 1, {}); initToken.cancel('cancel between init reply and initialized notification');
    check('cancel after initialize reply retires half-initialized client and sends no tools/call',
      !!(await bounded(initResult)).error && initClient.dead && !init.ctx.mcpClients.fixture &&
      init.children[0].writes.length === 1 && JSON.parse(init.children[0].writes[0]).method === 'initialize');

    const activeMcp = unit(), activeClient = activeMcp.ctx.getMcpClient('fixture'), mcpToken = control(activeMcp.ctx);
    activeClient.initialized = true;
    const activeResult = observed(activeClient.callTool('echo', {}, mcpToken));
    await new Promise(resolve => setImmediate(resolve)); mcpToken.cancel('cancel active RPC');
    check('active MCP cancellation retires pending requests once with unknown-result evidence',
      (await bounded(activeResult)).error.includes('result unknown') && activeClient.pending.size === 0 &&
      activeMcp.children[0].kills === 1 && !activeMcp.ctx.mcpClients.fixture);
    const afterCancel = activeMcp.ctx.getMcpClient('fixture');
    activeMcp.children[0].emit('exit', 9);
    check('late cancelled MCP exit cannot evict replacement or replay request',
      activeMcp.ctx.mcpClients.fixture === afterCancel && activeMcp.children[0].writes.length === 1 && activeMcp.children[1].writes.length === 0);

    const cancelledShell = unit(), cs = cancelledShell.ctx.getPersistentShell('main'), shellToken = control(cancelledShell.ctx);
    const shellWait = cs.run('pending', 5000, shellToken); shellToken.cancel('cancel active shell');
    check('shell cancellation settles active command and retires direct child once',
      (await bounded(shellWait)).restarted && cs.active === null && cs.dead && cancelledShell.children[0].kills === 1 && !cancelledShell.ctx.state.shells.has('main'));
    const freshShell = cancelledShell.ctx.getPersistentShell('main');
    const notSent = await freshShell.run('never send', 5000, shellToken);
    check('already-cancelled shell call sends no bytes and preserves unused session',
      notSent.out.includes('command not sent') && cancelledShell.children[1].writes.length === 0 && !freshShell.dead);

    for (const kind of ['MCP', 'shell']) {
      let incomplete;
      const f = environment(() => {
        incomplete = new EventEmitter(); incomplete.kill = () => false;
        process.nextTick(() => incomplete.emit('error', Object.assign(Error('EMFILE fixture'), { code: 'EMFILE' })));
        return incomplete;
      });
      if (kind === 'MCP') {
        const c = f.getMcpClient('fixture'), result = await observed(c.callTool('x', {}));
        await new Promise(resolve => setImmediate(resolve));
        check('MCP missing stdio on spawn failure still captures asynchronous error', c.dead && !!result.error && c.pending.size === 0 && incomplete.listenerCount('error') === 1 && !f.mcpClients.fixture);
      } else {
        const sh = f.getPersistentShell('main'), result = await sh.run('command', 1000);
        await new Promise(resolve => setImmediate(resolve));
        check('shell missing stdio on spawn failure still captures asynchronous error', sh.dead && result.code === -1 && sh.active === null && incomplete.listenerCount('error') === 1 && !f.state.shells.has('main'));
      }
    }
    const a = unit(), client = a.ctx.getMcpClient('fixture'), firstChild = a.children[0];
    const p1 = observed(client.request('one', {}, 1000)), p2 = observed(client.request('two', {}, 1000));
    firstChild.stdin.destroy(Object.assign(Error('injected asynchronous EPIPE'), { code: 'EPIPE' }));
    const failures = await bounded(Promise.all([p1, p2]));
    check('MCP asynchronous Writable EPIPE settles every pending request without uncaught error', failures.every(r => r.error && r.error.includes('result unknown')) && client.dead && client.pending.size === 0 && firstChild.kills === 1);
    const replacement = a.ctx.getMcpClient('fixture');
    firstChild.emit('exit', 1); firstChild.emit('close', 1);
    check('late old MCP exit/close cannot evict new client', replacement !== client && a.ctx.mcpClients.fixture === replacement && !replacement.dead);
    const disposed = observed(replacement.request('pending', {}, 1000));
    a.ctx.disposeMcpClients(); a.ctx.disposeMcpClients();
    check('MCP dispose is idempotent and settles immediately', (await bounded(disposed)).error.includes('disposed') && replacement.pending.size === 0 && a.children[1].kills === 1 && !a.ctx.mcpClients.fixture);

    for (const pipe of ['stdout', 'stderr']) {
      const f = unit(), c = f.ctx.getMcpClient('fixture'), request = observed(c.request('pending', {}, 1000));
      f.children[0][pipe].destroy(Error(pipe + ' failed'));
      check('MCP ' + pipe + ' error retires session and clears pending', !!(await bounded(request)).error && c.dead && c.pending.size === 0);
    }
    const timeout = unit(), timed = timeout.ctx.getMcpClient('fixture');
    const late = observed(timed.request('write-side-effect', {}, 20)), also = observed(timed.request('other', {}, 1000));
    const timedResults = await bounded(Promise.all([late, also]));
    check('MCP timeout quarantines session and labels all sent results unknown', timedResults.every(r => r.error.includes('timed out') && r.error.includes('check side effects')) && timed.dead && timed.pending.size === 0);
    const fresh = timeout.ctx.getMcpClient('fixture'), freshWait = observed(fresh.request('fresh', {}, 1000));
    reply(timeout.children[0], 1, { old: true });
    check('late timed-out reply cannot settle replacement request', fresh.pending.size === 1);
    reply(timeout.children[1], 1, { current: true });
    check('replacement MCP client remains usable', (await bounded(freshWait)).value.current === true);

    const valid = unit(), validClient = valid.ctx.getMcpClient('fixture'), validChild = valid.children[0];
    const validWait = observed(validClient.request('valid', {}, 1000));
    validChild.stdout.write('noise\nnull\n[]\n5\n{"id":99,"method":{"toString":null}}\n');
    validChild.stdout.write('{"id":99,"method":"roots/list"}\n');
    const frame = JSON.stringify({ id: 1, result: { text: '中文😀' } });
    validChild.stdout.write(frame.slice(0, 9)); validChild.stdout.write(frame.slice(9) + '\r\n');
    check('MCP tolerates noisy/nonobject frames, handles server request and fragmented UTF8 result', (await bounded(validWait)).value.text === '中文😀' && !validClient.dead && validChild.writes.some(line => JSON.parse(line).id === 99));
    const remoteError = observed(validClient.request('error', {}, 1000));
    validChild.stdout.write('{"id":2,"error":{"message":{"toString":null}}}\n');
    check('malformed remote error message rejects only its request without crashing', !!(await bounded(remoteError)).error && !validClient.dead && validClient.pending.size === 0);
    for (const newline of [false, true]) {
      const f = unit(), c = f.ctx.getMcpClient('fixture'), pending = observed(c.request('pending', {}, 1000));
      f.children[0].stdout.write('界'.repeat(Math.floor(f.ctx.state.mcpLimit / 3) + 1) + (newline ? '\n' : ''));
      check('MCP ' + (newline ? 'complete' : 'unterminated') + ' oversized UTF8 frame retires within byte cap', (await bounded(pending)).error.includes('exceeds 4 MB') && c.dead && c.pending.size === 0);
    }
    const writes = validChild.writes.length;
    const tooLarge = await observed(validClient.request('large', { text: 'x'.repeat(valid.ctx.state.mcpLimit) }, 1000));
    check('oversized outbound request is not written and leaves no pending timer', tooLarge.error.includes('request not sent') && validChild.writes.length === writes && validClient.pending.size === 0 && !validClient.dead);

    const shCase = unit(), shell = shCase.ctx.getPersistentShell('main'), child = shCase.children[0];
    const listenerCount = () => [child, child.stdin, child.stdout, child.stderr].map(stream => stream.eventNames().reduce((n, name) => n + stream.listenerCount(name), 0)).join(',');
    const listeners = listenerCount(), running = shell.run('printf payload', 1000);
    const busy = await shell.run('second', 1000);
    shellReply(child, 'payload', 0);
    const success = await bounded(running);
    check('persistent shell enforces one active write and strips completion marker', busy.code === -1 && busy.out.includes('not sent') && child.writes.length === 1 && success.code === 0 && success.out === 'payload' && shell.active === null);
    const nonzero = shell.run('false', 1000), end = marker(child);
    child.stderr.write('detail'); child.stdout.write('\n' + end.slice(0, 10)); child.stdout.write(end.slice(10) + ' 7\n');
    const badExit = await bounded(nonzero);
    check('fragmented marker preserves stderr and nonzero status without killing shell', badExit.code === 7 && badExit.out === 'detail' && !shell.dead);
    check('repeated shell commands do not accumulate listeners', listenerCount() === listeners);
    const exiting = shell.run('exit 9', 1000); child.emit('exit', 9);
    check('shell exit settles active command immediately as unknown', (await bounded(exiting, 500)).out.includes('result unknown') && shell.dead && shell.active === null);
    const newShell = shCase.ctx.getPersistentShell('main'); child.emit('close', 9);
    check('late old shell close cannot evict replacement', shCase.ctx.state.shells.get('main') === newShell && !newShell.dead);

    const broken = unit(), brokenShell = broken.ctx.getPersistentShell('main'), brokenWait = brokenShell.run('write', 1000);
    broken.children[0].stdin.destroy(Object.assign(Error('asynchronous EPIPE'), { code: 'EPIPE' }));
    check('shell Writable EPIPE settles active request and retires cache', (await bounded(brokenWait)).out.includes('stdin') && brokenShell.dead && brokenShell.active === null && !broken.ctx.state.shells.has('main'));
    const ended = unit(), endedShell = ended.ctx.getPersistentShell('main'), endedWait = endedShell.run('pending', 1000);
    ended.children[0].stdout.end();
    check('stdout EOF settles shell without waiting for command timeout', (await bounded(endedWait, 500)).out.includes('stdout ended') && endedShell.active === null);
    const limit = unit(), limited = limit.ctx.getPersistentShell('main'), limitedWait = limited.run('large', 1000);
    limit.children[0].stdout.write('x'.repeat(limit.ctx.state.shellLimit + 1));
    const capped = await bounded(limitedWait);
    check('shell output cap applies before retention rather than only display', capped.out.includes('exceeds 8 MB') && capped.out.length < 1000 && limited.dead && limited.active === null);
    const hung = unit(), hungShell = hung.ctx.getPersistentShell('main');
    const timedOut = await bounded(hungShell.run('hang', 20));
    check('shell timeout retires session with code124 and unknown outcome', timedOut.code === 124 && timedOut.restarted && timedOut.out.includes('result unknown') && hungShell.active === null);
    const nextShell = hung.ctx.getPersistentShell('main'), nextChild = hung.children[1];
    nextChild.stdout.write('ignored idle output');
    const recovered = nextShell.run('printf recovered', 1000); shellReply(nextChild, 'recovered', 0);
    check('new shell recovers without idle output or expired timer contamination', (await bounded(recovered)).out === 'recovered' && !nextShell.dead);
    const disposing = nextShell.run('pending', 1000);
    hung.ctx.disposePersistentShells(); hung.ctx.disposePersistentShells();
    check('shell dispose settles active request and kills direct child once', (await bounded(disposing)).out.includes('disposed') && nextChild.kills === 1 && nextShell.active === null);

    const nativeCwd = S.freshCwd('native-mcp');
    const stalledNative = environment((command, argv, opts) => S.spawn(command, argv, opts), nativeCwd);
    stalledNative.mcpServers.fixture = { command: S.NODE_BIN, args: ['-e', 'process.stdin.resume();'] };
    const stalledClient = stalledNative.getMcpClient('fixture'), nativeToken = control(stalledNative);
    const nativeClosed = new Promise(resolve => stalledClient.child.once('close', resolve));
    const nativeWait = observed(stalledClient.callTool('echo', {}, nativeToken));
    nativeToken.cancel('cancel real stalled initialization');
    const nativeResult = await bounded(nativeWait, 3000);
    await bounded(nativeClosed, 3000);
    check('real stalled MCP child closes after cancellation without leaving pending calls',
      nativeResult.error.includes('result unknown') && stalledClient.pending.size === 0 && stalledClient.dead && !stalledNative.mcpClients.fixture);

    const native = environment((command, argv, opts) => S.spawn(command, argv, opts), nativeCwd);
    native.mcpServers.fixture = { command: S.NODE_BIN, args: [path.join(__dirname, 'mcp-echo-server.js')], env: { MCP_ECHO_LOG: path.join(nativeCwd, 'rx.jsonl') } };
    const realClient = native.getMcpClient('fixture');
    check('owned real MCP child initializes, lists tools and returns UTF8 tool result', (await bounded(realClient.listTools(), 5000)).some(t => t.name === 'echo') && await bounded(realClient.callTool('echo', { text: '原生管道' }), 5000) === 'ECHO:原生管道');
    realClient.dispose();
    const restarted = native.getMcpClient('fixture');
    check('real MCP reconnect survives old child shutdown and returns next result', await bounded(restarted.callTool('add', { a: 2, b: 3 }), 5000) === '5' && native.mcpClients.fixture === restarted);

    const owner = path.join(S.runDir, 'owned-bash.rc'); fs.writeFileSync(owner, '');
    const bashCwd = S.freshCwd('native-bash'); fs.mkdirSync(path.join(bashCwd, 'sub'));
    const nativeShell = environment((command, argv, opts) => {
      const env = Object.assign({}, opts.env, { BASH_ENV: '', ENV: '', CDPATH: '' });
      for (const name of Object.keys(env)) if (/^(SHELLOPTS|BASHOPTS|BASH_FUNC_)/.test(name)) delete env[name];
      const owned = cp.spawn(command, argv.concat(['--rcfile', owner]), Object.assign({}, opts, { env }));
      bashChildren.push(owned);
      if (owned.pid) fs.appendFileSync(S.manifest, owned.pid + '\t' + owner + '\n');
      return owned;
    }, bashCwd);
    vm.runInContext(cut('let bashPathCache;', 'function isSuperDangerous('), nativeShell);
    if (!nativeShell.findBash()) { skipped++; console.log('SKIP real bash: Git Bash is unavailable; stream fault coverage still ran'); }
    else {
      const realShell = nativeShell.getPersistentShell('main');
      const one = await bounded(realShell.run('export PIPE_MARK=live; cd sub; printf "$PIPE_MARK"', 3000), 4000);
      const two = await bounded(realShell.run('printf "$PWD|$PIPE_MARK"; false', 3000), 4000);
      check('real bash preserves cwd/env, no-newline output and nonzero code', one.code === 0 && one.out === 'live' && two.code === 1 && two.out.includes('/sub|live'));
      const early = await bounded(realShell.run('exit 9', 3000), 2000);
      const realNew = nativeShell.getPersistentShell('main');
      const after = await bounded(realNew.run('printf "${PIPE_MARK-unset}|$PWD"', 3000), 4000);
      check('real bash exit settles promptly and replacement has fresh cwd/env', early.code === -1 && realShell.dead && after.code === 0 && after.out.startsWith('unset|') && !after.out.endsWith('/sub') && nativeShell.state.shells.get('main') === realNew);
    }
    console.log('PIPE/LIFECYCLE: ' + checks + '/' + checks + '; skipped scenarios=' + skipped);
  } finally {
    clearTimeout(suiteDeadline);
    for (const token of controls) token.dispose();
    for (const ctx of contexts) { ctx.disposeMcpClients(); ctx.disposePersistentShells(); }
    stopOwnedBash();
    const closed = await Promise.allSettled(bashChildren.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : bounded(new Promise(resolve => child.once('close', resolve)), 3000)));
    S.cleanup();
    const failed = closed.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
