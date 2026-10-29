'use strict';
const fs = require('fs'), path = require('path'), F = require('./_g-differential-fixture');
async function run(S) {
  const fixture = await F.start(), cwd = S.freshCwd('g6-differential'), runtime = path.join(cwd, '.7coder', 'runtime.jsonl'), audit = path.join(cwd, '.7coder', 'audit.jsonl');
  const read = file => fs.readFileSync(path.join(cwd, file));
  fs.writeFileSync(path.join(cwd, F.pageFile), F.pageText); for (const file of [F.globalFile, F.serialFile]) fs.writeFileSync(path.join(cwd, file), F.original);
  let child, closed = false, code, signal, output = ''; const states = [];
  const tasks = () => S.readLog(runtime).filter(row => row.scope === 'cli-task'), tools = () => S.readLog(audit).filter(row => row.type === 'tool');
  async function until(fn, label, allowClosed) { const end = Date.now() + 10000; while (!(await fn())) { if (closed && !allowClosed) throw Error('G6 closed early: ' + code + ' ' + output.slice(-1800)); if (Date.now() >= end) throw Error(label + ': requests=' + fixture.log.length + ' fixture=' + fixture.errors.join(';') + ' output=' + output.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 10)); } }
  try {
    child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_ENDPOINT: fixture.endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: F.model, LIGHT_MODEL: 'g6-unused-light', SUMMARY_MODEL: 'g6-unused-summary',
      MAX_TOOL_STEPS: '8', CONTEXT_CHARS: '200000', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '20000' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
    child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', (value, why) => { code = value; signal = why; closed = true; });
    await until(() => output.includes('Commands:'), 'G6 ready'); child.stdin.write(F.prompt + '\n/execute-task-now\n');
    for (let step = 3; step <= 7; step++) {
      await until(() => fixture.waiting(step), 'G6 real file stage ' + step);
      states.push({ step, requestCount: fixture.log.length, toolCount: tools().length, taskCount: tasks().length, pages: read(F.pageFile), global: read(F.globalFile), serial: read(F.serialFile), hasBackups: fs.existsSync(path.join(cwd, '.7coder', 'backups')) });
      fixture.release(step);
    }
    await until(() => tasks().length === 1 && output.includes(F.reply), 'G6 edits first terminal');
    const firstProof = tasks()[0].status === 'ok' && fixture.log.length === 8 && tools().length === 7;
    child.stdin.write(F.recovery + '\n/execute-task-now\n'); await until(() => tasks().length === 2 && output.includes(F.recovered), 'G6 actual readback next task');
    child.stdin.end('/bye\n'); await until(() => closed, 'G6 normal close', true);
    return { code, signal, output, states, firstProof, pages: read(F.pageFile), global: read(F.globalFile), serial: read(F.serialFile), hasWorklog: fs.existsSync(path.join(cwd, '7CODER.md')),
      log: fixture.log, errors: fixture.errors, runtime: S.readLog(runtime), audits: S.readLog(audit), saved: JSON.parse(read(path.join('.7coder', 'session.json')).toString('utf8')) };
  } finally {
    try { if (child && !closed) { child.kill(); await until(() => closed, 'G6 owned CLI cleanup', true); } }
    finally { await fixture.close(); }
  }
}
module.exports = { run };
