const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), util = require('util');
const { harness, settle } = require('./webui-ui-sim'), { request } = require('./_endpoint');
const S = require('./_shared').create({ suite: 'webui-memory-budget' }), sockets = new Set(); let checks = 0, model, agent, agentClosed = false;
const errorsOnly = process.env.WEBUI_MEMORY_SCOPE === 'errors';
const deadline = setTimeout(() => { console.error('WEBUI/MEMORY deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(predicate, label) { const end = Date.now() + 8000; while (!await predicate()) { if (Date.now() >= end) throw Error('deadline: ' + label); await settle(); } }
const delta = value => 'data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\n\n';
function stream(ui, chunks, state = {}) {
  let index = 0; state.cancelled = 0; state.released = 0; state.reads = 0;
  ui.route('/v1/chat/completions', opts => { state.signal = opts.signal; return { ok: !state.httpStatus || state.httpStatus < 400, status: state.httpStatus || 200, body: { getReader() { return {
    read() { state.reads++; if (index >= chunks.length) return Promise.resolve({ done: true }); const value = typeof chunks[index] === 'function' ? chunks[index++]() : chunks[index++]; return Promise.resolve({ done: false, value: Buffer.isBuffer(value) ? value : Buffer.from(value) }); },
    cancel() { state.cancelled++; return Promise.resolve(); }, releaseLock() { state.released++; }
  }; } } }; });
  return state;
}
async function finished(ui) { await until(() => ui.hook.history().some(m => m.role === 'assistant') && ui.hook.history().filter(m => m.role === 'assistant').slice(-1)[0].status !== 'running' && !ui.hook.saveState().busy, 'UI turn settled'); }
function start(ui, text = 'fixture task') { ui.ids.ta.value = text; ui.hook.send(); }
(async () => { try {
  if (!errorsOnly) {
  let ui = harness(); await settle();
  const examples = [{ text: '"\\\n\u0000中文😀\uD800', absent: undefined, a: [undefined, null, true, NaN, -0] },
    Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join('')];
  for (const value of examples) { const n = Buffer.byteLength(JSON.stringify(value)); assert.strictEqual(ui.hook.budget.measure(value, n), n); }
  check('browser preflight exactly matches JSON bytes for controls, Unicode and all UTF16 units', true);
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => ui.hook.budget.measure(cyclic, 20000), /不可保存/);
  let deep = {}; for (let i = 0; i < 65; i++) deep = { child: deep }; assert.throws(() => ui.hook.budget.measure(deep, 1000000), /复杂/);
  assert.throws(() => ui.hook.budget.measure(Array(100001).fill(null), 2000000), /复杂/);
  check('structural budgets reject cycles/depth/value count without native stringify', true);
  let getter = 0; const accessor = {}; Object.defineProperty(accessor, 'x', { enumerable: true, get() { getter++; return 'bad'; } });
  assert.throws(() => ui.hook.budget.measure(accessor, 10000), /不可保存/); check('preflight never executes an accessor', getter === 0);
  let serialized = 0; const trackedJSON = { parse: JSON.parse, stringify(value) { serialized++; return JSON.stringify(value); } };
  ui = harness({ globals: { JSON: trackedJSON } }); await settle(); const before = serialized;
  ui.hook.setHistory([{ role: 'user', content: '中'.repeat(750000) }]); ui.hook.autoSave(); await settle();
  check('oversized history is refused before full JSON serialization and remains dirty', serialized === before && ui.hook.saveState().dirty && ui.hook.history()[0].content.length === 750000);

  ui = harness(); await settle(); ui.hook.setHistory([{ role: 'user', content: 'old' }]);
  const initial = JSON.stringify(ui.hook.history()), calls = ui.calls.length, draft = 'x'.repeat(ui.hook.budget.limit);
  start(ui, draft); await settle();
  check('oversized new draft sends nothing and changes neither draft nor old conversation', ui.ids.ta.value === draft && JSON.stringify(ui.hook.history()) === initial && ui.calls.length === calls && !ui.hook.saveState().dirty);
  ui = harness(); await settle(); ui.hook.activities().push(...Array.from({ length: 2000 }, () => ({ type: 'tool_result', name: 'fixture', result: '' })));
  const emptyCalls = ui.calls.length; start(ui, 'keep full activity history');
  check('full activity history refuses another turn intact without issuing requests', ui.hook.history().length === 0 && ui.ids.ta.value === 'keep full activity history' && ui.calls.length === emptyCalls);

  ui = harness(); await settle(); const state = stream(ui, [delta({ content: 'SAFE_PREFIX' }), delta({ content: '中'.repeat(4000) }), 'data: [DONE]\n\n']);
  ui.hook.setHistory([{ role: 'user', content: 'b'.repeat(ui.hook.budget.payload - 2000) }]); start(ui); await finished(ui);
  let reply = ui.hook.history().slice(-1)[0];
  check('reply overflow preserves admitted prefix, marks failed and aborts/releases source', reply.content === 'SAFE_PREFIX' && reply.status === 'failed' && reply.error.includes('工具可能已执行') && state.signal.aborted && state.cancelled === 1 && state.released === 1 && state.reads === 2);
  check('reserved status capacity keeps the stopped session savable without truncating old history', !ui.hook.saveState().dirty && Buffer.byteLength(JSON.stringify({ messages: ui.hook.history(), activities: ui.hook.activities() })) <= ui.hook.budget.limit && ui.hook.history()[0].content.length === ui.hook.budget.payload - 2000);
  ui = harness(); await settle(); const reasoning = stream(ui, [delta({ reasoning: 'R'.repeat(1200000) }), delta({ reasoning: 'R'.repeat(1200000) })]); start(ui); await finished(ui);
  check('reasoning shares session budget and cannot accumulate outside persisted activity bounds', ui.hook.history()[1].status === 'failed' && ui.hook.activities().length === 1 && ui.hook.activities()[0].text.length === 1200000 && reasoning.signal.aborted && !ui.hook.saveState().dirty);
  ui = harness(); await settle(); ui.hook.activities().push(...Array.from({ length: 1999 }, () => ({ type: 'tool_result', name: 'prior', result: '' })));
  const activities = stream(ui, [delta({ tool_call: { callId: 'limit-call', name: 'write_file', args: { path: 'fixture.txt' } } }), delta({ tool_result: { callId: 'limit-call', name: 'write_file', status: 'completed', result: 'written' } })]);
  start(ui); await finished(ui);
  check('activity count overflow retains prior rows and identifies last omitted tool outcome', ui.hook.activities().length === 2000 && ui.hook.activities()[1999].callId === 'limit-call' && ui.hook.history()[1].status === 'failed' && ui.hook.history()[1].error.includes('limit-call') && ui.hook.history()[1].error.includes('completed') && activities.signal.aborted && !ui.hook.saveState().dirty);

  ui = harness(); await settle(); let parsedFrames = 0;
  const probeJSON = { stringify: JSON.stringify, parse(text) { if (text.includes('OVERSIZED_FRAME_MARK')) parsedFrames++; return JSON.parse(text); } };
  ui = harness({ globals: { JSON: probeJSON } }); await settle(); const frameState = stream(ui, [delta({ content: 'OVERSIZED_FRAME_MARK' + 'x'.repeat(2 * 1024 * 1024) })]);
  start(ui); await finished(ui);
  check('oversized complete SSE line is rejected before JSON.parse', parsedFrames === 0 && ui.hook.history()[1].content === '' && ui.hook.history()[1].error.includes('2 MiB') && frameState.signal.aborted);
  ui = harness(); await settle(); const noLine = stream(ui, Array.from({ length: 34 }, () => () => Buffer.alloc(65536, 120))); start(ui); await finished(ui);
  check('unterminated SSE data has a separate 2MiB frame ceiling', noLine.reads === 33 && noLine.signal.aborted && ui.hook.history()[1].status === 'failed');
  let decodedBytes = 0; class TrackedDecoder extends util.TextDecoder { decode(bytes, options) { decodedBytes += bytes ? bytes.byteLength : 0; return super.decode(bytes, options); } }
  ui = harness({ globals: { TextDecoder: TrackedDecoder } }); await settle(); const decodeBase = decodedBytes;
  const comments = Buffer.from(':' + 'x'.repeat(512 * 1024 - 2) + '\n'), total = stream(ui, Array.from({ length: 17 }, () => comments)); start(ui); await finished(ui);
  check('response total limit includes ignored comments and rejects next chunk before decoding', total.reads === 17 && decodedBytes - decodeBase === 8 * 1024 * 1024 && ui.hook.history()[1].error.includes('8 MiB'));
  ui = harness(); await settle(); const twoLines = ':' + 'a'.repeat(1200000) + '\n:' + 'b'.repeat(1200000) + '\n' + delta({ content: 'BATCH_OK' }) + 'data: [DONE]\n\n';
  const batch = stream(ui, [twoLines]); start(ui); await finished(ui);
  check('single chunk over frame limit is legal when it contains separate bounded lines', ui.hook.history()[1].status === 'ok' && ui.hook.history()[1].content === 'BATCH_OK' && batch.cancelled === 1 && batch.released === 1);
  ui = harness(); await settle(); const unicode = stream(ui, [delta({ content: '\uD83D' }), delta({ content: '\uDE00' }), 'data: [DONE]\n\n']); start(ui); await finished(ui);
  check('JSON append accounting preserves surrogate pairs split between deltas', ui.hook.history()[1].content === '😀' && ui.hook.history()[1].status === 'ok' && !unicode.signal.aborted);

  ui = harness(); await settle(); const baselineIntervals = ui.intervals.size;
  const requests = Array.from({ length: 65 }, (_, i) => 'data: ' + JSON.stringify({ approval_request: { id: 'ap-' + i, question: 'approve fixture?', tool: 'write_file' } }) + '\n\n');
  const approval = stream(ui, requests); start(ui); await finished(ui);
  check('approval count has a bounded lifetime total and failure clears every countdown', ui.hook.history()[1].error.includes('64') && approval.reads === 65 && ui.intervals.size === baselineIntervals && ui.calls.filter(c => c.url === '/api/approve').length === 0);
  ui = harness(); await settle(); const bigApproval = stream(ui, ['data: ' + JSON.stringify({ approval_request: { id: 'big', question: 'q'.repeat(512 * 1024) } }) + '\n\n']); start(ui); await finished(ui);
  check('oversized approval display is refused before creating an approval panel', bigApproval.signal.aborted && ui.ids.log.querySelectorAll('.approval-box').length === 0 && ui.hook.history()[1].error.includes('512 KiB'));
  ui = harness(); await settle(); ui.hook.setHistory([{ role: 'user', content: 'preserved current' }]); ui.route('/api/sessions/load', () => ui.response({ messages: [{ role: 'user', content: '中'.repeat(750000) }] })); ui.hook.load('too-large.json'); await settle();
  check('oversized restored data cannot replace current history or session identity', ui.hook.history()[0].content === 'preserved current' && ui.hook.session() === null);

  // Bridge the controlled DOM's fetch body to a real native HTTP response.
  // This validates backend disconnect/persistence, not Chromium's networking.
  let upstreamClosed = false, upstreamCalls = 0;
  model = http.createServer((req, res) => { const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
    upstreamCalls++; const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.messages.some(m => String(m.content).includes('RECOVER_UI'))) {
      if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(delta({ content: 'RECOVERED' }) + 'data: [DONE]\n\n'); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'RECOVERED' } }] })); }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.on('close', () => { upstreamClosed = true; }); res.write(delta({ content: 'NATIVE_SAFE_PREFIX' })); res.write(delta({ content: 'x'.repeat(2200000) }));
  }); });
  model.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); }); await new Promise(r => model.listen(0, '127.0.0.1', r));
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const cwd = S.freshCwd('actual-agent');
  agent = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, { HTTP_BIND: '127.0.0.1', HTTP_PORT: String(port), HTTP_API_KEY: '', OPENAI_ENDPOINT: 'http://127.0.0.1:' + model.address().port, OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', DREAM_ALLOW: 'false', PERMISSION_MODE: 'bypass', ENABLE_RALPH_MODE: 'false' }) });
  agent.once('close', () => { agentClosed = true; }); agent.stdout.resume(); agent.stderr.resume();
  await until(async () => { if (agentClosed) throw Error('Agent exited before ready'); try { return JSON.parse((await request(port, '/api/info', null, 1000)).body).version; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'Agent ready');
  ui = harness(); await settle();
  for (const route of ['/api/sessions/save', '/api/sessions/load']) ui.route(route, async opts => { const r = await request(port, route, JSON.parse(opts.body), 5000); return ui.response(JSON.parse(r.body)); });
  const native = { closed: false, queuedBytes: 0 };
  ui.route('/v1/chat/completions', opts => new Promise((resolve, reject) => {
    let response, done = false, fault = null, waiting = null, queue = [];
    function deliver() { if (!waiting) return; const pair = waiting; waiting = null; if (queue.length) { const value = queue.shift(); native.queuedBytes -= value.length; pair.resolve({ done: false, value }); } else if (fault) pair.reject(fault); else if (done) pair.resolve({ done: true }); else waiting = pair; }
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: opts.headers }, res => {
      response = res; res.on('data', b => { queue.push(b); native.queuedBytes += b.length; if (native.queuedBytes > 8 * 1024 * 1024) { req.destroy(Error('test bridge budget')); return; } deliver(); });
      res.on('end', () => { done = true; deliver(); }); res.on('error', e => { fault = e; deliver(); });
      resolve({ ok: res.statusCode === 200, body: { getReader() { return { read() { return new Promise((resolve, reject) => { waiting = { resolve, reject }; deliver(); }); },
        cancel() { queue = []; native.queuedBytes = 0; done = true; res.destroy(); req.destroy(); deliver(); return Promise.resolve(); }, releaseLock() {} }; } } });
    });
    req.once('close', () => { native.closed = true; }); req.on('error', e => { fault = e; if (response) deliver(); else reject(e); });
    opts.signal.addEventListener('abort', () => { queue = []; native.queuedBytes = 0; fault = Object.assign(Error('UI aborted'), { name: 'AbortError' }); if (response) response.destroy(); req.destroy(); deliver(); }); req.end(opts.body);
  }));
  start(ui, 'NATIVE_UI_BUDGET'); await finished(ui); await until(() => !ui.hook.saveState().dirty && native.closed && upstreamClosed, 'native transport and save settled');
  const saved = JSON.parse((await request(port, '/api/sessions/load', { file: ui.hook.session() }, 5000)).body);
  check('actual backend disconnect closes stalled upstream and saves failed partial reply on disk', saved.messages[1].content === 'NATIVE_SAFE_PREFIX' && saved.messages[1].status === 'failed' && saved.messages[1].error.includes('工具可能已执行') && native.queuedBytes === 0 && upstreamCalls === 1);
  const recovered = await request(port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'RECOVER_UI' }] }, 5000), info = JSON.parse((await request(port, '/api/info', null, 1000)).body);
  check('same real Agent completes next request after UI capacity abort without stuck activity', JSON.parse(recovered.body).choices[0].message.content === 'RECOVERED' && info.runtime.activeTasks === 0 && info.runtime.activeTools === 0 && upstreamCalls === 2);
  }
  let ui = harness(); await settle();
  const smallError = stream(ui, [JSON.stringify({ error: { message: '中文错误_' + 'x'.repeat(2000) } })], { httpStatus: 500 });
  start(ui); await finished(ui);
  check('bounded HTTP error preserves Unicode diagnostic while clipping saved/displayed text', ui.hook.history()[1].status === 'failed' && ui.hook.history()[1].error.startsWith('中文错误_') && ui.hook.history()[1].error.length === 1000 && smallError.cancelled === 1 && smallError.released === 1 && !ui.hook.saveState().dirty);
  ui = harness(); await settle(); const largeError = stream(ui, Array.from({ length: 3 }, () => () => Buffer.alloc(32768, 120)), { httpStatus: 500 });
  start(ui); await finished(ui);
  check('HTTP error body stops at separate 64KiB bound and releases transport', largeError.reads === 3 && largeError.signal.aborted && largeError.cancelled === 1 && largeError.released === 1 && ui.hook.history()[1].error.includes('64 KiB') && ui.hook.history()[1].content === '');
  ui = harness(); await settle(); const invalidError = stream(ui, ['<html>private fixture error</html>'], { httpStatus: 503 });
  start(ui); await finished(ui);
  check('non-JSON HTTP failure remains a bounded status error with complete cleanup', ui.hook.history()[1].error === 'HTTP 503' && invalidError.signal.aborted && invalidError.cancelled === 1 && invalidError.released === 1);
  console.log('WEBUI/MEMORY ' + checks + '/' + checks + '; SKIP 0' + (errorsOnly ? '; new HTTP error checks only; first 20 NOT RUN' : ''));
} finally { clearTimeout(deadline); if (agent && !agentClosed) { const closed = new Promise(resolve => agent.once('close', resolve)); agent.kill(); await Promise.race([closed, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('owned Agent close unconfirmed')), 5000); closed.then(() => clearTimeout(t)); })]); } for (const socket of sockets) socket.destroy(); if (model) await new Promise(r => model.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
