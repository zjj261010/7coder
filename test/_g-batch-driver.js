'use strict';
const fs = require('fs'), path = require('path');
async function run(S, spec) {
  const fixture = await spec.start(), cwd = S.freshCwd('g2-' + spec.kind), runtime = path.join(cwd, '.7coder', 'runtime.jsonl');
  let child, output = '', code, closed = false, signal;
  const tasks = () => S.readLog(runtime).filter(row => row.scope === 'cli-task');
  async function until(fn, label, allowClosed) { const end = Date.now() + 10000; while (!(await fn())) { if (closed && !allowClosed) throw Error('G2 closed early: ' + code + ' ' + output.slice(-1800)); if (Date.now() >= end) throw Error(label + ': requests=' + fixture.log.length + ' fixture=' + fixture.errors.join(';') + ' output=' + output.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 10)); } }
  try {
    child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_ENDPOINT: fixture.endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: spec.model, LIGHT_MODEL: 'g2-unused-light', SUMMARY_MODEL: 'g2-unused-summary',
      MAX_TOOL_STEPS: '2', CONTEXT_CHARS: '200000', PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '15000' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
    child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', (value, why) => { code = value; signal = why; closed = true; });
    await until(() => output.includes('Commands:'), 'G2 REPL ready');
    child.stdin.write(spec.prompt + '\n/execute-task-now\n'); await until(() => tasks().length === 1 && output.includes(spec.reply), 'G2 batch terminal');
    const batchProof = tasks()[0].status === 'ok' && fixture.log.length === 2 && S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).filter(row => row.type === 'tool').length === 25;
    const afterBatch = spec.kind === 'mixed' ? fs.readFileSync(path.join(cwd, spec.file), 'utf8') : null;
    child.stdin.write(spec.recovery + '\n/execute-task-now\n'); await until(() => tasks().length === 2 && output.includes(spec.recovered), 'G2 same Agent recovery');
    child.stdin.end('/bye\n'); await until(() => closed, 'G2 normal close', true);
    return { code, signal, output, batchProof, afterBatch, finalFile: spec.kind === 'mixed' ? fs.readFileSync(path.join(cwd, spec.file), 'utf8') : null,
      log: fixture.log, errors: fixture.errors, runtime: S.readLog(runtime), audits: S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')), hasWorklog: fs.existsSync(path.join(cwd, '7CODER.md')),
      saved: JSON.parse(fs.readFileSync(path.join(cwd, '.7coder', 'session.json'), 'utf8')) };
  } finally {
    try { if (child && !closed) { child.kill(); await until(() => closed, 'G2 owned CLI cleanup', true); } }
    finally { await fixture.close(); }
  }
}
module.exports = { run };
