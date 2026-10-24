// Direct-child lifecycle and task/cron ownership. Descendant containment is
// deliberately not simulated as a proven Windows process-tree guarantee.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const S = require('./_shared').create({ suite: 'task-lifecycle' });
const source = fs.readFileSync(S.IDX, 'utf8'), children = [];
let checks = 0;
const deadline = setTimeout(() => { console.error('TASK/LIFECYCLE deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundary ' + from);
  return source.slice(start, end);
}
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 123456; child.exitCode = null; child.signalCode = null; child.killed = false; child.kills = 0;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.kills++; child.killed = true; return true; };
  return child;
}
function close(child, code = 0) { child.exitCode = code; child.emit('exit', code); child.emit('close', code); }
function context(exec) {
  const ctx = vm.createContext({ Buffer, Date, console, process: { platform: 'unit-direct' }, setTimeout: (fn, ms) => setTimeout(fn, ms === 5000 ? 30 : ms), clearTimeout,
    launchDir: S.freshCwd('task 中文 空格'), shuttingDown: false, backgroundTasks: new Map(), cronJobs: new Map(), taskSeq: 0, cronSeq: 0, recordRuntimeEvent() {},
    child_process: { exec, execSync() { throw Error('numeric PID cleanup forbidden'); } },
    withUtf8Codepage: command => command, isSuperDangerous: () => false });
  vm.runInContext(cut('const TASK_MAX_ACTIVE =', '// Set when the REPL') + cut('function pruneTasks()', 'const DANGER_MODE =') +
    cut('const ownedChildStates =', '// ====================== DREAM HELPERS') +
    cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
    'async function tool(name,args) {\n' + cut("  if (name === 'task_create_tool') {", "  if (name === 'todo_write_tool') {") +
    cut("  if (name === 'schedule_cron_tool' ||", "  if (name === 'skill_tool') {") + '\n}', ctx);
  return ctx;
}
(async () => {
  try {
    let ctx = context(), child = fakeChild();
    ctx.observeOwnedChild(child);
    const first = ctx.stopOwnedChild(child), again = ctx.stopOwnedChild(child);
    check('concurrent stop shares one pending observation and one kill', first === again && child.kills === 1);
    close(child);
    check('stop waits for close and states descendant boundary', (await first).closed && (await first).message.includes('descendant'));
    await ctx.stopOwnedChild(child);
    check('already-closed child is never killed through an old PID', child.kills === 1);

    child = fakeChild(); ctx.observeOwnedChild(child); child.emit('exit', 0); child.exitCode = 0;
    const exited = ctx.stopOwnedChild(child);
    check('exit before pipe close never issues another kill', child.kills === 0);
    check('inherited pipe without close is unknown at deadline', !(await exited).closed);
    close(child);

    child = fakeChild(); child.kill = () => { child.kills++; return false; };
    check('kill refusal cannot report stopped', !(await ctx.stopOwnedChild(child)).closed && child.kills === 1);
    child = fakeChild(); child.kill = () => { throw Error('EPERM fixture'); };
    check('kill exception is retained in unknown result', (await ctx.stopOwnedChild(child)).message.includes('EPERM fixture'));
    child = fakeChild(); delete child.pid; delete child.stdout; delete child.stderr;
    ctx.observeOwnedChild(child); child.emit('error', Error('EMFILE fixture'));
    check('spawn failure with no PID or stdio needs no nonexistent close', (await ctx.stopOwnedChild(child)).closed && child.kills === 0);

    const calls = [];
    ctx = context((command, options, done) => { const c = fakeChild(); calls.push({ child: c, done }); return c; });
    await ctx.tool('task_create_tool', { command: 'fixture' });
    const task = ctx.latestTask(), stopping = ctx.tool('task_stop_tool', { task_id: task.id });
    check('task is stopping before child closes, with no invented end time', task.status === 'stopping' && task.endedAt === null);
    const unknown = await stopping;
    check('task stop timeout reports error and keeps child ownership', unknown.status === 'error' && task.status === 'stop-unknown' && task.child === calls[0].child && task.endedAt === null);
    calls[0].done(Error('killed fixture')); close(calls[0].child, 1);
    check('late close reconciles unknown task without leaving live handle', task.status === 'stopped' && task.child === null && !!task.endedAt);
    check('completed stop is idempotent', (await ctx.tool('task_stop_tool', { task_id: task.id })).text.includes('already stopped'));

    ctx.scheduleCronJob('cron-live', '1s', 'fixture');
    const job = ctx.cronJobs.get('cron-live');
    clearTimeout(job.timer);
    job.child = fakeChild(); job.running = true; ctx.observeOwnedChild(job.child);
    const deleting = ctx.tool('cron_delete_tool', { job_id: 'cron-live' });
    check('delete disables scheduling immediately and sends direct stop', job.stopped && job.timer === null && job.child.kills === 1);
    check('unconfirmed cron deletion preserves registry and reports error', (await deleting).status === 'error' && ctx.cronJobs.get('cron-live') === job);
    check('disabled unknown cron remains visible in list', (await ctx.tool('cron_list_tool', {})).text.includes('disabled'));
    close(job.child);
    check('retry deletion after observed close releases registry', (await ctx.tool('cron_delete_tool', { job_id: 'cron-live' })).status === 'ok' && !ctx.cronJobs.size);

    const held = { id: 'held', status: 'stop-unknown', child: fakeChild() };
    ctx.backgroundTasks.clear(); ctx.backgroundTasks.set('held', held);
    for (let i = 0; i < 55; i++) ctx.backgroundTasks.set('done-' + i, { status: 'completed', child: null });
    ctx.pruneTasks();
    check('pruning cannot evict unresolved process ownership', ctx.backgroundTasks.size === 50 && ctx.backgroundTasks.get('held') === held);

    ctx = context();
    const native = S.spawn(S.NODE_BIN, ['-e', 'setInterval(function(){},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(native); ctx.observeOwnedChild(native);
    check('real owned Node direct child closes after stop', (await ctx.stopOwnedChild(native, 5000)).closed && native.signalCode !== null);
    const naturally = S.spawn(S.NODE_BIN, ['-e', 'process.exit(7)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(naturally); ctx.observeOwnedChild(naturally);
    await new Promise(resolve => naturally.once('close', resolve));
    const originalKill = naturally.kill; naturally.kill = () => { throw Error('old PID used'); };
    check('real natural nonzero exit remains observed without cleanup kill', (await ctx.stopOwnedChild(naturally)).closed && naturally.exitCode === 7);
    naturally.kill = originalKill;
    console.log('TASK/LIFECYCLE ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline);
    for (const c of children) if (c.exitCode === null && c.signalCode === null) { try { c.kill(); } catch (e) {} }
    S.cleanup();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
