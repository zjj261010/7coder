// T22-06/22: dream ownership, failure cleanup and shared deadline with real
// files. Actual /clear, BTW deadlines and /bye are in repl-approval.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'auxiliary-lifecycle' });
const source = fs.readFileSync(S.IDX, 'utf8'), contexts = [];
let checks = 0;
const deadline = setTimeout(() => { console.error('AUXILIARY/LIFECYCLE deadline'); S.cleanup(); process.exit(1); }, 15000);
function check(name, ok) { assert.ok(ok, name); checks++; console.log('PASS ' + name); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundary: ' + from);
  return source.slice(start, end);
}
function fixture(name, run, extra) {
  const cwd = S.freshCwd(name), md = path.join(cwd, '7CODER.md'), lock = path.join(cwd, '.7coder', 'dream.lock');
  fs.writeFileSync(md, 'ORIGINAL_DREAM_NOTES');
  let updates = 0;
  const ctx = loadContext(source, cwd, {}, Object.assign({
    DREAM_ALLOW: true, shuttingDown: false, systemPrompt: 'fixture', listMemoryTopics: () => [],
    getLastInteractionTime: () => Date.now() - 6 * 3600000, getRandomSpinner: () => 'fixture',
    updateLastInteractionTime: () => { updates++; }, processWithTools: run,
    console: { log() {}, warn() {}, error() {} }
  }, extra || {}));
  vm.runInContext(cut('async function triggerDreamIfNeeded(', '// ====================== VISION HELPER'), ctx);
  contexts.push(ctx);
  return { ctx, cwd, md, lock, updates: () => updates };
}
const released = f => !fs.existsSync(f.lock) && !f.ctx.triggerDreamIfNeeded.owner && f.ctx.createExecutionControl.active.size === 0;
(async () => {
  try {
    let captured, owner;
    const success = fixture('success', async (messages, opts) => {
      captured = opts; owner = JSON.parse(fs.readFileSync(success.lock, 'utf8')); return 'done';
    });
    const route = Object.freeze({ main: 'fixture' });
    await success.ctx.triggerDreamIfNeeded(route);
    check('dream owns an exclusive lock and forwards model route plus callable control', owner.kind === '7coder-dream-owner-v1' && captured.modelContext === route && typeof captured.cancel === 'function');
    check('successful dream releases lock/control and records interaction once', released(success) && success.updates() === 1);

    const failed = fixture('failure', async () => { throw Error('model unavailable'); });
    await failed.ctx.triggerDreamIfNeeded(route);
    check('model failure preserves original notes and does not record successful interaction', released(failed) && failed.updates() === 0 && fs.readFileSync(failed.md, 'utf8') === 'ORIGINAL_DREAM_NOTES');

    const preflight = fixture('preflight', async () => 'must not call', { listMemoryTopics: () => { throw Error('preflight failed'); } });
    let error;
    try { await preflight.ctx.triggerDreamIfNeeded(route); } catch (e) { error = e; }
    check('failure before consolidation try/finally still releases owned lock and timer', error && error.message === 'preflight failed' && released(preflight) && preflight.updates() === 0);

    const expired = fixture('deadline', (messages, opts) => expired.ctx.waitForExecution(60000, opts.cancel), { EXECUTION_TIMEOUT_MS: 80 });
    await expired.ctx.triggerDreamIfNeeded(route);
    check('dream deadline cancels wait, preserves notes and releases ownership without success marker', released(expired) && expired.updates() === 0 && fs.readFileSync(expired.md, 'utf8') === 'ORIGINAL_DREAM_NOTES');

    let finish;
    const overlap = fixture('overlap', () => new Promise(resolve => { finish = resolve; }));
    const first = overlap.ctx.triggerDreamIfNeeded(route);
    const initialOwner = fs.readFileSync(overlap.lock, 'utf8');
    const second = await overlap.ctx.triggerDreamIfNeeded(route);
    check('overlapping dream cannot remove or replace live same-process ownership', second === false && fs.readFileSync(overlap.lock, 'utf8') === initialOwner);
    finish('done'); await first;
    check('original dream still releases normally after rejected reentry', released(overlap) && overlap.updates() === 1);

    const foreign = fixture('foreign-replacement', async () => { fs.writeFileSync(foreign.lock, 'FOREIGN_LOCK'); return 'done'; });
    await foreign.ctx.triggerDreamIfNeeded(route);
    check('finally never removes a lock replaced by another owner', fs.readFileSync(foreign.lock, 'utf8') === 'FOREIGN_LOCK' && !foreign.ctx.triggerDreamIfNeeded.owner && foreign.ctx.createExecutionControl.active.size === 0);

    const recovered = fixture('recover-owned-lock', async () => 'done');
    fs.mkdirSync(path.dirname(recovered.lock));
    fs.writeFileSync(recovered.lock, JSON.stringify({ kind: '7coder-dream-owner-v1', pid: 999999, nonce: 'prior-owner' }));
    await recovered.ctx.triggerDreamIfNeeded(route);
    check('recognized previous-owner lock recovers without four-hour delay under workspace exclusivity', released(recovered) && recovered.updates() === 1);

    const legacy = fixture('legacy-grace', async () => { throw Error('must not run'); });
    fs.mkdirSync(path.dirname(legacy.lock)); fs.writeFileSync(legacy.lock, 'LEGACY_FRESH_LOCK');
    check('unrecognized fresh legacy lock retains its grace period', await legacy.ctx.triggerDreamIfNeeded(route) === false && fs.readFileSync(legacy.lock, 'utf8') === 'LEGACY_FRESH_LOCK' && legacy.updates() === 0);
    console.log('AUXILIARY/LIFECYCLE ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline);
    for (const ctx of contexts) {
      ctx.cancelActiveExecutions('fixture cleanup');
      for (const token of Array.from(ctx.createExecutionControl.active || [])) token.dispose();
    }
    S.cleanup();
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
