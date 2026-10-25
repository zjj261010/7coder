const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), { create } = require('./_endpoint'), S = require('./_shared').create({ suite: 'model-request-budget' });
const source = fs.readFileSync(S.IDX, 'utf8'), limit = 8 * 1024 * 1024, sockets = new Set(); let checks = 0, serializations = 0, server, H;
const deadline = setTimeout(() => { console.error('MODEL/REQUEST deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 40000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const tail = process.env.MODEL_REQUEST_PHASE === 'tail';
const c = loadContext(source, S.freshCwd('unit'), {}, { Buffer, JSON: { parse: JSON.parse, stringify(value) { serializations++; return JSON.stringify(value); } } });
function rejected(value, reason, max) { const before = serializations; assert.throws(() => c.serializeModelRequest(value, null, max), e => e.code === 'MODEL_REQUEST_REJECTED' && e.requestNotSent && reason.test(e.message)); return before === serializations; }
(async () => { try {
  if (!tail) {
  const values = [{ messages: [{ content: '\"\\\b\t\n\f\r\u0000\u001F中文😀\uD800\uDC00\uD800\uDC00\uFFFF' }], absent: undefined, nil: null, finite: 1.2e-50, negativeZero: -0, notFinite: NaN, enabled: true }, [undefined, false, 5, null], { constructor: 'literal', toJSON: 'literal', __proto__: null }];
  // Cover all UTF16 code units without random fuzz or real network input.
  values.push({ text: Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join('') });
  for (const value of values) { const expected = JSON.stringify(value); assert.strictEqual(c.serializeModelRequest(value, null, Buffer.byteLength(expected)), expected); }
  check('preflight exactly matches Node13 escaped JSON bytes including UTF16, controls and omitted fields', serializations === values.length);
  const shared = { x: 'same' }; check('repeated acyclic references preserve normal JSON semantics', c.serializeModelRequest({ a: shared, b: shared }) === JSON.stringify({ a: shared, b: shared }));
  check('escaped-control expansion is refused before full serialization', rejected({ content: '\u0000'.repeat(Math.floor(limit / 6)) }, /byte budget/));
  check('UTF8 and ordinary large strings are refused before full serialization', rejected({ content: '中'.repeat(Math.floor(limit / 3)) }, /byte budget/) && rejected({ content: 'x'.repeat(limit) }, /byte budget/));
  check('combined smaller messages share one request-byte limit', rejected({ messages: Array.from({ length: 9 }, () => ({ content: 'x'.repeat(1024 * 1024) })) }, /byte budget/));
  let deep = {}; for (let i = 0; i < 65; i++) deep = { child: deep }; check('deep payloads are refused without recursive native stringify', rejected(deep, /64 nested/));
  check('many small values have a separate structural ceiling', rejected(Array(100000).fill(null), /100000 values/));
  const cyclic = {}; cyclic.self = cyclic; check('cyclic data fails explicitly before serialization', rejected(cyclic, /cycle/));
  let sideEffects = 0; const executable = { toJSON() { sideEffects++; return 'bad'; } }, getter = {}; Object.defineProperty(getter, 'content', { enumerable: true, get() { sideEffects++; return 'bad'; } });
  check('executable serializers and accessors are refused without executing them', rejected(executable, /executable/) && rejected(getter, /accessor/) && sideEffects === 0);
  const token = c.createExecutionControl(); token.cancel('fixture pre-cancel'); const before = serializations; assert.throws(() => c.serializeModelRequest({ content: 'x' }, token), e => e.code === 'EXECUTION_CANCELLED'); token.dispose(); check('pre-cancelled payload is neither serialized nor sent', serializations === before);
  }
  const requests = [], retries = []; let mutate;
  server = http.createServer((req, res) => { const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw); requests.push({ raw, body, type: req.headers['content-type'] });
    if (body.messages[0].content === 'RETRY') { retries.push(raw); if (retries.length === 1) { mutate(); res.statusCode = 503; res.end('{}'); return; } }
    if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'SMALL_OK' } }] }) + '\n\ndata: [DONE]\n\n'); }
    else res.end(JSON.stringify({ choices: [{ message: { content: 'SMALL_OK' } }] })); }); });
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  Object.assign(c, { HEAVY_MODEL: 'fixture', TEMPERATURE: 0, MAX_TOKENS: 100, MAX_RETRIES: 3, tools: [], resolveModelConfig: () => ({ endpoint, apiKey: '' }), authHeadersFor: () => ({}), recordUsage() {}, console: { log() {}, warn() {}, error() {} } });
  const start = source.indexOf('function parseSSEStream('), end = source.indexOf('// ====================== RISK CLASSIFICATION', start); vm.runInContext(source.slice(start, end), c);
  if (!tail) {
  const envelope = { model: 'fixture', messages: [{ role: 'user', content: '' }], temperature: 0, max_tokens: 100 }, overhead = Buffer.byteLength(JSON.stringify(envelope));
  const exact = 'x'.repeat(limit - overhead); await c.callOpenAI([{ role: 'user', content: exact }], { useTools: false });
  check('actual HTTP admits an exact 8MiB JSON request with correct media type and intact input', Buffer.byteLength(requests[0].raw) === limit && requests[0].body.messages[0].content === exact && requests[0].type === 'application/json');
  const count = requests.length; await assert.rejects(c.callOpenAI([{ role: 'user', content: exact + 'x' }], { useTools: false }), e => e.requestNotSent && e.code === 'MODEL_REQUEST_REJECTED'); check('one byte over limit is rejected before network and outside retry loop', requests.length === count);
  const messages = [{ role: 'user', content: 'RETRY' }]; mutate = () => { messages[0].content = 'MUTATED_AFTER_FIRST_SEND'; };
  await c.callOpenAI(messages, { useTools: false }); check('retry sends the same immutable admitted body despite caller mutation', retries.length === 2 && retries[0] === retries[1] && JSON.parse(retries[1]).messages[0].content === 'RETRY');
  }
  let delta = ''; const small = await c.callOpenAI([{ role: 'user', content: 'SMALL_STREAM 中文😀' }], { useTools: false, onDelta: text => delta += text });
  check('streamed branch uses JSON request and retains completion/usage options', small.message.content === 'SMALL_OK' && delta === 'SMALL_OK' && requests[requests.length - 1].body.stream_options.include_usage === true);
  H = create({ suite: 'model-request-agent', endpoint, key: '', model: 'fixture', permissionMode: 'bypass' }); await H.start(S.freshCwd('actual-agent'));
  const oversized = [{ role: 'user', content: 'q'.repeat(limit + 1000) }], baseline = requests.length;
  await assert.rejects(H.chat(oversized, 6000), /Model request rejected before sending/);
  await assert.rejects(H.api('/v1/chat/completions', { messages: oversized }, 6000), /Model request rejected before sending/);
  const info = JSON.parse((await H.api('/api/info')).body); check('actual Agent rejects streaming and JSON requests without upstream calls or stuck activity', requests.length === baseline && info.runtime.activeTasks === 0 && info.runtime.activeTools === 0);
  const recovered = await H.chat([{ role: 'user', content: 'SMALL_AFTER_REJECTION' }], 5000); check('same Agent completes next valid request after admission failures', recovered.content === 'SMALL_OK' && requests.length === baseline + 1);
  console.log('MODEL/REQUEST ' + checks + '/' + checks + ' passed; SKIP 0' + (tail ? '; selected tail only; first 13 checks NOT RUN' : ''));
} finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } for (const s of sockets) s.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
