// Committed assistant batches must stay paired even when execution is aborted.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const S = require('./_shared').create({ suite: 'tool-history-recovery' });
const source = fs.readFileSync(S.IDX, 'utf8');
function cut(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start); return source.slice(start, end); }
const loop = cut('function checkExecution(', 'function watchExecution(') + cut('async function processWithTools(', '// ====================== TASK CHANGE SUMMARY');
const call = id => ({ id, type: 'function', function: { name: 'fixture', arguments: '{}' } });
const scope = process.env.TOOL_HISTORY_SCOPE || 'all';
assert.ok(scope === 'all' || scope === 'real', 'unknown history test scope');
let checks = 0, child, server, closed = false;
const sockets = new Set();
const deadline = setTimeout(() => { console.error('TOOL/HISTORY deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function paired(history) {
  let ids = [];
  for (const message of history) {
    if (message.role === 'tool') {
      const at = ids.indexOf(message.tool_call_id);
      assert.ok(at >= 0, 'orphan/duplicate tool response'); ids.splice(at, 1);
    } else {
      assert.strictEqual(ids.length, 0, 'assistant batch has unanswered IDs');
      if (message.tool_calls) ids = message.tool_calls.map(tc => tc.id);
    }
  }
  assert.strictEqual(ids.length, 0, 'history ends with unanswered IDs');
  return true;
}
function setup(options = {}) {
  let rounds = 0, started = [], callbacks = [];
  const history = [{ role: 'user', content: 'first' }];
  const c = vm.createContext(Object.assign({ MAX_TOOL_STEPS: 3, HEAVY_MODEL: 'fixture', createModelContext: main => ({ main }),
    compressConversationIfNeeded: async () => {}, capToolResult: String, READ_ONLY_TOOLS: new Set(),
    callOpenAI: async messages => { paired(messages); return { message: rounds++ === 0 ? { role: 'assistant', content: null, tool_calls: ['a','b','c'].map(call) } : { role: 'assistant', content: 'RECOVERED' } }; },
    safeExecuteTool: async tc => { started.push(tc.id); return 'DONE-' + tc.id; }
  }, options));
  vm.runInContext(loop, c);
  return { c, history, started, callbacks, replies: () => history.filter(m => m.role === 'tool'), run: opts => c.processWithTools(history, Object.assign({ onToolResult: (name, args, result, id) => callbacks.push(id) }, opts)) };
}
const ownerError = () => Object.assign(new Error('owned cleanup pending'), { code: 'EOWNERCLEANUP' });
async function until(predicate, label) {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw Error('Timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function reply(res, body, message) {
  if (!body.stream) { res.end(JSON.stringify({ choices: [{ message }] })); return; }
  const delta = Object.assign({}, message); delete delta.role;
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((tc, index) => Object.assign({ index }, tc));
  res.setHeader('Content-Type', 'text/event-stream');
  res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
}
(async () => {
  try {
    if (scope === 'all') {
    let cancelled = false;
    let f = setup();
    await f.run({ cancel: () => cancelled, onToolCall: () => { cancelled = true; } });
    check('cancel after announcements records only not-started replies without fake results', paired(f.history) && f.started.length === 0 && f.callbacks.length === 0 && f.replies().every(m => m.content.includes('not executed')));

    cancelled = false;
    f = setup({ safeExecuteTool: async tc => { f.started.push(tc.id); cancelled = true; return 'DONE-' + tc.id; } });
    await f.run({ cancel: () => cancelled });
    check('serial cancellation preserves completed result and marks later calls unstarted', paired(f.history) && f.started.join() === 'a' && f.replies()[0].content === 'DONE-a' && f.replies().slice(1).every(m => m.content.includes('not executed')) && f.callbacks.join() === 'a');
    cancelled = false; f.history.push({ role: 'user', content: 'next' });
    check('next request satisfies strict pairing without repeating the completed call', await f.run() === 'RECOVERED' && f.started.join() === 'a');

    const fatal = ownerError();
    f = setup({ safeExecuteTool: async tc => { f.started.push(tc.id); if (tc.id === 'b') throw fatal; return 'DONE-' + tc.id; } });
    await assert.rejects(f.run(), e => e === fatal);
    check('serial fatal error distinguishes completed, unknown and unstarted calls', paired(f.history) && f.started.join() === 'a,b' && f.replies()[0].content === 'DONE-a' && f.replies()[1].content.includes('outcome unknown') && f.replies()[2].content.includes('not executed'));

    let blocked = false;
    f = setup({ child_process: { assertProcessOwnerReady() { if (blocked) throw fatal; } }, safeExecuteTool: async tc => { f.started.push(tc.id); blocked = true; return 'COMPLETED'; } });
    await assert.rejects(f.run(), e => e === fatal);
    check('post-tool ownership guard keeps actual result even before UI delivery', paired(f.history) && f.replies()[0].content === 'COMPLETED' && f.callbacks.length === 0 && f.started.join() === 'a');

    f = setup();
    await assert.rejects(f.run({ onToolResult: () => { throw Error('consumer failed'); } }), /consumer failed/);
    check('serial result consumer failure cannot lose result or start remaining calls', paired(f.history) && f.replies()[0].content === 'DONE-a' && f.started.join() === 'a' && f.replies()[1].content.includes('not executed'));

    let release, settled = false, completedSibling = false;
    const held = new Promise(resolve => { release = resolve; });
    f = setup({ READ_ONLY_TOOLS: new Set(['fixture']), safeExecuteTool: async tc => {
      f.started.push(tc.id); if (tc.id === 'a') throw fatal;
      if (tc.id === 'b') { await held; completedSibling = true; }
      return 'DONE-' + tc.id;
    } });
    const pending = f.run().then(() => { throw Error('fatal error swallowed'); }, error => { assert.strictEqual(error, fatal); settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    check('parallel fatal error does not release task while admitted sibling is pending', !settled && !completedSibling && f.started.join() === 'a,b,c');
    release(); await pending;
    check('parallel cleanup waits all siblings and preserves results without fake callbacks', paired(f.history) && settled && completedSibling && f.replies()[0].content.includes('outcome unknown') && f.replies()[1].content === 'DONE-b' && f.replies()[2].content === 'DONE-c' && f.callbacks.length === 0);

    f = setup({ READ_ONLY_TOOLS: new Set(['fixture']) });
    await assert.rejects(f.run({ onToolResult: () => { throw Error('parallel consumer failed'); } }), /parallel consumer failed/);
    check('parallel consumer failure retains every completed result exactly once', paired(f.history) && f.replies().map(m => m.content).join() === 'DONE-a,DONE-b,DONE-c');

    f = setup({ READ_ONLY_TOOLS: new Set(['fixture']), safeExecuteTool: async tc => { if (tc.id === 'b') throw Error('ordinary failure'); return 'DONE-' + tc.id; } });
    await f.run();
    check('ordinary parallel tool errors retain established model-visible behavior', paired(f.history) && f.replies()[1].content === 'Tool error: ordinary failure' && f.callbacks.join() === 'a,b,c');
    }

    // Real persistent REPL: a completed read, timed-out write approval, and a
    // third invocation that must never start. The next model enforces pairing.
    let fixtureError, mainRequests = 0, recoveredHistory;
    server = http.createServer((req, res) => {
      let raw = ''; req.setEncoding('utf8'); req.on('data', d => { raw += d; }); req.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (!body.tools) return reply(res, body, { role: 'assistant', content: 'fixture summary' });
          paired(body.messages); mainRequests++;
          if (mainRequests === 1) {
            const tools = [['read_file', { path: 'done.txt' }], ['write_file', { path: 'pending.txt', content: 'must not write' }], ['write_file', { path: 'unstarted.txt', content: 'must not write' }]];
            return reply(res, body, { role: 'assistant', content: null, tool_calls: tools.map(([name, args], i) => ({ id: 'real-' + i, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
          }
          recoveredHistory = body.messages;
          reply(res, body, { role: 'assistant', content: 'STRICT_HISTORY_RECOVERED' });
        } catch (error) { fixtureError = error; res.statusCode = 400; res.end('strict fixture rejected history'); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const cwd = S.freshCwd('real-repl'); fs.writeFileSync(path.join(cwd, 'done.txt'), 'REAL_READ_COMPLETE');
    child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, {
      OPENAI_API_KEY: 'fixture', OPENAI_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/v1', HEAVY_MODEL: 'fixture', LIGHT_MODEL: 'fixture', SUMMARY_MODEL: 'fixture',
      MAX_RETRIES: '1', PERMISSION_MODE: 'default', EXECUTION_TIMEOUT_MS: '1000', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_HTTP_SERVER: 'false', AUDIT_LOG: 'true'
    }) });
    let output = '', exitCode;
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; }); child.stdin.on('error', () => {});
    child.on('close', code => { exitCode = code; closed = true; });
    const wait = (predicate, label) => until(() => {
      if (fixtureError) throw fixtureError;
      if (closed && !predicate()) throw Error('REPL closed ' + exitCode + ': ' + output);
      return predicate();
    }, label).catch(error => { error.message += '\nREPL output:\n' + output; throw error; });
    await wait(() => output.includes('Commands:'), 'REPL ready');
    child.stdin.write('INTERRUPT_FIRST\n/execute-task-now\n');
    await wait(() => output.includes('Execute write_file?'), 'write approval');
    await wait(() => output.includes('[ERROR]') && output.includes('[USAGE]'), 'first task timeout');
    check('real approval timeout stops before both writes with one completed read', !fs.existsSync(path.join(cwd, 'pending.txt')) && !fs.existsSync(path.join(cwd, 'unstarted.txt')) && S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).filter(row => row.type === 'tool').map(row => row.callId).join() === 'real-0,real-1');
    child.stdin.write('NEXT_AFTER_TIMEOUT\n/execute-task-now\n');
    await wait(() => output.includes('STRICT_HISTORY_RECOVERED'), 'strict next turn');
    const replies = recoveredHistory.filter(m => m.role === 'tool');
    check('same real REPL sends complete truthful history to next strict request', mainRequests === 2 && paired(recoveredHistory) && replies.length === 3 && replies[0].content.includes('REAL_READ_COMPLETE') && /aborted|cancelled/i.test(replies[1].content) && replies[2].content.includes('not executed'));
    check('history repair does not fabricate unstarted audit or repeat completed tool', S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).filter(row => row.type === 'tool').map(row => row.callId).join() === 'real-0,real-1');
    await wait(() => (output.match(/\[USAGE\]/g) || []).length === 2, 'second task completion');
    child.stdin.write('/bye\n'); await wait(() => closed, 'REPL shutdown');
    check('explicit REPL quit succeeds after recovery without protocol/unhandled error', exitCode === 0 && output.includes('Execution deadline exceeded') && !/strict fixture rejected|UnhandledPromiseRejection|\[REPL\]/.test(output));
    const expected = scope === 'all' ? 14 : 4;
    assert.strictEqual(checks, expected); console.log('TOOL/HISTORY ' + scope + ' ' + checks + '/' + expected);
  } finally {
    clearTimeout(deadline); if (child && !closed) child.kill();
    for (const socket of sockets) socket.destroy(); if (server) await new Promise(resolve => server.close(resolve));
    S.cleanup();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
