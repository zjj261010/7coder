// T22-15: admission precedes transcript allocation; failures never commit history.
const assert = require('assert'), fs = require('fs'), vm = require('vm'), http = require('http');
const S = require('./_shared').create({ suite: 'context-budget' }), { create } = require('./_endpoint');
const source = fs.readFileSync(S.IDX, 'utf8'), inputLimit = 1024 * 1024, outputLimit = 256 * 1024;
let checks = 0, H, server; const sockets = new Set();
const deadline = setTimeout(() => { console.error('CONTEXT/BUDGET deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(reply) {
  let serializations = 0, calls = 0;
  const c = vm.createContext({ Buffer, console: { log() {}, warn() {} }, CONTEXT_CHARS: 1000,
    HEAVY_MODEL: 'main', LIGHT_MODEL: 'light', JSON: { parse: JSON.parse, stringify(value) { serializations++; return JSON.stringify(value); } },
    callOpenAI: async (messages, options) => { calls++; return { message: { content: await reply(messages, options, calls) } }; } });
  vm.runInContext(cut('function executionCancelledError(', 'function watchExecution(') + cut('function charUnits(', '// ====================== TASK CHANGE SUMMARY'), c);
  return { c, calls: () => calls, serializations: () => serializations };
}
const old = text => [{ role: 'assistant', content: text }];
const history = text => [{ role: 'system', content: 's' }, { role: 'user', content: text },
  { role: 'assistant', content: 'completed side effect' }, { role: 'user', content: 'do not repeat it' }];
async function refused(f, messages, reason, token) {
  const original = JSON.stringify(messages);
  await assert.rejects(f.c.compressConversationIfNeeded(messages, null, token), reason);
  assert.strictEqual(JSON.stringify(messages), original);
}
(async () => { try {
  let f = context(() => 'digest');
  const sample = [{ role: 'user', content: '中文😀\n\u0000' }], bytes = Buffer.byteLength(JSON.stringify(sample));
  check('measure-only uses exact escaped JSON bytes without native stringify', f.c.serializeModelRequest(sample, null, bytes, true) === bytes && f.serializations() === 0);
  const exact = old('x'.repeat(inputLimit - Buffer.byteLength(JSON.stringify(old('')))));
  let parts = [], optionsSeen = [];
  f = context((messages, options) => { parts.push(messages[0].content.split('\n\n').slice(1).join('\n\n')); optionsSeen.push(options); return 'digest'; });
  await f.c.summarizeConversation(exact, { light: 'captured-light' });
  check('exact 1MiB source reaches all parts including tail with no truncation', parts.length > 1 && parts.join('') === 'assistant: ' + exact[0].content && parts.every(p => p.length <= 20000));
  check('segmented calls preserve route, tool exclusion and per-call output instruction', optionsSeen.every(o => o.model === 'captured-light' && o.useTools === false && o.maxTokens === 600));
  f = context(() => 'must not run');
  await assert.rejects(f.c.summarizeConversation(old(exact[0].content + 'x')), /byte budget/);
  check('one byte over input budget refuses before serialization or model call', f.calls() === 0 && f.serializations() === 0);
  for (const [label, text] of [['escaped controls', '\u0000'.repeat(Math.ceil(inputLimit / 6))], ['UTF8', '中'.repeat(Math.ceil(inputLimit / 3))]]) {
    f = context(() => 'must not run'); await assert.rejects(f.c.summarizeConversation(old(text)), /byte budget/);
    check(label + ' is charged before allocation', f.calls() === 0 && f.serializations() === 0);
  }
  let deep = {}; for (let i = 0; i < 65; i++) deep = { child: deep };
  const cycle = {}; cycle.self = cycle;
  for (const [label, content, reason] of [['nested objects', deep, /64 nested/], ['cyclic content', cycle, /cycle/], ['many tiny values', Array(100000).fill(null), /100000 values/]]) {
    f = context(() => 'must not run'); await assert.rejects(f.c.summarizeConversation([{ role: 'assistant', content }]), reason);
    check(label + ' refuses before native serialization', f.calls() === 0 && f.serializations() === 0);
  }
  let invoked = 0; const accessor = {}; Object.defineProperty(accessor, 'content', { enumerable: true, get() { invoked++; return 'x'; } });
  f = context(() => 'must not run'); await assert.rejects(f.c.summarizeConversation([accessor]), /accessor/);
  const executable = { toJSON() { invoked++; return 'x'; } };
  await assert.rejects(f.c.summarizeConversation(old(executable)), /executable/);
  check('accessors and serializers are never executed during admission', invoked === 0 && f.calls() === 0 && f.serializations() === 0);
  f = context(() => 'must not run');
  await refused(f, history('x'.repeat(8 * inputLimit)), /byte budget/);
  check('whole-history limit precedes weighted scan and JSON allocation', f.calls() === 0 && f.serializations() === 0);
  f = context(() => 'must not run'); await refused(f, history('x'.repeat(inputLimit)), /original history preserved/);
  check('summary input refusal preserves original conversation and sends nothing', f.calls() === 0 && f.serializations() === 0);
  let chunks = []; const data = [{ role: 'assistant', content: [{ text: '中😀' }], tool_calls: [{ id: 'done', function: { name: 'write_file', arguments: '{"content":"SIDE_EFFECT_DONE"}' } }] },
    { role: 'tool', content: 'a'.repeat(19971) + '😀' + 'b'.repeat(22000) + 'TAIL_CONSTRAINT' }];
  const expected = data.map(m => m.role + ': ' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')) + (m.tool_calls ? ' [called: ' + JSON.stringify(m.tool_calls) + ']' : '')).join('\n');
  f = context(messages => { const s = messages[0].content; chunks.push(s.slice(s.indexOf('\n\n') + 2)); return 'digest'; });
  await f.c.summarizeConversation(data);
  check('structured content, tool arguments, UTF16 boundary and tail retain exact transcript', chunks.join('') === expected && chunks.every(p => p.length <= 20000 && !(p.charCodeAt(p.length - 1) >= 0xD800 && p.charCodeAt(p.length - 1) <= 0xDBFF)));
  f = context(() => 'x'.repeat(outputLimit));
  check('exact 256KiB summary is admitted', (await f.c.summarizeConversation(old('small'))).length === outputLimit);
  f = context(() => '中'.repeat(Math.ceil(outputLimit / 3)));
  await refused(f, history('x'.repeat(25000)), /context summaries exceed/);
  check('provider ignoring maxTokens cannot commit an oversized UTF8 digest', f.calls() === 1);
  f = context((m, o, n) => 'x'.repeat(n === 1 ? outputLimit / 2 : outputLimit / 2 - 2));
  check('cumulative output exact limit counts joining separators', (await f.c.summarizeConversation(old('x'.repeat(25000)))).length === outputLimit && f.calls() === 2);
  f = context((m, o, n) => 'x'.repeat(n === 1 ? outputLimit / 2 : outputLimit / 2 - 1));
  await refused(f, history('x'.repeat(25000)), /context summaries exceed/);
  check('later part exceeding cumulative output commits no partial summary', f.calls() === 2);
  f = context(() => ' '.repeat(outputLimit + 1)); await assert.rejects(f.c.summarizeConversation(old('small')), /context summaries exceed/);
  check('raw whitespace expansion is refused before trim', f.calls() === 1);
  f = context(() => 'must not run'); const cancelled = () => true; cancelled.reason = 'fixture deadline';
  await refused(f, history('x'.repeat(25000)), e => e.code === 'EXECUTION_CANCELLED', cancelled);
  check('pre-cancelled history allocates no transcript and calls no model', f.calls() === 0 && f.serializations() === 0);
  let probes = 0; const duringScan = () => ++probes > 15; duringScan.reason = 'deadline during admission';
  f = context(() => 'must not run'); await refused(f, history('x'.repeat(50000)), e => e.code === 'EXECUTION_CANCELLED', duringScan);
  check('long admission scan observes deadline without a timer turn', f.calls() === 0 && f.serializations() === 0);
  let stopped = false; const lateCancel = () => stopped;
  f = context(() => { stopped = true; return 'digest'; });
  await refused(f, history('x'.repeat(25000)), /original history preserved/, lateCancel);
  check('cancellation after awaited summary stops next segment and preserves original', f.calls() === 1);
  f = context(() => 'digest'); const originalSerialize = f.c.serializeModelRequest;
  f.c.serializeModelRequest = function(value, token, max, measure) {
    if (Array.isArray(value) && value.some(m => m && typeof m.content === 'string' && m.content.startsWith('[CONTEXT COMPRESSION]'))) throw Error('fixture replacement check failed');
    return originalSerialize(value, token, max, measure);
  };
  await refused(f, history('x'.repeat(25000)), /replacement check failed/);
  check('replacement validation runs before committing any splice', f.calls() === 2);

  let requests = 0, summaryCalls = 0;
  server = http.createServer((req, res) => { const buffers = []; req.on('data', b => buffers.push(b)); req.on('end', () => {
    requests++; const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    const summary = body.messages[0].content.startsWith('Summarize this coding conversation');
    if (summary) summaryCalls++;
    const message = { content: summary ? 'x'.repeat(outputLimit + 1) : 'RECOVERED' };
    if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); }
    else res.end(JSON.stringify({ choices: [{ message }] }));
  }); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  H = create({ suite: 'context-budget-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: '', model: 'fixture', permissionMode: 'bypass' });
  const previous = process.env.CONTEXT_CHARS; process.env.CONTEXT_CHARS = '1000';
  try { await H.start(S.freshCwd('actual-agent')); } finally { if (previous === undefined) delete process.env.CONTEXT_CHARS; else process.env.CONTEXT_CHARS = previous; }
  const hugeHistory = history('x'.repeat(inputLimit)).slice(1);
  await assert.rejects(H.chat(hugeHistory, 8000), /original history preserved.*byte budget/);
  check('real Agent refuses oversized summary input without upstream traffic', requests === 0);
  await assert.rejects(H.chat(history('x'.repeat(25000)).slice(1), 8000), /context summaries exceed/);
  check('real Agent rejects oversized summary without sending main-model call', requests === 1 && summaryCalls === 1);
  const info = JSON.parse((await H.api('/api/info')).body);
  check('failed compression releases task/tool activity and keeps health available', info.runtime.activeTasks === 0 && info.runtime.activeTools === 0);
  const recovered = await H.chat([{ role: 'user', content: 'next valid task' }], 8000);
  check('same real Agent completes next valid task after both refusals', recovered.content === 'RECOVERED' && requests === 2);
  console.log('CONTEXT/BUDGET ' + checks + '/' + checks + '; SKIP 0');
} finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } for (const socket of sockets) socket.destroy(); if (server) await new Promise(resolve => server.close(resolve)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
