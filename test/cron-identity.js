// Freeze the creation clock: distinct jobs must retain independent ownership.
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const { EventEmitter } = require('events');
const S = require('./_shared').create({ suite: 'cron-identity' });
const source = fs.readFileSync(S.IDX, 'utf8'), timers = new Set(), calls = [];
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
const instant = 1792800000000;
class FrozenDate extends Date {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
}
const ctx = vm.createContext({ Buffer, Date: FrozenDate, console, process: { platform: 'unit-owned-handle' },
  launchDir: S.freshCwd('jobs'), shuttingDown: false, cronSeq: 0, cronJobs: new Map(),
  CRON_MAX_JOBS: 32, isSuperDangerous: () => false, withUtf8Codepage: x => x,
  setTimeout(fn, ms) { const t = { fn, ms, unref() {} }; timers.add(t); return t; },
  clearTimeout(t) { timers.delete(t); },
  makeToolResult: (status, text) => ({ status, text }),
  child_process: { exec(command, options, done) {
    const child = new EventEmitter(); child.pid = 123456 + calls.length; child.exitCode = null; child.signalCode = null; child.kills = 0;
    child.kill = () => { child.kills++; child.killed = true; child.exitCode = 1; child.emit('exit', 1); child.emit('close', 1); done(Error('fixture stopped')); return true; };
    calls.push({ command, child }); return child;
  } }
});
vm.runInContext(cut('const ownedChildStates =', '// ====================== DREAM HELPERS') +
  'async function tool(name,args) {\n' + cut("  if (name === 'schedule_cron_tool' ||", "  if (name === 'skill_tool') {") + '\n}', ctx);
function fire(timer) { assert.ok(timers.delete(timer), 'only fire an owned scheduled timer'); timer.fn(); }
(async () => {
  try {
    const first = await ctx.tool('cron_create_tool', { schedule: '1s', command: 'first fixture' });
    const second = await ctx.tool('schedule_cron_tool', { schedule: '1s', command: 'second fixture' });
    const [a, b] = Array.from(ctx.cronJobs.keys()), ja = ctx.cronJobs.get(a), jb = ctx.cronJobs.get(b);
    check('same millisecond generates distinct sequential IDs via both aliases', first.status === 'ok' && second.status === 'ok' && a === 'cron-' + instant + '-1' && b === 'cron-' + instant + '-2');
    check('neither map entry nor timer is overwritten', ctx.cronJobs.size === 2 && timers.size === 2 && ja !== jb && ja.timer !== jb.timer);
    const originalTimer = ja.timer;
    check('duplicate explicit ID cannot replace an existing job or its timer', ctx.scheduleCronJob(a, '1s', 'replacement').startsWith('[ERROR]') && ctx.cronJobs.get(a) === ja && ja.timer === originalTimer && timers.size === 2);
    fire(ja.timer); fire(jb.timer);
    check('both timers independently execute their own commands', calls.length === 2 && calls[0].command === 'first fixture' && calls[1].command === 'second fixture' && ja.running && jb.running);
    fire(ja.timer); fire(jb.timer);
    check('each running job skips overlapping ticks and retains one next timer', calls.length === 2 && ja.runs === 1 && jb.runs === 1 && timers.size === 2);
    const retiredTimer = ja.timer, remainingTimer = jb.timer;
    check('deleting first job closes only its owned child and timer', (await ctx.tool('cron_delete_tool', { job_id: a })).status === 'ok' && calls[0].child.kills === 1 && calls[1].child.kills === 0 && !ctx.cronJobs.has(a) && ctx.cronJobs.get(b) === jb && timers.size === 1 && timers.has(remainingTimer));
    retiredTimer.fn();
    check('late callback from deleted job cannot launch or re-arm', calls.length === 2 && timers.size === 1);
    const child = calls[1].child; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0);
    fire(jb.timer);
    check('remaining job can execute again after observed close', calls.length === 3 && calls[2].command === 'second fixture' && jb.runs === 2 && timers.size === 1);
    check('remaining job independently deletes without timer/registry residue', (await ctx.tool('cron_delete_tool', { job_id: b })).status === 'ok' && calls[2].child.kills === 1 && timers.size === 0 && ctx.cronJobs.size === 0);
    console.log('CRON/IDENTITY ' + checks + '/' + checks + '; fixed clock, owned fake child handles (no OS tree claim)');
  } finally { timers.clear(); S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
