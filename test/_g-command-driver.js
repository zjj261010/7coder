'use strict';
const fs = require('fs'), path = require('path'), F = require('./_g-command-fixture');
async function run(S, kind) {
  const fixture = await F.start(kind), cwd = S.freshCwd('g1-' + kind), file = path.join(cwd, 'x.txt'), runtime = path.join(cwd, '.7coder', 'runtime.jsonl');
  fs.writeFileSync(file, 'CURRENT_FILE中文😀');
  let child, output = '', code, closed = false, forced = false;
  const elapsed = start => { const delta = process.hrtime(start); return delta[0] * 1000 + delta[1] / 1e6; };
  async function until(fn, label, allowClosed) { const start = process.hrtime(); while (!(await fn())) { if (closed && !allowClosed) throw Error('G1 closed early: ' + output.slice(-1800)); if (elapsed(start) >= 8000) throw Error(label + ': calls=' + fixture.log.length + ' fixture=' + fixture.errors.join(';') + ' output=' + output.slice(-1800)); await new Promise(r => setTimeout(r, 10)); } }
  const tasks = () => S.readLog(runtime).filter(e => e.scope === 'cli-task');
  try {
    child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_ENDPOINT: fixture.endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: F.main, LIGHT_MODEL: F.light, SUMMARY_MODEL: 'g1-unused-action-summary',
      PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '20000' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
    child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', value => { code = value; closed = true; });
    await until(() => output.includes('Commands:'), 'G1 ready');
    if (kind === 'queue') {
      child.stdin.write(F.first + '\n/execute-task-now\n'); await until(() => fixture.waiting(0), 'G1 first main admitted');
      child.stdin.write('/clear\n/undo x.txt\n' + F.marker + '\n/btw ' + F.note + '\n/execute-task-now\n');
      await until(() => fixture.waiting(1) && F.guards(output, 1), 'G1 active command guards and held BTW');
      const activeProof = fixture.log.length === 2 && tasks().length === 0 && fs.readFileSync(file, 'utf8') === 'CURRENT_FILE中文😀';
      fixture.release(0); await until(() => tasks().length === 1 && output.includes(F.replies[0]), 'G1 first completed');
      child.stdin.write('/execute-task-now\n/clear\n');
      await until(() => F.guards(output, 2), 'G1 second draft waits for held note while rejecting clear');
      const pendingProof = fixture.log.length === 2 && tasks().length === 1 && fixture.waiting(1);
      child.stdin.write(F.third + '\n/execute-task-now\n');
      await until(() => F.guards(output, 2, 2), 'G1 next draft acknowledged while note still held'); fixture.release(1);
      await until(() => tasks().length === 2 && output.includes(F.replies[1]), 'G1 second completed');
      child.stdin.write('/execute-task-now\n'); await until(() => tasks().length === 3 && output.includes(F.replies[2]), 'G1 third completed');
      child.stdin.end('/bye\n'); await until(() => closed, 'G1 queue normal close', true);
      const saved = JSON.parse(fs.readFileSync(path.join(cwd, '.7coder', 'session.json'), 'utf8'));
      return { kind, code, output, activeProof, pendingProof, log: fixture.log, errors: fixture.errors, runtime: S.readLog(runtime), audits: S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')),
        note: fs.readFileSync(path.join(cwd, '.7coder', 'BTW.md'), 'utf8'), currentFile: fs.readFileSync(file, 'utf8'), saved };
    }
    child.stdin.write('G1_QUIT_ACTIVE\n/execute-task-now\n');
    await until(() => output.includes('[TOOL] [DANGER MODE] Executing tool: sleep_tool') && fixture.log.length === 1, 'G1 sleep actual dispatch');
    const admitted = tasks().length === 0, start = process.hrtime(); child.stdin.write('/BYE\n');
    await until(() => closed, 'G1 active uppercase quit close', true);
    return { kind, code, output, forced, elapsed: elapsed(start), admitted, log: fixture.log, errors: fixture.errors, runtime: S.readLog(runtime), audits: S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')) };
  } finally {
    try { if (child && !closed) { forced = true; child.kill(); await until(() => closed, 'G1 owned CLI cleanup', true); } }
    finally { await fixture.close(); }
  }
}
module.exports = { run };
