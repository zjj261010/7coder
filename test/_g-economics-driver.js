'use strict';
const fs = require('fs'), path = require('path');
async function run(S, spec) {
  const fixture = await spec.start(), cwd = S.freshCwd('g4-' + spec.kind), runtime = path.join(cwd, '.7coder', 'runtime.jsonl'), audit = path.join(cwd, '.7coder', 'audit.jsonl');
  const file = path.join(cwd, spec.file), worklog = path.join(cwd, '7CODER.md');
  fs.writeFileSync(file, spec.old); if (spec.kind === 'bypass') fs.writeFileSync(path.join(cwd, spec.seedFile), spec.seed);
  let child, closed = false, code, signal, output = '', approvalProof = false;
  const tasks = () => S.readLog(runtime).filter(row => row.scope === 'cli-task'), tools = () => S.readLog(audit).filter(row => row.type === 'tool');
  async function until(fn, label, allowClosed) { const end = Date.now() + 10000; while (!(await fn())) { if (closed && !allowClosed) throw Error('G4 closed early: ' + code + ' ' + output.slice(-1800)); if (Date.now() >= end) throw Error(label + ': requests=' + fixture.log.length + ' fixture=' + fixture.errors.join(';') + ' output=' + output.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 10)); } }
  try {
    child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_ENDPOINT: fixture.endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: spec.model, LIGHT_MODEL: 'g4-unused-light', SUMMARY_MODEL: spec.summaryModel, SUMMARY_MAX_TOKENS: '128',
      MAX_TOOL_STEPS: '5', CONTEXT_CHARS: '200000', PERMISSION_MODE: spec.kind === 'bypass' ? 'bypass' : 'default', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '20000' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
    child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', (value, why) => { code = value; signal = why; closed = true; });
    await until(() => output.includes('Commands:'), 'G4 ready'); child.stdin.write(spec.prompt + '\n/execute-task-now\n');
    if (spec.kind !== 'bypass') {
      await until(() => output.includes(spec.question), 'G4 actual diff and pending approval');
      approvalProof = fixture.log.length === 1 && tasks().length === 0 && tools().length === 0 && !fs.existsSync(worklog) && fs.readFileSync(file, 'utf8') === spec.old;
      child.stdin.write(spec.kind === 'approve' ? 'y\n' : 'n\n');
    }
    await until(() => fixture.waiting() && output.includes(spec.reply), 'G4 action summary admitted only after final answer');
    const summaryProof = fixture.log.length === spec.summaryStep + 1 && tasks().length === 0 && tools().length === spec.n && !fs.existsSync(worklog) && fs.readFileSync(file, 'utf8') === spec.finalFile;
    fixture.release(); await until(() => tasks().length === 1 && fs.existsSync(worklog), 'G4 first task with persisted summary terminal');
    const afterFirst = fs.readFileSync(worklog, 'utf8');
    child.stdin.write(spec.recovery + '\n/execute-task-now\n'); await until(() => tasks().length === 2 && output.includes(spec.recovered), 'G4 same Agent short next task');
    child.stdin.end('/bye\n'); await until(() => closed, 'G4 normal close', true);
    return { code, signal, output, approvalProof, summaryProof, afterFirst, worklog: fs.readFileSync(worklog, 'utf8'), finalFile: fs.readFileSync(file, 'utf8'), seed: spec.kind === 'bypass' ? fs.readFileSync(path.join(cwd, spec.seedFile), 'utf8') : null,
      log: fixture.log, errors: fixture.errors, runtime: S.readLog(runtime), audits: S.readLog(audit), saved: JSON.parse(fs.readFileSync(path.join(cwd, '.7coder', 'session.json'), 'utf8')) };
  } finally {
    try { if (child && !closed) { child.kill(); await until(() => closed, 'G4 owned CLI cleanup', true); } }
    finally { await fixture.close(); }
  }
}
module.exports = { run };
