'use strict';
const fs = require('fs'), path = require('path'), F = require('./_g-input-fixture');
// Test-only passive observer. It neither closes stdin nor changes callbacks,
// timers or product state; fd 3 acknowledges the actual readline close event.
const probeSource = `'use strict';
const fs = require('fs'), readline = require('readline'), original = readline.createInterface;
readline.createInterface = function () {
  const rl = original.apply(this, arguments);
  if (rl.input === process.stdin) {
    readline.createInterface = original;
    rl.once('close', () => {
      try { fs.writeSync(3, JSON.stringify({event:'stdin-readline-close',stdinEnded:process.stdin.readableEnded}) + '\\n'); }
      catch (error) { process.stderr.write('Probe failure: ' + error.message + '\\n'); }
    });
  }
  return rl;
};
`;
async function run(S, kind) {
  const fixture = await F.start(kind), cwd = S.freshCwd('g1-input-' + kind), runtime = path.join(cwd, '.7coder', 'runtime.jsonl');
  let child, closed = false, code, signal, output = '', control = '', controlBytes = 0, forced = false;
  const events = [], elapsed = start => { const value = process.hrtime(start); return value[0] * 1000 + value[1] / 1e6; };
  async function until(fn, label, allowClosed) { const start = process.hrtime(); while (!(await fn())) { if (closed && !allowClosed) throw Error('G1 input closed early: code=' + code + ' ' + output.slice(-1800)); if (elapsed(start) >= 10000) throw Error(label + ': calls=' + fixture.log.length + ' fixture=' + fixture.errors.join(';') + ' observer=' + control.slice(-1000) + ' output=' + output.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 10)); } }
  const tasks = () => S.readLog(runtime).filter(row => row.scope === 'cli-task');
  try {
    const args = [S.IDX];
    if (kind === 'eof') { const file = path.join(S.freshCwd('g1-eof-probe'), 'observe-readline.js'); fs.writeFileSync(file, probeSource); args.unshift('--require', file); }
    child = S.spawn(S.NODE_BIN, args, { cwd, stdio: kind === 'eof' ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { OPENAI_ENDPOINT: fixture.endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: F.main, LIGHT_MODEL: F.light, SUMMARY_MODEL: 'g-input-unused-summary',
        PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true', EXECUTION_TIMEOUT_MS: '20000' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-65536); }); }
    if (kind === 'eof') {
      child.stdio[3].setEncoding('utf8'); child.stdio[3].on('error', error => { output += 'Probe failure: ' + error.message; });
      child.stdio[3].on('data', text => {
        controlBytes += Buffer.byteLength(text);
        if (controlBytes > 4096) { output += 'Probe failure: observer budget'; child.stdio[3].destroy(); return; }
        control += text;
        let newline;
        while ((newline = control.indexOf('\n')) >= 0) { const line = control.slice(0, newline); control = control.slice(newline + 1); try { events.push(JSON.parse(line)); } catch (error) { output += 'Probe failure: invalid observation'; } }
      });
    }
    child.stdin.on('error', () => {}); child.once('error', error => { output += error.message; }); child.once('close', (value, why) => { code = value; signal = why; closed = true; });
    await until(() => output.includes('Commands:'), 'G1 input ready');
    if (kind === 'surface') {
      child.stdin.write('/execute-task-now\r\n'); await until(() => output.split('No task entered.').length === 2, 'G1 initial empty CRLF task');
      child.stdin.write('   \r\n/execute-task-now\r\n'); await until(() => output.split('No task entered.').length === 3, 'G1 whitespace-only draft');
      const emptyProof = fixture.log.length === 0 && tasks().length === 0;
      child.stdin.write('/btw\r\n/help\r\n/execute-task-now\r\n'); await until(() => tasks().length === 1 && output.includes(F.surfaceReply), 'G1 exact slash task completion');
      child.stdin.end('/BYE\r\n'); await until(() => closed, 'G1 surface normal uppercase quit', true);
      return { code, signal, output, emptyProof, log: fixture.log, errors: fixture.errors, runtime: S.readLog(runtime), audits: S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')),
        saved: JSON.parse(fs.readFileSync(path.join(cwd, '.7coder', 'session.json'), 'utf8')), hasBTW: fs.existsSync(path.join(cwd, '.7coder', 'BTW.md')), hasWorklog: fs.existsSync(path.join(cwd, '7CODER.md')) };
    }
    child.stdin.write(F.eofPrompt + '\n/execute-task-now\n'); await until(() => fixture.waiting(0), 'G1 EOF actual active model request');
    const admittedProof = fixture.log.length === 1 && tasks().length === 0 && !closed, start = process.hrtime(); child.stdin.end();
    await until(() => F.observedEOF(events), 'G1 actual stdin EOF observation');
    const eofProof = !closed && fixture.waiting(0) && tasks().length === 0 && fixture.log.length === 1;
    fixture.release(0); await until(() => fixture.waiting(1), 'G1 post-EOF actual tool and followup');
    const progressProof = !closed && tasks().length === 0 && fixture.log.length === 2 && S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).some(row => row.type === 'tool' && row.callId === F.call.id && row.status === 'ok');
    fixture.release(1); await until(() => closed, 'G1 natural EOF process close', true);
    return { code, signal, forced, elapsed: elapsed(start), output, admittedProof, eofProof, progressProof, events, log: fixture.log, errors: fixture.errors, runtime: S.readLog(runtime),
      audits: S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')), saved: JSON.parse(fs.readFileSync(path.join(cwd, '.7coder', 'session.json'), 'utf8')), hasWorklog: fs.existsSync(path.join(cwd, '7CODER.md')) };
  } finally {
    try { if (child && !closed) { forced = true; child.kill(); await until(() => closed, 'G1 owned input CLI cleanup', true); } }
    finally { await fixture.close(); }
  }
}
module.exports = { run };
