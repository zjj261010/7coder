const assert = require('assert'), fs = require('fs'), vm = require('vm');
const { EventEmitter } = require('events'), { PassThrough } = require('stream');
const S = require('./_shared').create({ suite: 'task-budget' });
const source = fs.readFileSync(S.IDX, 'utf8'), contexts = [], native = [];
let checks = 0;
const deadline = setTimeout(() => { console.error('TASK/BUDGET deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
function fakeChild() {
  const child = new EventEmitter(); child.pid = 123456; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0;
  child.kill = () => { child.kills++; child.killed = true; return true; };
  return child;
}
function close(child, code = 0) { child.exitCode = code; child.emit('exit', code); child.emit('close', code); }
function context(exec) {
  const calls = [], timers = new Set();
  const ctx = vm.createContext({ Buffer, Date, console, process: { platform: 'unit-direct' },
    launchDir: S.freshCwd('budget'), shuttingDown: false, backgroundTasks: new Map(), cronJobs: new Map(), taskSeq: 0, cronSeq: 0, recordRuntimeEvent() {},
    setTimeout(fn, ms) { const t = setTimeout(fn, ms === 5000 ? 30 : ms); timers.add(t); return t; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    child_process: { exec(command, options, done) { const child = exec ? exec(command, options, done) : fakeChild(); calls.push({ child, options, done }); return child; } },
    withUtf8Codepage: command => command, isSuperDangerous: () => false });
  vm.runInContext(cut('const TASK_MAX_ACTIVE =', '// Set when the REPL') + cut('function pruneTasks()', 'const DANGER_MODE =') +
    cut('const ownedChildStates =', '// ====================== DREAM HELPERS') +
    cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
    'async function tool(name,args) {\n' + cut("  if (name === 'task_create_tool') {", "  if (name === 'todo_write_tool') {") +
    cut("  if (name === 'schedule_cron_tool' ||", "  if (name === 'skill_tool') {") +
    '\n} this.limits={active:TASK_MAX_ACTIVE,output:TASK_OUTPUT_LIMIT,tail:TASK_OUTPUT_TAIL,cron:CRON_MAX_JOBS};', ctx);
  ctx.calls = calls; ctx.timers = timers; contexts.push(ctx); return ctx;
}
(async () => {
  try {
    let ctx = context();
    for (let i = 0; i < ctx.limits.active; i++) await ctx.tool('task_create_tool', { command: 'fixture-' + i });
    check('fifth live task is refused before process creation', (await ctx.tool('task_create_tool', { command: 'extra' })).status === 'error' && ctx.calls.length === 4);
    const held = ctx.latestTask(), stopping = ctx.tool('task_stop_tool', { task_id: held.id });
    await stopping;
    check('unknown stop still occupies its admission slot', held.status === 'stop-unknown' && (await ctx.tool('task_create_tool', { command: 'extra' })).status === 'error');
    close(held.child);
    check('observed close releases one slot', (await ctx.tool('task_create_tool', { command: 'replacement' })).status === 'ok' && ctx.calls.length === 5);
    check('exec buffering has its own finite fallback limit', ctx.calls.every(call => call.options.maxBuffer === ctx.limits.output));
    check('oversized command is rejected before spawning', (await ctx.tool('task_create_tool', { command: 'x'.repeat(32769) })).text.includes('32768') && ctx.calls.length === 5);

    ctx = context(); await ctx.tool('task_create_tool', { command: 'output fixture' });
    const task = ctx.latestTask(), child = task.child;
    child.stdout.write('中'.repeat(60000));
    check('UTF-8 retained tail is bounded on whole characters', Buffer.byteLength(task.output) <= ctx.limits.tail && !task.output.includes('\ufffd') && task.outputTruncated);
    check('tail truncation is explicit in output tool and metadata', (await ctx.tool('task_output_tool', {})).text.includes('retained tail only') && JSON.parse((await ctx.tool('task_get_tool', {})).text).outputTruncated);
    child.stdout.write('x'.repeat(4 * 1024 * 1024)); child.stderr.write('y'.repeat(5 * 1024 * 1024));
    check('stdout and stderr share one output cap and one stop request', task.outputExceeded && child.kills === 1 && task.outputBytes === ctx.limits.output + 1);
    const frozen = task.output;
    child.stdout.write('late must not accumulate'.repeat(10000));
    check('over-limit streams continue draining without growing retained text', task.output === frozen && Buffer.byteLength(task.output) <= ctx.limits.tail);
    ctx.calls[0].done(Error('enormous diagnostic '.repeat(50000)));
    check('exec error cannot bypass tail or error-message bounds', task.commandError.length === 2000 && Buffer.byteLength(task.output) <= ctx.limits.tail);
    close(child, 1); await Promise.resolve();
    check('over-limit closed task is failed rather than stopped/completed', task.status === 'failed' && task.child === null);
    check('output-limit failure remains visible even when diagnostic tail changes', (await ctx.tool('task_output_tool', {})).text.includes('Task output limit exceeded'));

    ctx = context();
    for (let i = 0; i < 60; i++) {
      await ctx.tool('task_create_tool', { command: 'finished-' + i });
      const current = ctx.latestTask(); current.child.stdout.write('z'.repeat(150000)); close(current.child);
    }
    check('finished history stays at fifty bounded tails', ctx.backgroundTasks.size === 50 && Array.from(ctx.backgroundTasks.values()).reduce((n, t) => n + Buffer.byteLength(t.output), 0) <= 50 * ctx.limits.tail);

    ctx = context();
    await ctx.tool('cron_create_tool', { command: 'echo first', schedule: '1h' });
    await ctx.tool('cron_create_tool', { command: 'echo second', schedule: '1h' });
    check('rapid cron creation gets distinct ids and retains both timers', ctx.cronJobs.size === 2);
    const firstId = ctx.cronJobs.keys().next().value, original = ctx.cronJobs.get(firstId);
    check('duplicate explicit cron id cannot replace a live job', ctx.scheduleCronJob(firstId, '1h', 'echo replacement').startsWith('[ERROR]') && ctx.cronJobs.get(firstId) === original);
    for (let i = 2; i < ctx.limits.cron; i++) ctx.scheduleCronJob('fill-' + i, '1h', 'echo fixture');
    check('cron admission stops at thirty-two registered jobs', ctx.scheduleCronJob('overflow', '1h', 'echo overflow').startsWith('[ERROR]') && ctx.cronJobs.size === ctx.limits.cron);
    const toDelete = ctx.cronJobs.keys().next().value;
    await ctx.tool('cron_delete_tool', { job_id: toDelete });
    check('deleting a closed cron frees admission capacity', ctx.scheduleCronJob('after-delete', '1h', 'echo fixture').startsWith('[OK]'));

    ctx = context((command, options, done) => {
      const c = S.spawn(S.NODE_BIN, ['-e', "var n=0;var t=setInterval(function(){process.stdout.write('x'.repeat(65536));if(++n>200)clearInterval(t)},2)"], { stdio: ['ignore', 'pipe', 'pipe'] });
      c.once('close', code => done(code ? Error('fixture exit ' + code) : null)); native.push(c); return c;
    });
    await ctx.tool('task_create_tool', { command: 'owned output producer' });
    const live = ctx.latestTask(), owned = live.child;
    await new Promise(resolve => owned.once('close', resolve)); await Promise.resolve();
    check('real owned producer is stopped at the cap and retained data stays bounded', live.outputExceeded && live.status === 'failed' && Buffer.byteLength(live.output) <= ctx.limits.tail);
    console.log('TASK/BUDGET ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline);
    for (const ctx of contexts) for (const timer of ctx.timers) clearTimeout(timer);
    for (const child of native) if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch (e) {} }
    S.cleanup();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
