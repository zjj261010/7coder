'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const { create } = require('./_endpoint'), { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
const S = require('./_shared').create({ suite: 'execution-entrypoints' }), sockets = new Set(), log = [], fixtureErrors = [];
const model = 'entry-identity-main', tasks = ['ENTRY_CLI_A', 'ENTRY_CLI_B'], replies = ['ENTRY_CLI_A_DONE', 'ENTRY_CLI_B_DONE'];
const call = { id: 'reused-entry-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"same.txt"}' } }, bytes = 'IDENTICAL_ENTRY_BYTES中文😀';
let H, fixture, child, closed = false, code, output = '', checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(fn, label, allowClosed) { const end = Date.now() + 8000; while (!(await fn())) { if (closed && !allowClosed) throw Error('CLI closed early: ' + output.slice(-1000)); if (Date.now() >= end) throw Error(label + ': calls=' + log.length + ', errors=' + fixtureErrors.join(';') + ', output=' + output.slice(-1000)); await new Promise(r => setTimeout(r, 10)); } }
async function cleanup() {
  if (child && !closed) { child.kill(); await until(() => closed, 'owned CLI cleanup', true); }
  try { if (H) { await H.stop(); H.S.cleanup(); } } finally { S.cleanup(); for (const socket of sockets) socket.destroy(); if (fixture) await new Promise(r => fixture.close(r)); }
}
const deadline = setTimeout(async () => { console.error('EXECUTION/ENTRYPOINTS deadline'); try { await cleanup(); } catch (error) { console.error(error.message); } process.exit(1); }, 35000);
function malformed(port) {
  return new Promise((resolve, reject) => {
    let response, timer, done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); if (error) { if (response) response.destroy(); req.destroy(); reject(error); } else resolve(value); };
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      response = res; res.setEncoding('utf8'); let body = '';
      res.on('data', text => { body += text; if (Buffer.byteLength(body) > 16384) finish(Error('Malformed-response test budget')); });
      res.on('error', finish); res.on('aborted', () => finish(Error('Malformed response aborted'))); res.on('end', () => finish(null, { status: res.statusCode, body }));
    });
    req.on('error', finish); timer = setTimeout(() => finish(Error('Malformed request deadline')), 5000); req.end('{"messages":');
  });
}
(async () => {
  try {
    fixture = http.createServer((req, res) => {
      let raw = '', size = 0; req.setEncoding('utf8'); req.on('error', error => fixtureErrors.push(error.message));
      req.on('data', text => { size += Buffer.byteLength(text); if (size > 2 * 1024 * 1024) req.destroy(Error('Entry fixture input budget')); else raw += text; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw), i = log.length, round = Math.floor(i / 2), follow = i < 4 && i % 2 === 1;
          const prompt = i < 4 ? tasks[round] : i < 6 ? 'ENTRY_HTTP_STREAM_FAIL' : 'ENTRY_HTTP_RECOVER';
          assert.ok(i < 7); assert.strictEqual(req.method, 'POST'); assert.strictEqual(req.url, '/v1/chat/completions');
          assert.strictEqual(requestError(body, { model, tools: true, toolIds: follow ? [call.id] : [], lastUserIncludes: prompt }), null);
          assert.strictEqual(body.stream, i < 6 ? true : undefined);
          const m = body.messages; assert.strictEqual(m.length, follow ? 4 : 2); assert.strictEqual(m[0].role, 'system'); assert.ok(m[0].content);
          assert.strictEqual(m[1].role, 'user'); assert.strictEqual(m[1].content, prompt);
          if (i === 2) assert.strictEqual(m[0].content, log[0].messages[0].content);
          if (follow) { assert.strictEqual(m[2].role, 'assistant'); assert.strictEqual(m[2].content, ''); assert.deepStrictEqual(m[2].tool_calls, [call]); assert.strictEqual(m[3].role, 'tool'); assert.strictEqual(m[3].tool_call_id, call.id); assert.strictEqual(m[3].content, '     1\t' + bytes); }
          if (i === 5) assert.deepStrictEqual(body, log[4]); log.push(body);
          if (i === 4 || i === 5) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"owned upstream unavailable"}}'); return; }
          const message = i === 6 ? { role: 'assistant', content: 'ENTRY_HTTP_RECOVERED' } : follow ? { role: 'assistant', content: replies[round] } : { role: 'assistant', content: '', tool_calls: [call] };
          if (body.stream) { const delta = Object.assign({}, message); if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((tc, index) => Object.assign({ index }, tc)); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n'); }
          else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] })); }
        } catch (error) { fixtureErrors.push(error.message); res.writeHead(409); res.end('entry fixture rejected'); }
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(r => fixture.listen(0, '127.0.0.1', r));
    const endpoint = 'http://127.0.0.1:' + fixture.address().port + '/v1', cwd = S.freshCwd('cli'), runtime = path.join(cwd, '.7coder', 'runtime.jsonl'); fs.writeFileSync(path.join(cwd, 'same.txt'), bytes);
    child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_ENDPOINT: endpoint, OPENAI_API_KEY: '', HEAVY_MODEL: model, LIGHT_MODEL: model, SUMMARY_MODEL: model,
      PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false', ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', AUDIT_LOG: 'true' }) });
    for (const pipe of [child.stdout, child.stderr]) { pipe.setEncoding('utf8'); pipe.on('data', text => { output = (output + text).slice(-16384); }); }
    child.stdin.on('error', () => {}); child.once('close', value => { code = value; closed = true; }); child.once('error', error => { output += error.message; });
    await until(() => output.includes('Commands:'), 'CLI ready');
    child.stdin.write(tasks[0] + '\n/execute-task-now\n'); await until(() => S.readLog(runtime).filter(e => e.scope === 'cli-task').length === 1, 'CLI first terminal');
    child.stdin.write('/clear\n'); await until(() => output.includes('[OK] Conversation cleared.'), 'explicit conversation reset');
    child.stdin.write(tasks[1] + '\n/execute-task-now\n'); await until(() => S.readLog(runtime).filter(e => e.scope === 'cli-task').length === 2, 'CLI second terminal');
    child.stdin.end('/bye\n'); await until(() => closed, 'CLI normal close', true);
    const tasksLog = S.readLog(runtime).filter(e => e.scope === 'cli-task'), audit = S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).filter(e => e.type === 'tool');
    check('same CLI process completes two exact tool tasks with intentional reset and exit zero', code === 0 && log.length === 4 && replies.every(reply => output.split(reply).length === 2) && fixtureErrors.length === 0);
    check('two CLI terminal successes retain distinct valid execution identities', tasksLog.length === 2 && tasksLog.every(e => e.status === 'ok' && executionIdentity(e.executionId)) && tasksLog[0].executionId !== tasksLog[1].executionId);
    check('CLI identity nonce is stable while per-task counter advances', tasksLog[0].executionId.slice(0, -1) === tasksLog[1].executionId.slice(0, -1) && tasksLog[0].executionId.endsWith('-1') && tasksLog[1].executionId.endsWith('-2'));
    check('reused model call ID joins each CLI audit to exactly its own terminal task', audit.length === 2 && tasksLog.every(task => audit.filter(row => row.executionId === task.executionId && row.callId === call.id && row.tool === 'read_file' && row.status === 'ok').length === 1));
    check('successful CLI tools do not duplicate runtime tool records', !S.readLog(runtime).some(e => e.scope === 'tool'));
    H = create({ suite: 'execution-entry-http', endpoint, key: '', model, permissionMode: 'bypass' }); const httpCwd = S.freshCwd('http'); await H.start(httpCwd);
    const bad = await malformed(H.port), badError = JSON.parse(bad.body).error;
    check('invalid JSON returns explicit execution identity before task admission', bad.status === 500 && badError && badError.message && executionIdentity(badError.executionId) && log.length === 4);
    await until(async () => { const info = JSON.parse((await H.api('/api/info')).body); return info.load.chatRequests === 0 && info.runtime.activeTasks === 0; }, 'early error release');
    let events = S.readLog(path.join(httpCwd, '.7coder', 'runtime.jsonl'));
    check('early HTTP failure log keeps exact returned identity without task event', events.filter(e => e.scope === 'http-request' && e.status === 'error' && e.executionId === badError.executionId).length === 1 && !events.some(e => e.scope === 'http-task'));
    const failed = await H.request({ stream: true, messages: [{ role: 'user', content: 'ENTRY_HTTP_STREAM_FAIL' }] }, 8000);
    const data = failed.body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()), streamError = JSON.parse(data[0]).error;
    check('actual upstream failure emits correlated SSE error and one DONE', data.length === 2 && data[1] === '[DONE]' && streamError && streamError.message && executionIdentity(streamError.executionId));
    await until(async () => { const info = JSON.parse((await H.api('/api/info')).body); return info.load.chatRequests === 0 && info.runtime.activeTasks === 0; }, 'stream failure release');
    events = S.readLog(path.join(httpCwd, '.7coder', 'runtime.jsonl'));
    check('failed admitted task runtime joins exact SSE error identity', events.filter(e => e.scope === 'http-task' && e.status === 'error' && e.executionId === streamError.executionId).length === 1);
    const recovered = JSON.parse((await H.request({ messages: [{ role: 'user', content: 'ENTRY_HTTP_RECOVER' }] }, 8000)).body), recoveredId = recovered.id.replace(/^chatcmpl-/, '');
    check('same HTTP Agent completes independent request after both error phases', recovered.choices[0].message.content === 'ENTRY_HTTP_RECOVERED' && executionIdentity(recoveredId) && log.length === 7 && fixtureErrors.length === 0);
    await until(async () => { const info = JSON.parse((await H.api('/api/info')).body); return require('./_f-disconnect-fixture').idle(info); }, 'recovered idle');
    events = S.readLog(path.join(httpCwd, '.7coder', 'runtime.jsonl'));
    check('recovery has one success and all five CLI/HTTP/error identities remain distinct', events.filter(e => e.scope === 'http-task' && e.status === 'ok' && e.executionId === recoveredId).length === 1 && new Set(tasksLog.map(e => e.executionId).concat(badError.executionId, streamError.executionId, recoveredId)).size === 5);
    console.log('EXECUTION/ENTRYPOINTS ' + checks + '/' + checks);
  } finally { clearTimeout(deadline); await cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
