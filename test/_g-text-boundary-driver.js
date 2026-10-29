'use strict';
const fs = require('fs'), path = require('path'), F = require('./_g-text-boundary-fixture');
async function run(S) {
  const cwd = S.freshCwd('g8-text-boundary'), runtime = path.join(cwd, '.7coder', 'runtime.jsonl'), audit = path.join(cwd, '.7coder', 'audit.jsonl'), session = path.join(cwd, '.7coder', 'session.json');
  const read = file => fs.readFileSync(path.join(cwd, file)); fs.writeFileSync(path.join(cwd, '7CODER.md'), F.noteText); fs.writeFileSync(path.join(cwd, F.guardFile), F.guard);
  const fixture = await F.start(), states = []; let child, closed = false, code, signal, output = '';
  const tasks = () => S.readLog(runtime).filter(row => row.scope === 'cli-task'), tools = () => S.readLog(audit).filter(row => row.type === 'tool');
  function snapshot(phase) { return { phase, requestCount: fixture.log.length, toolCount: tools().length, taskCount: tasks().length, notes: read('7CODER.md'), guard: read(F.guardFile), forbiddenExists: fs.existsSync(path.join(cwd, F.forbiddenFile)), real: fs.existsSync(path.join(cwd, F.file)) ? read(F.file) : null }; }
  async function until(fn, label, allowClosed) { const end = Date.now() + 10000; while (!(await fn())) { if (closed && !allowClosed) throw Error('G8 closed early: ' + code + ' ' + output.slice(-1800)); if (Date.now() >= end) throw Error(label + ': requests=' + fixture.log.length + ' fixture=' + fixture.errors.join(';') + ' output=' + output.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 10)); } }
  try {
    child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_ENDPOINT: fixture.endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: F.model, LIGHT_MODEL: 'g8-unused-light', SUMMARY_MODEL: 'g8-unused-summary',
      MAX_TOOL_STEPS: '2', CONTEXT_CHARS: '200000', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '20000' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
    child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', (value, why) => { code = value; signal = why; closed = true; });
    await until(() => output.includes('Commands:'), 'G8 ready'); child.stdin.write(F.prompts[0] + '\n/execute-task-now\n');
    await until(() => fixture.waiting(0), 'G8 actual notes request'); states.push(snapshot(0)); fixture.release(0);
    await until(() => tasks().length === 1 && output.includes(F.literalReply) && fs.existsSync(session), 'G8 content-only task complete'); states.push(snapshot(1));
    const firstSaved = JSON.parse(fs.readFileSync(session, 'utf8'));
    child.stdin.write(F.prompts[1] + '\n/execute-task-now\n'); await until(() => fixture.waiting(2), 'G8 actual structured write completed'); states.push(snapshot(2)); fixture.release(2);
    await until(() => tasks().length === 2 && output.includes(F.controlReply), 'G8 positive-control terminal');
    child.stdin.write('/clear\n'); await until(() => output.includes(F.clearMessage) && !fs.existsSync(session), 'G8 clear acknowledged'); states.push(snapshot(3));
    const clearProof = fixture.log.length === 3 && tasks().length === 2 && tools().length === 1 && !fs.existsSync(session);
    child.stdin.write(F.prompts[2] + '\n/execute-task-now\n'); await until(() => fixture.waiting(4), 'G8 new-session notes and actual read'); states.push(snapshot(4)); fixture.release(4);
    await until(() => tasks().length === 3 && output.includes(F.finalReply), 'G8 fenced plain-text completion');
    child.stdin.end('/bye\n'); await until(() => closed, 'G8 normal close', true); states.push(snapshot(5));
    return { code, signal, output, states, firstSaved, clearProof, saved: JSON.parse(fs.readFileSync(session, 'utf8')), log: fixture.log, errors: fixture.errors, runtime: S.readLog(runtime), audits: S.readLog(audit) };
  } finally {
    try { if (child && !closed) { child.kill(); await until(() => closed, 'G8 owned CLI cleanup', true); } }
    finally { await fixture.close(); }
  }
}
module.exports = { run };
