'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm');
const { createExecutionIdentitySource, executionIdentity } = require('../lib/execution-identity');
const { create } = require('./_endpoint'), { harness, settle } = require('./webui-ui-sim');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function unit() {
  let draws = 0;
  const next = createExecutionIdentitySource(size => { assert.strictEqual(size, 12); draws++; return Buffer.alloc(size, 0xab); });
  const prefix = 'exec-' + 'ab'.repeat(12) + '-';
  check('source has exact nonce and monotonic first identities', next() === prefix + '1' && next() === prefix + '2');
  const ids = Array.from({ length: 10000 }, () => next());
  check('ten thousand identities are unique with only one random draw', new Set(ids).size === ids.length && draws === 1);
  check('base36 sequence carries without truncation', ids[33] === prefix + '10');
  check('all generated identities pass bounded persistence validation', ids.every(id => executionIdentity(id) === id && id.length <= 41));
  check('independent process nonces separate matching counters', createExecutionIdentitySource(() => Buffer.alloc(12, 1))() !== prefix + '1');
  check('legacy and malformed IDs remain absent', [undefined, null, 3, '', prefix + '0', prefix + '01', prefix + 'A', prefix + '1'.repeat(12), prefix.replace('exec-', 'EXEC-') + '1'].every(id => executionIdentity(id) === undefined));
  for (const bad of [Buffer.alloc(11), 'not-a-buffer']) {
    assert.throws(() => createExecutionIdentitySource(() => bad), /12 random bytes/);
  }
  check('invalid entropy source is refused', true);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/execution-identity.js'), 'utf8'), {
    module, Buffer, require: name => { assert.strictEqual(name, 'crypto'); return { randomBytes: size => Buffer.alloc(size, 4) }; },
    Date: { now() { throw Error('clock must not be consulted'); } }
  });
  check('production identity source never consults wall clock', module.exports.nextExecutionId() !== module.exports.nextExecutionId());
}
async function live() {
  const S = require('./_shared').create({ suite: 'execution-correlation' }), sockets = new Set(), log = [], fixtureErrors = [];
  let H, fixture, releaseFirst;
  const model = 'execution-correlation-main', prompts = ['EXEC_A', 'EXEC_B', 'EXEC_C', 'EXEC_WF'];
  const bytes = 'identical shared bytes中文😀', callId = 'reused-read';
  const deadline = setTimeout(async () => {
    console.error('EXECUTION/CORRELATION deadline; fixture calls=' + log.length);
    try { if (H) await H.stop(); } catch (error) { console.error('Owned Agent cleanup: ' + error.message); }
    finally { if (H) H.S.cleanup(); S.cleanup(); for (const socket of sockets) socket.destroy(); if (fixture) fixture.close(); process.exit(1); }
  }, 40000);
  const call = workflow => ({ id: callId, type: 'function', function: { name: workflow ? 'workflow_tool' : 'read_file', arguments: JSON.stringify(workflow ? { steps: [{ tool: 'read_file', args: { path: 'same.txt' } }] } : { path: 'same.txt' }) } });
  async function until(fn, label) { const end = Date.now() + 5000; while (!(await fn())) { if (Date.now() >= end) throw Error(label + ' deadline; fixture=' + log.length + ', errors=' + fixtureErrors.join(';')); await new Promise(r => setTimeout(r, 10)); } }
  function reply(res, body, message) {
    if (body.stream) {
      const delta = Object.assign({}, message);
      if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((tc, index) => Object.assign({ index }, tc));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
    } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] })); }
  }
  try {
    fixture = http.createServer((req, res) => {
      let raw = '', size = 0; req.setEncoding('utf8'); req.on('error', error => fixtureErrors.push(error.message));
      req.on('data', text => { size += Buffer.byteLength(text); if (size > 2 * 1024 * 1024) req.destroy(Error('fixture input limit')); else raw += text; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw), m = body.messages, prompt = m[1] && m[1].content, i = prompts.indexOf(prompt), workflow = i === 3;
          assert.ok(i >= 0, 'exact task'); assert.strictEqual(body.model, model); assert.ok(Array.isArray(body.tools) && body.tools.length > 0);
          assert.strictEqual(body.stream === true, i >= 2); assert.strictEqual(m[0].role, 'system'); assert.ok(m[0].content);
          assert.strictEqual(m[1].role, 'user'); assert.ok(m.length === 2 || m.length === 4);
          const done = m.length === 4;
          if (done) {
            assert.strictEqual(m[2].role, 'assistant'); assert.deepStrictEqual(m[2].tool_calls, [call(workflow)]);
            assert.strictEqual(m[3].role, 'tool'); assert.strictEqual(m[3].tool_call_id, callId);
            assert.strictEqual(m[3].content, workflow ? '[OK] Workflow complete\nstep 1 (read_file):      1\t' + bytes : '     1\t' + bytes);
          }
          log.push({ prompt, done, messages: m });
          const message = done ? { role: 'assistant', content: prompt + '_DONE' } : { role: 'assistant', content: null, tool_calls: [call(workflow)] };
          if (i === 0 && !done) releaseFirst = () => reply(res, body, message); else reply(res, body, message);
        } catch (error) { fixtureErrors.push(error.message); res.writeHead(500); res.end('fixture protocol rejected'); }
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(r => fixture.listen(0, '127.0.0.1', r));
    H = create({ suite: 'execution-correlation-agent', endpoint: 'http://127.0.0.1:' + fixture.address().port, key: '', model, permissionMode: 'bypass' });
    const cwd = S.freshCwd('owned'); fs.writeFileSync(path.join(cwd, 'same.txt'), bytes); await H.start(cwd);
    const request = prompt => H.request({ stream: false, messages: [{ role: 'user', content: prompt }] }, 12000);
    const first = request(prompts[0]); first.catch(() => {});
    await until(() => !!releaseFirst, 'first model entry');
    const second = request(prompts[1]); second.catch(() => {});
    await until(async () => { const info = JSON.parse((await H.api('/api/info')).body); return info.load.chatRequests === 2 && info.load.chatQueued === 1; }, 'both requests admitted');
    check('two actual HTTP requests coexist behind one Agent task gate', log.length === 1);
    releaseFirst();
    const json = (await Promise.all([first, second])).map(r => JSON.parse(r.body));
    check('queued JSON tasks retain exact independent replies', json.every((r, i) => r.choices[0].message.content === prompts[i] + '_DONE'));
    const streams = [];
    for (const prompt of prompts.slice(2)) streams.push(await H.chat([{ role: 'user', content: prompt }], 8000));
    check('same Agent finishes streamed read and nested workflow', streams.every((r, i) => r.content === prompts[i + 2] + '_DONE'));
    await until(async () => { const info = JSON.parse((await H.api('/api/info')).body); return !info.load.chatActive && info.load.chatRequests === 0 && info.runtime.activeTasks === 0 && info.runtime.activeTools === 0 && !info.load.summaries.active && info.load.summaries.pending === 0; }, 'idle');
    check('all eight model requests match full independent histories without auxiliary work', fixtureErrors.length === 0 && log.length === 8 && prompts.every(prompt => log.filter(r => r.prompt === prompt && !r.done).length === 1 && log.filter(r => r.prompt === prompt && r.done).length === 1));
    const rows = S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).filter(r => r.type === 'tool');
    check('five authoritative tool rows keep success and original model IDs', rows.length === 5 && rows.every(r => r.status === 'ok') && rows.filter(r => r.callId === callId).length === 4 && rows.filter(r => r.callId === null).length === 1);
    const ids = json.map(r => r.id.replace(/^chatcmpl-/, ''));
    for (const stream of streams) {
      check('stream call/result retain same execution and repeated model ID', stream.tools.length === 2 && stream.tools.every(t => executionIdentity(t.executionId) && t.callId === callId) && stream.tools[0].executionId === stream.tools[1].executionId);
      const id = stream.tools[0].executionId; ids.push(id);
      const events = stream.raw.split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      check('every SSE chunk shares response ID joined to tool execution', events.length > 0 && events.every(e => e.id === 'chatcmpl-' + id));
    }
    check('four request identities are distinct and bounded', ids.every(id => executionIdentity(id)) && new Set(ids).size === 4);
    check('response IDs join uniquely despite four reused model call IDs', ids.every(id => rows.filter(r => r.executionId === id && r.callId === callId).length === 1));
    check('workflow child inherits parent execution without inventing model call ID', rows.filter(r => r.executionId === ids[3]).length === 2 && rows.find(r => r.callId === null).executionId === ids[3]);
    function connected() { const ui = harness(); for (const route of ['/api/sessions/save', '/api/sessions/load']) ui.route(route, async opts => { const r = await H.api(route, JSON.parse(opts.body)); return ui.response(JSON.parse(r.body), r.status); }); return ui; }
    const ui = connected(); await settle(); let replay = 0;
    ui.route('/v1/chat/completions', () => ({ ok: true, body: { getReader() { let sent = false; const raw = streams[replay++].raw; return { read() { if (sent) return Promise.resolve({ done: true }); sent = true; return Promise.resolve({ done: false, value: Buffer.from(raw) }); } }; } } }));
    for (let i = 0; i < 2; i++) { ui.ids.ta.value = prompts[i + 2]; ui.hook.send(); await until(() => ui.hook.history()[i * 2 + 1] && ui.hook.history()[i * 2 + 1].status === 'ok' && !ui.hook.saveState().dirty, 'UI task save'); }
    const saved = JSON.parse((await H.api('/api/sessions/load', { file: ui.hook.session() })).body), activities = saved.activities.filter(a => /^tool_/.test(a.type));
    check('original UI with actual session storage keeps both execution IDs', activities.length === 4 && activities.every((a, i) => a.executionId === ids[2 + Math.floor(i / 2)] && a.callId === callId));
    check('each saved activity joins exactly one parent audit row', activities.every(a => rows.filter(r => r.executionId === a.executionId && r.callId === a.callId).length === 1));
    const restored = connected(); await settle(); restored.hook.load(ui.hook.session());
    await until(() => restored.hook.history()[3] && restored.hook.history()[3].status === 'ok', 'UI restore'); restored.hook.autoSave(); await until(() => !restored.hook.saveState().dirty, 'restored save');
    const again = JSON.parse((await H.api('/api/sessions/load', { file: restored.hook.session() })).body);
    check('UI restore and resave preserve execution and turn identities', JSON.stringify(again.activities.filter(a => /^tool_/.test(a.type))) === JSON.stringify(activities));
    const legacy = JSON.parse((await H.api('/api/sessions/save', { messages: [{ role: 'user', content: 'legacy' }], activities: [{ type: 'tool_call', callId }, { type: 'tool_result', callId, executionId: 'invalid' }] })).body);
    const old = JSON.parse((await H.api('/api/sessions/load', { file: legacy.file })).body);
    check('legacy or invalid execution IDs are not fabricated during save', old.activities.length === 2 && old.activities.every(a => a.callId === callId && !Object.prototype.hasOwnProperty.call(a, 'executionId')));
  } finally {
    clearTimeout(deadline);
    try { if (H) { await H.stop(); H.S.cleanup(); } } finally { S.cleanup(); for (const socket of sockets) socket.destroy(); if (fixture) await new Promise(r => fixture.close(r)); }
  }
}
(async () => { const only = process.env.EXECUTION_CORRELATION_ONLY; if (!only || only === 'unit') unit(); if (!only || only === 'live') await live(); console.log('EXECUTION/CORRELATION ' + checks + '/' + checks); })().catch(error => { console.error(error.stack); process.exitCode = 1; });
