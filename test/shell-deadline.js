// Real Bash, only builtins, owned direct handles. No desktop/model/network.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const S = require('./_shared').create({ suite: 'shell-deadline' });
const source = fs.readFileSync(S.IDX, 'utf8'), children = [];
let checks = 0;
const deadline = setTimeout(() => { console.error('SHELL/DEADLINE deadline'); stop(); S.cleanup(); process.exit(1); }, 15000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
function stop() { for (const c of children) if (c.exitCode === null && c.signalCode === null) { try { c.kill(); } catch (error) {} } }
async function until(predicate, label) {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() >= end) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
(async () => {
  let ctx;
  try {
    const cwd = S.freshCwd('deadline 中文 空格'), runDir = path.dirname(path.dirname(S.IDX)), owner = '--7coder-test-owner=' + runDir;
    ctx = vm.createContext({ Buffer, fs, path, process, child_process: require(path.join(path.dirname(S.IDX),'lib','process-owner')).create(cp,path.dirname(S.IDX)), __dirname:path.dirname(S.IDX), launchDir: cwd, agentDepth: 0, workflowStepDepth: 0,
      console: { log() {}, warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval, EXECUTION_TIMEOUT_MS: 5000 });
    vm.runInContext(cut('function runCommandAsync(', '// ====================== PERSISTENT SHELL') + cut('let bashPathCache;', 'function isSuperDangerous(') + cut('function executionCancelledError(', 'function parseSSEStream(') +
      cut('const persistentShells =', '// Converts a glob pattern'), ctx);
    const bash = await ctx.discoverBash();
    if (!bash) { console.log('SHELL/DEADLINE: 0 passed; 1 SKIP (Git Bash/bash unavailable, real timeout not validated)'); return; }
    ctx.child_process = { spawn(file, args, options) {
      const child = cp.spawn(file, args.concat(['-s', '--', owner]), Object.assign({}, options, { windowsHide: true }));
      children.push(child); child.rawOutput = ''; child.writes = []; child.kills = 0; child.closed = false;
      const write = child.stdin.write.bind(child.stdin), kill = child.kill.bind(child);
      child.stdin.write = (data, ...rest) => { child.writes.push(String(data)); return write(data, ...rest); };
      child.kill = (...args) => { child.kills++; return kill(...args); };
      child.stdout.on('data', data => child.rawOutput += data.toString());
      child.once('close', () => { child.closed = true; });
      if (child.pid) fs.appendFileSync(path.join(runDir, 'owned-processes.tsv'), child.pid + '\t' + owner + '\n');
      return child;
    } };
    const shell = ctx.getPersistentShell('deadline'), original = children[0], start = Date.now();
    const loop = 'limit=$((SECONDS+6)); while ((SECONDS<limit)); do read -t 1 ignored || :; done';
    const hung = shell.run('export OLD_SCOPE=LEAK; printf "HANG_READY\\n"; ' + loop, 1000);
    await until(() => original.rawOutput.includes('HANG_READY'), 'loop reached');
    const result = await hung, elapsed = Date.now() - start;
    check('actual six-second builtin loop reaches the one-second caller deadline', elapsed >= 900 && elapsed < 3500 && result.restarted && result.out.includes('timeout'));
    check('timeout reports unknown effects and retires the original cache entry', result.out.includes('result unknown') && shell.dead && ctx.getPersistentShell('deadline') !== shell);
    await until(() => original.closed, 'original Bash close');
    check('owned Bash direct process is observed closed after exactly one kill', original.kills === 1 && (original.exitCode !== null || original.signalCode !== null));
    const fresh = ctx.getPersistentShell('deadline'), next = await fresh.run('printf "NEXT_OK:%s\\n" "$OLD_SCOPE"; ls -d . >/dev/null && printf "LS_READY\\n"; git --version >/dev/null && printf "GIT_READY\\n"; pwd', 2000);
    check('next shell resets old environment and resolves Git/Unix commands', next.code === 0 && next.out.includes('NEXT_OK:') && next.out.includes('LS_READY') && next.out.includes('GIT_READY') && !next.out.includes('LEAK') && !next.restarted);
    const current = children[1], first = fresh.run('printf "FIRST_ONLY\\n"', 2000), writes = current.writes.length;
    const busy = await fresh.run('printf "SECOND_MUST_NOT_SEND\\n"', 2000);
    check('overlapping command is refused before adding stdin work', busy.out.includes('busy') && current.writes.length === writes);
    check('surviving command completes with its own output only', (await first).out.includes('FIRST_ONLY') && !current.rawOutput.includes('SECOND_MUST_NOT_SEND'));
    const control = ctx.createExecutionControl(5000);
    const cancelled = fresh.run('printf "CANCEL_READY\\n"; ' + loop, 4000, control);
    await until(() => current.rawOutput.includes('CANCEL_READY'), 'cancel loop reached');
    control.cancel('fixture cancellation');
    check('active cancellation settles the wait and retires the shell', (await cancelled).restarted && fresh.dead);
    await until(() => current.closed, 'cancelled Bash close'); control.dispose();
    check('cancellation closes owned Bash once and leaves no execution control', current.kills === 1 && ctx.createExecutionControl.active.size === 0);
    console.log('SHELL/DEADLINE ' + checks + '/' + checks + '; 0 SKIP');
  } finally {
    clearTimeout(deadline); if (ctx && ctx.disposePersistentShells) ctx.disposePersistentShells(); stop(); S.cleanup();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
