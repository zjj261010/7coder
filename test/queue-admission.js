// Bounded/cancellable admission, real streams, and real isolated HTTP Agent.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { PassThrough } = require('stream');
const S = require('./_shared').create({ suite: 'queue-admission' });
const source = fs.readFileSync(S.IDX, 'utf8'), contexts = [], sockets = new Set(), clients = [];
let checks = 0, fixture, app, releaseMain, releaseSummary;
const deadline = setTimeout(() => { console.error('QUEUE/ADMISSION deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from); return source.slice(start, end);
}
async function until(predicate, label, ms = 5000) {
  const end = Date.now() + ms;
  while (!await predicate()) { if (Date.now() >= end) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
function context(summary) {
  const writes = [], warnings = [], ctx = vm.createContext({ Buffer, Date, setTimeout: (fn, ms) => setTimeout(fn, ms === 60000 ? 60 : ms), clearTimeout,
    setInterval, clearInterval, EXECUTION_TIMEOUT_MS: 5000, shuttingDown: false,
    console: { warn: msg => warnings.push(msg) }, updateCompleteSummary: value => { if (value) writes.push(value); },
    summarizeAction: summary || (async () => 'summary') });
  vm.runInContext(cut('function executionCancelledError(', 'function parseSSEStream(') +
    cut('const CHAT_MAX_REQUESTS =', 'function effectivePermissionMode()') +
    cut('function createActionSummaryQueue(', 'function updateCompleteSummary(') +
    cut('function readJsonBody(', 'function startHttpServer()') +
    'this.state=()=>({active:requestGateBusy,queued:requestGateQueue.length,count:chatAdmission.count,bytes:chatAdmission.bytes});', ctx);
  ctx.writes = writes; ctx.warnings = warnings; contexts.push(ctx); return ctx;
}
function response() {
  return { destroyed: false, writableEnded: false, writeHead(code) { this.code = code; }, end(body) { this.body = body; this.writableEnded = true; } };
}
function chat(port, job, stream = false, content) {
  const data = JSON.stringify({ stream, messages: [{ role: 'user', content: content || job }] });
  let req;
  const promise = new Promise(resolve => {
    req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let body = ''; res.on('data', d => body += d.toString());
      res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', () => resolve({ aborted: true }));
    });
    req.on('error', () => resolve({ aborted: true })); req.end(data);
  });
  clients.push(req); return { req, promise };
}
function reply(res, body, content) {
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
}
(async () => {
  try {
    let ctx = context(), reservations = [];
    for (let i = 0; i < 8; i++) reservations.push(ctx.reserveChatRequest());
    check('request count is reserved before reading bodies', reservations.every(Boolean) && ctx.reserveChatRequest() === null);
    check('all reservations share a sixteen MiB byte budget', reservations[0].addBytes(10 * 1024 * 1024) && reservations[1].addBytes(6 * 1024 * 1024) && !reservations[2].addBytes(1));
    reservations.forEach(item => { item.release(); item.release(); });
    check('reservation release is idempotent and returns all count/bytes', ctx.state().count === 0 && ctx.state().bytes === 0);

    const first = await ctx.requestGate(), token = ctx.createExecutionControl(), removed = observe(ctx.requestGate(token));
    let nextEntered = false;
    const next = ctx.requestGate().then(release => { nextEntered = true; return release; });
    token.cancel('queued disconnected');
    check('queued cancellation rejects immediately and removes the entry', (await removed).error.code === 'EXECUTION_CANCELLED' && ctx.state().queued === 1 && !nextEntered);
    first(); first(); const nextRelease = await next;
    check('gate release is idempotent and advances surviving FIFO entry', nextEntered && ctx.state().active && !ctx.state().queued);
    const waitingToken = ctx.createExecutionControl(), aged = observe(ctx.requestGate(waitingToken));
    check('queue wait deadline cancels queued work without entering core', (await aged).error.message.includes('60 seconds') && ctx.state().queued === 0);
    nextRelease(); token.dispose(); waitingToken.dispose();

    let failed = 0, parsed = false, req = new PassThrough(), res = response();
    ctx.readJsonBody(req, res, 5, () => { parsed = true; }, { onFailure() { failed++; } });
    req.end('123456'); await new Promise(resolve => setTimeout(resolve, 10));
    check('oversized body rejects before parsing and calls cleanup once', res.code === 413 && failed === 1 && !parsed);
    req = new PassThrough(); res = response();
    ctx.readJsonBody(req, res, 100, () => {}, { addBytes: () => false, onFailure() { failed++; } });
    req.end('hello'); await new Promise(resolve => setTimeout(resolve, 10));
    check('shared byte capacity rejects with 429 and releases reservation', res.code === 429 && failed === 2);
    req = new PassThrough(); res = response();
    ctx.readJsonBody(req, res, 100, () => {}, { readTimeoutMs: 15, onFailure() { failed++; } });
    await until(() => res.code === 408, 'body timeout'); req.end();
    check('slow body has a finite read deadline', failed === 3);
    req = new PassThrough(); res = response();
    ctx.readJsonBody(req, res, 100, () => {}, { onFailure() { failed++; } });
    req.write('partial'); req.emit('aborted'); req.emit('error', Error('socket gone')); req.end();
    check('aborted body cleanup runs once when followed by error', failed === 4);

    let calls = [], release;
    ctx = context((prompt, result, model, control) => {
      calls.push({ prompt, model });
      return new Promise((resolve, reject) => { release = resolve; control.subscribe(() => reject(Error(control.reason))); });
    });
    const queue = ctx.createActionSummaryQueue({ maxJobs: 2, maxBytes: 2000, maxQueueAge: 30, maxLifetime: 1000 });
    const payload = id => ({ id, rawPrompt: id, result: 'long result '.repeat(25), modelContext: { summary: 'route-' + id }, deadlineAt: Date.now() + 3000 });
    queue.enqueue(payload('one')); queue.enqueue(payload('two'));
    check('summary queue bounds active plus pending jobs and preserves route', !queue.enqueue(payload('three')) && calls.length === 1 && calls[0].model.summary === 'route-one' && queue.stats().pending === 1);
    check('summary overload writes a bounded compact record', ctx.writes.length === 1 && ctx.writes[0].includes('queue capacity exceeded') && ctx.writes[0].length < 1100);
    await until(() => queue.stats().pending === 0, 'summary age expiry');
    check('aged summary coalesces to compact record without another model call', calls.length === 1 && ctx.writes.some(text => text.includes('summary queue wait exceeded')));
    release('first summary'); await until(() => !queue.stats().active, 'summary release');
    check('summary completion frees byte budget and execution control', queue.stats().bytes === 0 && ctx.createExecutionControl.active.size === 0);
    const bytesQueue = ctx.createActionSummaryQueue({ maxBytes: 10 });
    check('single oversized summary input uses compact fallback without queueing', !bytesQueue.enqueue(payload('bytes')) && bytesQueue.stats().bytes === 0 && calls.length === 1);
    const short = payload('short'); short.result = 'short reply';
    check('short replies skip queueing and keep the existing no-summary contract', bytesQueue.enqueue(short) && ctx.writes.length === 4);
    const expired = payload('expired'); expired.deadlineAt = Date.now() - 1;
    const before = ctx.writes.length;
    check('original request expiry forbids compact writes as well as model calls', !queue.enqueue(expired) && ctx.writes.length === before);
    const expiryQueue = ctx.createActionSummaryQueue({ maxLifetime: 20 }); expiryQueue.enqueue(payload('active-expiry'));
    await until(() => !expiryQueue.stats().active, 'active summary cancellation');
    check('stalled active summary expires and leaves queue reusable', expiryQueue.stats().bytes === 0 && ctx.writes.length === before && ctx.createExecutionControl.active.size === 0);

    const upstream = [];
    fixture = http.createServer((incoming, outgoing) => {
      let raw = ''; incoming.on('data', d => raw += d); incoming.on('end', () => {
        const body = JSON.parse(raw), head = String(body.messages[0].content);
        const content = body.messages[body.messages.length - 1].content;
        const text = Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join(' ') : String(content);
        const job = ((head + '\n' + text).match(/QUEUE_[A-Z_0-9]+/) || [''])[0];
        const summary = head.startsWith('Create a short, concise summary');
        upstream.push({ job, summary });
        if (summary && job === 'QUEUE_STREAM_HOLD') { releaseSummary = () => reply(outgoing, body, 'Completed stream task'); return; }
        if (!summary && job === 'QUEUE_MAIN_HOLD') { releaseMain = () => reply(outgoing, body, 'QUEUE_MAIN_HOLD ' + 'long answer '.repeat(25)); return; }
        reply(outgoing, body, summary ? 'Completed ' + job : (job === 'QUEUE_STREAM_HOLD' || job === 'QUEUE_IMAGE' ? job + ' long answer '.repeat(25) : 'OK ' + job));
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const cwd = S.freshCwd('queues-real');
    app = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, {
      HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', OPENAI_ENDPOINT: 'http://127.0.0.1:' + fixture.address().port,
      OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', LIGHT_MODEL: '', SUMMARY_MODEL: '', PERMISSION_MODE: 'bypass',
      DREAM_ALLOW: 'false', MAX_RETRIES: '1', EXECUTION_TIMEOUT_MS: '10000'
    }) });
    let appOutput = ''; app.stdout.on('data', d => appOutput += d); app.stderr.on('data', d => appOutput += d);
    const info = async () => JSON.parse((await S.httpReq(port, 'GET', '/api/info', null)).body);
    await until(async () => {
      if (app.exitCode !== null || app.signalCode !== null) throw Error('Agent exited: ' + appOutput);
      try { return !!(await info()).load; } catch (error) { if (error.code !== 'ECONNREFUSED') throw error; return false; }
    }, 'Agent ready');
    const stream = await chat(port, 'QUEUE_STREAM_HOLD', true).promise;
    await until(() => !!releaseSummary, 'held stream summary');
    const quick = await chat(port, 'QUEUE_AFTER_STREAM').promise;
    check('real streaming DONE releases core gate while its summary remains blocked', stream.body.includes('[DONE]') && quick.status === 200 && (await info()).load.summaries.active);
    const heldChat = chat(port, 'QUEUE_MAIN_HOLD'); await until(() => !!releaseMain, 'held main');
    const queued = Array.from({ length: 7 }, (_, i) => chat(port, 'QUEUE_WAIT_' + i, i % 2 === 0));
    await until(async () => (await info()).load.chatQueued === 7, 'seven queued requests');
    queued[0].req.destroy(); await until(async () => (await info()).load.chatQueued === 6, 'queued disconnect removed');
    const replacement = chat(port, 'QUEUE_REPLACEMENT');
    await until(async () => (await info()).load.chatRequests === 8, 'replacement reserved');
    const overload = await chat(port, 'QUEUE_OVERFLOW').promise;
    check('real count overload returns 429 before model execution and keeps health responsive', overload.status === 429 && !upstream.some(item => item.job === 'QUEUE_OVERFLOW') && (await info()).load.chatQueued === 7);
    releaseMain();
    const completed = await Promise.all([heldChat.promise, replacement.promise].concat(queued.slice(1).map(item => item.promise)));
    await until(async () => (await info()).load.chatRequests === 0, 'chat count drains');
    check('cancelled queued chat never runs and surviving requests complete', completed.every(item => item.status === 200) && !upstream.some(item => item.job === 'QUEUE_WAIT_0'));
    releaseSummary();
    await until(async () => !(await info()).load.summaries.active, 'summary queue drains');
    check('summary queue serializes writes without retaining chat bodies', (await info()).load.chatBodyBytes === 0 && fs.readFileSync(path.join(cwd, '7CODER.md'), 'utf8').includes('Completed stream task'));

    const slowBody = () => {
      let resolve; const promise = new Promise(done => { resolve = done; });
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(0)); clients.push(req); return { req, promise };
    };
    const large = slowBody(); large.req.write('x'.repeat(9 * 1024 * 1024));
    await until(async () => (await info()).load.chatBodyBytes === 9 * 1024 * 1024, 'first body budget');
    const overBytes = slowBody(); overBytes.req.end('y'.repeat(8 * 1024 * 1024));
    check('real aggregate body budget rejects before JSON parsing', await overBytes.promise === 429);
    large.req.destroy(); await until(async () => (await info()).load.chatRequests === 0 && (await info()).load.chatBodyBytes === 0, 'partial body releases budget');
    check('partial-body abort returns all admission capacity', (await info()).load.chatRequests === 0);
    const image = await chat(port, 'QUEUE_IMAGE', true, [{ type: 'text', text: 'QUEUE_IMAGE' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]).promise;
    await until(() => upstream.some(item => item.summary && item.job === 'QUEUE_IMAGE'), 'multimodal summary');
    check('multimodal chat queues text summary without treating image array as Buffer input', image.status === 200 && !appOutput.includes('ERR_INVALID_ARG_TYPE'));
    console.log('QUEUE/ADMISSION ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline);
    for (const request of clients) request.destroy();
    for (const ctx of contexts) if (ctx.createExecutionControl.active) for (const token of Array.from(ctx.createExecutionControl.active)) { token.cancel('test cleanup'); token.dispose(); }
    S.cleanup(); for (const socket of sockets) socket.destroy();
    if (fixture) await new Promise(resolve => fixture.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
