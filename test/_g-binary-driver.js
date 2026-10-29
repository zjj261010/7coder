'use strict';
const fs = require('fs'), path = require('path'), F = require('./_g-binary-fixture');
async function run(S) {
  const cwd = S.freshCwd('g7-binary'), target = path.join(cwd, F.file), runtime = path.join(cwd, '.7coder', 'runtime.jsonl'), audit = path.join(cwd, '.7coder', 'audit.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, F.original);
  const fixture = await F.start(() => F.readEvidence(cwd)), spec = fixture.spec, states = [], undos = [];
  let child, closed = false, code, signal, output = '';
  const tasks = () => S.readLog(runtime).filter(row => row.scope === 'cli-task'), tools = () => S.readLog(audit).filter(row => row.type === 'tool');
  const restoreCount = () => output.split(F.restored).length - 1;
  function snapshot() { return { requestCount: fixture.log.length, toolCount: tools().length, taskCount: tasks().length, payloadCount: fixture.payloads.length, bytes: fs.readFileSync(target), evidence: F.readEvidence(cwd) }; }
  async function until(fn, label, allowClosed) { const end = Date.now() + 10000; while (!(await fn())) { if (closed && !allowClosed) throw Error('G7 closed early: ' + code + ' ' + output.slice(-1800)); if (Date.now() >= end) throw Error(label + ': requests=' + fixture.log.length + ' fixture=' + fixture.errors.join(';') + ' output=' + output.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 10)); } }
  try {
    child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_ENDPOINT: fixture.endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: F.model, LIGHT_MODEL: 'g7-unused-light', SUMMARY_MODEL: 'g7-unused-summary',
      MAX_TOOL_STEPS: '3', CONTEXT_CHARS: '200000', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '20000' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
    child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', (value, why) => { code = value; signal = why; closed = true; });
    await until(() => output.includes('Commands:'), 'G7 ready'); child.stdin.write(F.prompts[0] + '\n/execute-task-now\n');
    for (const step of [1, 2]) { await until(() => fixture.waiting(step), 'G7 actual binary stage ' + step); states.push({ step, ...snapshot() }); fixture.release(step); }
    await until(() => tasks().length === 1 && output.includes(F.replies[0]), 'G7 first task terminal');
    child.stdin.write(F.prompts[1] + '\n/execute-task-now\n'); await until(() => fixture.waiting(4), 'G7 second binary overwrite'); states.push({ step: 4, ...snapshot() }); fixture.release(4);
    await until(() => tasks().length === 2 && output.includes(F.replies[1]), 'G7 second task terminal');
    for (let i = 1; i <= 2; i++) { child.stdin.write('/undo ' + F.file + '\n'); await until(() => restoreCount() === i, 'G7 actual undo ' + i); undos.push({ restoreCount: i, ...snapshot() }); }
    child.stdin.write(F.prompts[2] + '\n/execute-task-now\n'); await until(() => tasks().length === 3 && output.includes(F.replies[2]), 'G7 same Agent after undo');
    child.stdin.end('/bye\n'); await until(() => closed, 'G7 normal close', true);
    return { spec, code, signal, output, states, undos, finalBytes: fs.readFileSync(target), finalEvidence: F.readEvidence(cwd), log: fixture.log, errors: fixture.errors, payloads: fixture.payloads,
      runtime: S.readLog(runtime), audits: S.readLog(audit), hasWorklog: fs.existsSync(path.join(cwd, '7CODER.md')), saved: JSON.parse(fs.readFileSync(path.join(cwd, '.7coder', 'session.json'), 'utf8')) };
  } finally {
    try { if (child && !closed) { child.kill(); await until(() => closed, 'G7 owned CLI cleanup', true); } }
    finally { await fixture.close(); }
  }
}
module.exports = { run };
