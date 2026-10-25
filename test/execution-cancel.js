// T22-06 first slice: actual Axios transports, cancellation boundaries,
// approval ownership and a real isolated backend. No real model or desktop.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const axios = require('axios');
const S = require('./_shared').create({ suite: 'execution-cancel' });
const source = fs.readFileSync(S.IDX, 'utf8');
const sockets = new Set(), requests = [];
let fixture, app, checks = 0;
const tail = process.env.CANCEL_PHASE === 'tail';
const limit = setTimeout(() => { console.error('EXECUTION/CANCEL suite deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, condition) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundary: ' + from);
  return source.slice(start, end);
}
async function until(predicate, label) {
  const end = Date.now() + 6000;
  while (!await predicate()) {
    if (Date.now() > end) throw Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function observed(promise) { return promise.then(value => ({ value }), error => ({ error })); }
function send(res, body, message) {
  if (body.stream) {
    const delta = Object.assign({}, message);
    if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((t, index) => Object.assign({ index }, t));
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant' }, message) }] }));
  }
}
function startChat(port, job, stream) {
  let text = '';
  const data = JSON.stringify({ stream, messages: [{ role: 'user', content: job }] });
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    res.on('data', d => text += d.toString()); res.on('error', () => {});
  });
  req.on('error', () => {}); req.end(data);
  return { stop: () => req.destroy(), text: () => text };
}
(async () => {
  const controls = [];
  try {
    fixture = http.createServer((req, res) => {
      let raw = ''; req.on('data', d => raw += d);
      req.on('end', () => {
        const body = JSON.parse(raw);
        const prompt = body.messages.map(m => String(m.content || '')).join('\n');
        const job = (prompt.match(/CANCEL_[A-Z_]+/) || [''])[0];
        const item = { body, job, closed: false }; requests.push(item);
        res.on('close', () => { item.closed = true; });
        if (job === 'CANCEL_RETRY') { res.statusCode = 503; res.end('{}'); return; }
        if (job === 'CANCEL_HEADERS' || job === 'CANCEL_JSON') return;
        if (job === 'CANCEL_STREAM' || job === 'CANCEL_DEADLINE') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(': upstream waiting\n\n'); return;
        }
        if (job === 'CANCEL_APPROVAL') {
          send(res, body, { tool_calls: [{ id: 'write-after-approval', type: 'function', function: {
            name: 'write_file', arguments: JSON.stringify({ path: 'must-not-exist.txt', content: 'late write' })
          } }] }); return;
        }
        if (job === 'CANCEL_SUMMARY' && prompt.startsWith('Create a short, concise summary')) return;
        send(res, body, { content: job === 'CANCEL_SUMMARY' ? 'Long reply '.repeat(30) : 'RECOVERED' });
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + fixture.address().port;
    const ctx = vm.createContext({ axios, Buffer, MODEL_RESPONSE_MAX_BYTES: 8 * 1024 * 1024, setTimeout, clearTimeout, setInterval, clearInterval, console: { log() {}, warn() {}, error() {} },
      EXECUTION_TIMEOUT_MS: 5000, TEMPERATURE: 0, MAX_TOKENS: 100, MAX_RETRIES: 3, tools: [], HEAVY_MODEL: 'fixture',
      LIGHT_MODEL: 'fixture', SUMMARY_MODEL: 'fixture', SUMMARY_MAX_TOKENS: 100, CONTEXT_CHARS: 1000,
      resolveModelConfig: () => ({ endpoint, apiKey: '' }), authHeadersFor: () => ({}), recordUsage: () => {},
      approvalSeq: 0, pendingApprovals: new Map() });
    vm.runInContext(cut('function executionCancelledError(', '// ====================== RISK CLASSIFICATION') +
      cut('function createHttpApprovalBridge(', '// One owner of stdin questions.'), ctx);
    function control(ms = 5000) { const token = ctx.createExecutionControl(ms); controls.push(token); return token; }
    if (!tail) {
    for (const [job, stream] of [['CANCEL_HEADERS', true], ['CANCEL_JSON', false], ['CANCEL_STREAM', true]]) {
      const token = control(), begin = requests.length;
      const result = observed(ctx.callOpenAI([{ role: 'user', content: job }], { cancel: token, onDelta: stream ? () => {} : null }));
      await until(() => requests.length > begin, job + ' request');
      token.cancel('fixture cancellation');
      const r = await result;
      await until(() => requests[begin].closed, job + ' upstream close');
      check(job + ' actively closes transport and never retries', r.error && r.error.code === 'EXECUTION_CANCELLED' && requests.length === begin + 1);
      token.dispose();
    }
    const retry = control(), startRetry = requests.length;
    const retried = observed(ctx.callOpenAI([{ role: 'user', content: 'CANCEL_RETRY' }], { cancel: retry }));
    await until(() => requests.length > startRetry && requests[startRetry].closed, 'first retry response');
    retry.cancel('cancel retry wait');
    check('retry backoff is interrupted without starting another attempt', (await retried).error.code === 'EXECUTION_CANCELLED' && requests.length === startRetry + 1);
    retry.dispose();
    const expiry = control(80);
    const expired = await observed(ctx.callOpenAI([{ role: 'user', content: 'CANCEL_DEADLINE' }], { cancel: expiry, onDelta: () => {} }));
    check('shared deadline actively aborts stalled model stream', expired.error && expired.error.code === 'EXECUTION_CANCELLED' && expiry.reason === 'Execution deadline exceeded.');
    expiry.dispose();

    vm.runInContext(cut('async function classifyRisk(', '// ====================== STRUCTURED TASK STORE') +
      cut('function charUnits(', '// ====================== TASK CHANGE SUMMARY') +
      cut('async function summarizeAction(', '// Task summaries live inside'), ctx);
    for (const [name, args] of [
      ['classifyRisk', ['CANCEL_HEADERS', {}, undefined]],
      ['getPermissionExplanation', ['CANCEL_HEADERS', {}, 'LOW', undefined]],
      ['isAutoApprovalSafe', ['CANCEL_HEADERS', {}, 'LOW', undefined]],
      ['summarizeAction', ['CANCEL_HEADERS', 'long answer '.repeat(30), undefined]]
    ]) {
      const token = control(), begin = requests.length;
      const result = observed(ctx[name](...args, token));
      await until(() => requests.length > begin, name + ' upstream'); token.cancel('stop helper');
      check(name + ' inherits active cancellation without success or fallback', (await result).error.code === 'EXECUTION_CANCELLED');
      token.dispose();
    }
    const history = [{ role: 'system', content: 'system' }, { role: 'user', content: 'CANCEL_HEADERS ' + 'x'.repeat(1600) },
      { role: 'assistant', content: 'old answer '.repeat(30) }, { role: 'user', content: 'continue' }];
    const original = JSON.stringify(history), compress = control(), beginCompress = requests.length;
    const compressed = observed(ctx.compressConversationIfNeeded(history, undefined, compress));
    await until(() => requests.length > beginCompress, 'compression upstream'); compress.cancel('cancel summary');
    check('cancelled compression preserves complete original history', !!(await compressed).error && JSON.stringify(history) === original);
    compress.dispose();

    const writes = [], approval = control();
    const bridge = ctx.createHttpApprovalBridge({ destroyed: false, write: chunk => writes.push(chunk) }, approval);
    const waiting = bridge.ask('approve?');
    const id = JSON.parse(writes[0].slice(6)).approval_request.id;
    const lateApproval = ctx.pendingApprovals.get(id);
    approval.cancel('disconnect');
    lateApproval(true);
    check('cancel removes pending approval immediately and late approval cannot revive it',
      await waiting === false && ctx.pendingApprovals.size === 0 && bridge.pending.size === 0 && await bridge.ask('again?') === false && writes.length === 1);
    bridge.dispose(); approval.dispose();

    // Real permission function with a deliberately late successful approval.
    const gate = vm.createContext({ path, console: { log() {}, warn() {} }, DANGER_MODE: false, workflowStepDepth: 0,
      effectivePermissionMode: () => 'default', isProtectedTarget: () => false, matchPermRule: () => null,
      isSuperDangerous: () => false, getToolMetadata: () => ({ risk: 'LOW', explain: () => 'fixture' }),
      makeToolResult: (status, text) => ({ status, text }) });
    vm.runInContext(cut('async function safeExecuteToolInner(', '// ====================== APPROVAL'), gate);
    let executed = 0;
    const late = control();
    gate.askApproval = async () => { late.cancel('approval arrived after disconnect'); return true; };
    gate.executeToolRaw = async () => { executed++; return 'unexpected'; };
    const blocked = await gate.safeExecuteToolInner({ function: { name: 'run_command', arguments: '{"command":"fixture"}' } }, [], null, late, {});
    check('late successful approval cannot start a command or write', blocked.status === 'cancelled' && executed === 0);
    late.dispose();

    // A disposed controller removes its deadline timer rather than cancelling
    // completed work later. Inspect owned timers without waiting for expiry.
    const timers = new Set();
    const timersCtx = { EXECUTION_TIMEOUT_MS: 5000,
      setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) };
    vm.runInNewContext(cut('function createExecutionControl(', 'function waitForExecution('), timersCtx);
    const completed = timersCtx.createExecutionControl(); completed.dispose();
    check('completed execution releases its deadline timer', timers.size === 0 && !completed());
    }

    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const cwd = S.freshCwd('cancel-backend');
    const child = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, {
      HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', OPENAI_ENDPOINT: endpoint,
      OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', LIGHT_MODEL: '', SUMMARY_MODEL: '',
      PERMISSION_MODE: 'default', DREAM_ALLOW: 'false', EXECUTION_TIMEOUT_MS: '1500', MAX_RETRIES: '3'
    }) });
    app = { child }; let output = ''; app.output = () => output;
    child.stdout.on('data', d => output += d.toString()); child.stderr.on('data', d => output += d.toString());
    const api = (method, url, data = null) => S.httpReq(port, method, url, data);
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error('backend exited: ' + output);
      try { return (await api('GET', '/api/info')).status === 200; }
      catch (e) { if (!['ECONNREFUSED', 'ECONNRESET'].includes(e.code)) throw e; return false; }
    }, 'backend ready');
    for (const [job, stream] of [['CANCEL_HEADERS', true], ['CANCEL_JSON', false], ['CANCEL_STREAM', true]]) {
      if (tail && job !== 'CANCEL_STREAM') continue;
      const begin = requests.length, chat = startChat(port, job, stream);
      await until(() => requests.length > begin, job + ' backend upstream');
      chat.stop();
      await until(() => requests[begin].closed, job + ' backend cancels upstream');
      const next = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'RECOVERY' }] });
      check(job + ' backend disconnect releases gate only after settlement; next request succeeds', next.status === 200 && next.body.includes('RECOVERED'));
    }
    const approvalChat = startChat(port, 'CANCEL_APPROVAL', true);
    await until(() => approvalChat.text().includes('approval_request'), 'stream approval');
    const match = approvalChat.text().match(/data: (\{"approval_request"[^\n]+)\n/);
    assert.ok(match, 'approval event exists');
    const approvalId = JSON.parse(match[1]).approval_request.id;
    approvalChat.stop();
    // A following chat passing the gate proves the old approval wait settled.
    const next = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'RECOVERY' }] });
    const rejected = await api('POST', '/api/approve', { id: approvalId, approved: true });
    check('real disconnect revokes approval; next chat succeeds and stale approval returns 400',
      next.status === 200 && rejected.status === 400 && !fs.existsSync(path.join(cwd, 'must-not-exist.txt')));
    const timed = await api('POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'CANCEL_DEADLINE' }] });
    const afterTimeout = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'RECOVERY' }] });
    check('real deadline ends stuck turn and leaves core loop available', timed.body.includes('Execution deadline exceeded') && afterTimeout.status === 200);
    const summary = await api('POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'CANCEL_SUMMARY' }] });
    const afterSummary = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'RECOVERY' }] });
    check('normal stream close permits summary, but its remaining deadline releases the gate without fallback write',
      summary.body.includes('[DONE]') && requests.some(r => r.job === 'CANCEL_SUMMARY' && String(r.body.messages[0].content).startsWith('Create a short, concise summary')) &&
      afterSummary.status === 200 && !fs.existsSync(path.join(cwd, '7CODER.md')));
    check('server survives all cancellation paths', child.exitCode === null && child.signalCode === null);
    console.log('EXECUTION/CANCEL: ' + checks + '/' + checks + (tail ? '; selected tail only; first 15 checks NOT RUN' : ''));
  } catch (error) {
    console.error('CANCEL diagnostics: ' + JSON.stringify(requests.map(r => ({ job: r.job, stream: r.body.stream, closed: r.closed }))));
    if (app && app.output) console.error('CANCEL backend: ' + app.output().slice(-8000));
    throw error;
  } finally {
    clearTimeout(limit);
    for (const token of controls) token.dispose();
    S.cleanup();
    for (const socket of sockets) socket.destroy();
    if (fixture) await new Promise(resolve => fixture.close(resolve));
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
