'use strict';
const fs = require('fs'), path = require('path'), F = require('./_g-prototype-fixture');
async function run(S) {
  const fixture = await F.start(), cwd = S.freshCwd('g3-literal-keys'), runtime = path.join(cwd, '.7coder', 'runtime.jsonl');
  const probe = path.join(S.freshCwd('g3-prototype-probe'), 'observe-prototype.js'); fs.copyFileSync(path.join(__dirname, '_g-prototype-observer.js'), probe);
  let child, closed = false, code, signal, output = '', control = '', controlBytes = 0;
  const observations = [], tasks = () => S.readLog(runtime).filter(row => row.scope === 'cli-task');
  async function until(fn, label, allowClosed) { const end = Date.now() + 10000; while (!(await fn())) { if (closed && !allowClosed) throw Error('G3 closed early: ' + code + ' ' + output.slice(-1800)); if (Date.now() >= end) throw Error(label + ': requests=' + fixture.log.length + ' fixture=' + fixture.errors.join(';') + ' observer=' + control.slice(-500) + ' output=' + output.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 10)); } }
  try {
    child = S.spawn(S.NODE_BIN, ['--require', probe, S.IDX], { cwd, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { OPENAI_ENDPOINT: fixture.endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: F.model, LIGHT_MODEL: 'g3-unused-light', SUMMARY_MODEL: 'g3-unused-summary',
      MAX_TOOL_STEPS: '4', CONTEXT_CHARS: '200000', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '15000' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
    child.stdio[3].setEncoding('utf8'); child.stdio[3].on('error', error => { output += 'Prototype probe failure: ' + error.message; });
    child.stdio[3].on('data', text => {
      controlBytes += Buffer.byteLength(text); if (controlBytes > 4096) { output += 'Prototype probe failure: observer budget'; child.stdio[3].destroy(); return; }
      control += text; let end;
      while ((end = control.indexOf('\n')) >= 0) { const line = control.slice(0, end); control = control.slice(end + 1); try { observations.push(JSON.parse(line)); } catch (error) { output += 'Prototype probe failure: invalid observation'; } }
    });
    child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', (value, why) => { code = value; signal = why; closed = true; });
    await until(() => output.includes('Commands:'), 'G3 ready');
    child.stdin.write(F.prompt + '\n/execute-task-now\n'); await until(() => tasks().length === 1 && output.includes(F.reply), 'G3 literal-key task terminal');
    const afterFirst = fs.readFileSync(path.join(cwd, F.file), 'utf8'), firstProof = tasks()[0].status === 'ok' && fixture.log.length === 4;
    child.stdin.write(F.recovery + '\n/execute-task-now\n'); await until(() => tasks().length === 2 && output.includes(F.recovered), 'G3 independent next task');
    child.stdin.end('/bye\n'); await until(() => closed, 'G3 normal close', true);
    return { code, signal, output, observations, firstProof, afterFirst, finalFile: fs.readFileSync(path.join(cwd, F.file), 'utf8'), log: fixture.log, errors: fixture.errors,
      runtime: S.readLog(runtime), audits: S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')), hasWorklog: fs.existsSync(path.join(cwd, '7CODER.md')),
      saved: JSON.parse(fs.readFileSync(path.join(cwd, '.7coder', 'session.json'), 'utf8')) };
  } finally {
    try { if (child && !closed) { child.kill(); await until(() => closed, 'G3 owned CLI cleanup', true); } }
    finally { await fixture.close(); }
  }
}
module.exports = { run };
