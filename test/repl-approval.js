// T22-08: original queue code + real Node REPL, isolated local model only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const readline = require('readline');
const { PassThrough } = require('stream');
const S = require('./_shared').create({ suite: 'repl-approval' });
// A pending Promise alone does not keep Node alive. Fail rather than silently
// exit 0 if an EOF regression leaves a unit-test Promise unresolved.
const suiteDeadline = setTimeout(() => { console.error('REPL/APPROVAL suite deadline'); S.cleanup(); process.exit(1); }, 60000);
const source = fs.readFileSync(S.IDX, 'utf8');
const sandbox = { setInterval, clearInterval };
const start = source.indexOf('function createCliQuestionQueue(');
const end = source.indexOf('async function askApproval(', start);
assert.ok(start >= 0 && end > start, 'queue source boundaries');
vm.runInNewContext(source.slice(start, end), sandbox);
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(predicate, description) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Timed out: ' + description);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function reply(res, body, message) {
  if (body.stream) {
    const delta = Object.assign({}, message);
    delete delta.role;
    if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((t, index) => Object.assign({ index }, t));
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant' }, message) }] }));
  }
}
async function cli(name, handle, drive) {
  const cwd = S.freshCwd(name);
  // Fake values in a disposable workspace; never use real credentials/config.
  fs.writeFileSync(path.join(cwd, '.env'), 'FIXTURE_A=FAKE_ALPHA\n');
  fs.writeFileSync(path.join(cwd, '.npmrc'), 'fixture=FAKE_BETA\n');
  let fixtureError = null;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d);
    req.on('end', () => {
      try { handle(JSON.parse(raw), res); }
      catch (e) { fixtureError = e; res.statusCode = 500; res.end('fixture error'); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, {
    OPENAI_API_KEY: 'fixture', OPENAI_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/v1',
    HEAVY_MODEL: 'fixture', LIGHT_MODEL: 'fixture', SUMMARY_MODEL: 'fixture', MAX_RETRIES: '1',
    PERMISSION_MODE: 'default', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_HTTP_SERVER: 'false'
  }) });
  let out = '', code = null, closed = false;
  child.stdout.on('data', d => out += d.toString());
  child.stderr.on('data', d => out += d.toString());
  child.stdin.on('error', () => {});
  child.on('close', value => { code = value; closed = true; });
  const state = {
    write: text => child.stdin.write(text), end: () => child.stdin.end(), cwd,
    output: () => out,
    wait: (predicate, label) => until(() => {
      if (fixtureError) throw fixtureError;
      if (closed && !predicate(out)) throw Error(name + ' exited early (' + code + '): ' + out);
      return predicate(out);
    }, name + ': ' + label)
  };
  try {
    await state.wait(t => t.includes('Commands:'), 'REPL ready');
    await drive(state);
    await until(() => closed, name + ' exit');
    if (fixtureError) throw fixtureError;
    check(name + ' clean exit without hidden task/REPL errors', code === 0 && !/\[ERROR\]|\[REPL\]|UnhandledPromiseRejection/.test(out));
  } catch (e) { e.message += '\nREPL output:\n' + out; throw e; }
  finally {
    if (!closed) child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
function toolCalls() {
  return ['.env', '.npmrc'].map((file, i) => ({ id: 'read' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }));
}
const count = (text, needle) => text.split(needle).length - 1;
(async () => {
  try {
    const input = new PassThrough(), output = new PassThrough();
    const rl = readline.createInterface({ input, output });
    const shown = [];
    const queue = sandbox.createCliQuestionQueue(q => shown.push(q));
    rl.on('line', line => queue.answer(line));
    rl.on('close', () => queue.close());
    const first = queue.ask('first'), second = queue.ask('second');
    check('only first question is shown', shown.join(',') === 'first');
    input.write('yes\n');
    check('first answer settles exactly one question', await first === 'yes' && shown.join(',') === 'first,second' && queue.hasPending());
    input.write('no\n');
    check('second question retains its own answer', await second === 'no' && !queue.hasPending());
    const pending = [queue.ask('EOF-active'), queue.ask('EOF-queued')];
    input.end();
    check('real readline EOF settles active and queued questions', (await Promise.all(pending)).every(v => v === null) && !queue.hasPending());
    check('closed queue rejects future questions without prompting', await queue.ask('closed') === null && !shown.includes('closed'));

    const cancelledQueue = sandbox.createCliQuestionQueue(q => shown.push(q));
    let cancelActive = false, cancelQueued = false;
    let activeSettled = false, queuedSettled = false;
    const active = cancelledQueue.ask('cancel-active', () => cancelActive).then(v => { activeSettled = v === null; });
    const removed = cancelledQueue.ask('cancel-queued', () => cancelQueued).then(v => { queuedSettled = v === null; });
    const survivor = cancelledQueue.ask('survivor');
    cancelQueued = true;
    await until(() => queuedSettled, 'queued cancellation');
    check('queued cancellation settles without displaying it', !shown.includes('cancel-queued') && !activeSettled);
    cancelActive = true;
    await until(() => activeSettled, 'active cancellation');
    check('active cancellation advances to surviving question', shown[shown.length - 1] === 'survivor');
    cancelledQueue.answer('survived');
    check('cancellation does not poison next question', await survivor === 'survived' && !cancelledQueue.hasPending());
    await Promise.all([active, removed]); cancelledQueue.close();

    let mainCalls = 0, paired = [];
    await cli('two-approvals', (body, res) => {
      if (!body.tools) return reply(res, body, { content: 'local explanation or summary' });
      mainCalls++;
      if (mainCalls === 1) return reply(res, body, { content: '', tool_calls: toolCalls() });
      paired = body.messages.filter(m => m.role === 'tool');
      reply(res, body, { content: 'PAIR_COMPLETE' });
    }, async c => {
      c.write('read two fixture files\n/execute-task-now\n');
      await c.wait(t => count(t, 'Execute read_file?') === 1, 'first approval');
      check('real parallel reads show one pending approval', !c.output().includes('PAIR_COMPLETE'));
      c.write('y\n');
      await c.wait(t => count(t, 'Execute read_file?') === 2, 'second approval');
      c.write('n\n');
      await c.wait(t => t.includes('PAIR_COMPLETE') && t.includes('[USAGE]'), 'task completion');
      check('both parallel tool results return, with one refusal', mainCalls === 2 && paired.length === 2 && paired.filter(t => /FAKE_ALPHA|FAKE_BETA/.test(t.content)).length === 1 && paired.filter(t => /User declined/.test(t.content)).length === 1);
      c.write('/bye\n');
    });

    mainCalls = 0;
    await cli('approval-eof', (body, res) => {
      if (!body.tools) return reply(res, body, { content: 'fixture summary' });
      if (++mainCalls === 1) return reply(res, body, { content: '', tool_calls: toolCalls() });
      const results = body.messages.filter(m => m.role === 'tool');
      check('EOF declines both protected reads and completes tool pairing', results.length === 2 && results.every(t => /User declined/.test(t.content)));
      reply(res, body, { content: 'EOF_COMPLETE' });
    }, async c => {
      c.write('read fixture\n/execute-task-now\n');
      await c.wait(t => t.includes('Execute read_file?'), 'pending approval');
      c.end();
      await c.wait(t => t.includes('EOF_COMPLETE'), 'completion after EOF');
    });

    let held, noteCalls = 0, taskBodies = [];
    await cli('btw-order', (body, res) => {
      if (!body.tools) {
        if (body.messages[0].content.includes('BTW sub-agent')) {
          noteCalls++;
          if (noteCalls === 1) { held = () => reply(res, body, { content: 'NOTE_ONE' }); return; }
          return reply(res, body, { content: 'NOTE_TWO' });
        }
        return reply(res, body, { content: 'fixture summary' });
      }
      taskBodies.push(body.messages.filter(m => m.role === 'user').slice(-1)[0].content);
      reply(res, body, { content: 'TASK_' + taskBodies.length + '_COMPLETE' });
    }, async c => {
      c.write('BASE_TASK\n/btw one\n/btw two\n/execute-task-now\n/execute-task-now\nNEXT_DRAFT\n');
      await c.wait(t => t.includes('A task is already running') && !!held, 'lock held while waiting for notes');
      check('second note waits for first and no task runs early', noteCalls === 1 && taskBodies.length === 0);
      held();
      await c.wait(t => t.includes('TASK_1_COMPLETE') && count(t, '[USAGE]') === 1, 'first task');
      check('all prior notes reach one task in order; future draft is excluded', taskBodies.length === 1 && taskBodies[0].includes('BASE_TASK') && taskBodies[0].indexOf('NOTE_ONE') < taskBodies[0].indexOf('NOTE_TWO') && taskBodies[0].includes('NOTE_ONE') && !taskBodies[0].includes('NEXT_DRAFT'));
      c.write('/execute-task-now\n');
      await c.wait(t => t.includes('TASK_2_COMPLETE') && count(t, '[USAGE]') === 2, 'next task');
      check('next draft survives earlier task and contains no old notes', taskBodies.length === 2 && taskBodies[1] === 'NEXT_DRAFT');
      const log = fs.readFileSync(path.join(c.cwd, '.7coder', 'BTW.md'), 'utf8');
      check('both notes are persisted in order', log.indexOf('Original note: one') >= 0 && log.indexOf('Original note: one') < log.indexOf('Original note: two'));
      c.write('/bye\n');
    });

    held = null; taskBodies = [];
    await cli('btw-clear', (body, res) => {
      if (!body.tools) {
        if (body.messages[0].content.includes('BTW sub-agent')) { held = () => reply(res, body, { content: 'DISCARDED_NOTE' }); return; }
        return reply(res, body, { content: 'fixture summary' });
      }
      taskBodies.push(body.messages.filter(m => m.role === 'user').slice(-1)[0].content);
      reply(res, body, { content: 'CLEAR_COMPLETE' });
    }, async c => {
      c.write('/btw discard this\n');
      await c.wait(() => !!held, 'pending old note');
      c.write('/clear\nFRESH_DRAFT\n');
      await c.wait(t => t.includes('[OK] Conversation cleared.'), 'clear');
      held();
      await c.wait(t => t.includes('DISCARDED_NOTE'), 'old callback');
      c.write('/execute-task-now\n');
      await c.wait(t => t.includes('CLEAR_COMPLETE') && t.includes('[USAGE]'), 'fresh task');
      check('stale BTW callback cannot contaminate cleared draft', taskBodies.length === 1 && taskBodies[0].includes('FRESH_DRAFT') && !taskBodies[0].includes('DISCARDED_NOTE'));
      c.write('/bye\n');
    });
    console.log('REPL/APPROVAL: ' + checks + '/' + checks);
  } finally { clearTimeout(suiteDeadline); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
