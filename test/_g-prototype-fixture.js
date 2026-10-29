'use strict';
const http = require('http'), { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
const model = 'g-prototype-main', prompt = 'G3_LITERAL_KEYS_TASK', recovery = 'G3_NORMAL_NEXT_TASK';
const marker = 'G3_LITERAL_中文😀', initial = 'G3_FILE_BEGIN ' + marker, appended = '|g3PollutedSentinel=' + marker, finalFile = initial + appended;
const reply = 'G3_INERT_KEYS_EXACT中文😀', recovered = 'G3_NORMAL_NEXT_EXACT中文😀', file = 'proto.txt';
const rawArgs = [
  '{"path":"proto.txt","content":' + JSON.stringify(initial) + ',"__proto__":{"g3PollutedSentinel":' + JSON.stringify(marker) + '}}',
  '{"path":"proto.txt","content":' + JSON.stringify(appended) + ',"constructor":{"prototype":{"g3PollutedSentinel":' + JSON.stringify(marker) + '}}}',
  '{"path":"proto.txt","prototype":{"g3PollutedSentinel":' + JSON.stringify(marker) + '}}',
  '{"path":"proto.txt"}'
];
const names = ['write_file', 'append_file', 'read_file', 'read_file'], results = ['Written: proto.txt', 'Appended: proto.txt', '     1\t' + finalFile, '     1\t' + finalFile];
const calls = names.map((name, i) => ({ id: 'g3-' + i, type: 'function', function: { name, arguments: rawArgs[i] } }));
function tail(step) {
  const m = [{ role: 'user', content: prompt }];
  for (let i = 0; i < Math.min(step, 3); i++) m.push({ role: 'assistant', content: '', tool_calls: [calls[i]] }, { role: 'tool', tool_call_id: calls[i].id, content: results[i] });
  if (step >= 4) m.push({ role: 'assistant', content: reply }, { role: 'user', content: recovery });
  if (step === 5) m.push({ role: 'assistant', content: '', tool_calls: [calls[3]] }, { role: 'tool', tool_call_id: calls[3].id, content: results[3] });
  return m;
}
function stepError(body, step, log) {
  if (!Number.isInteger(step) || step < 0 || step > 5) return 'extra model request';
  const count = step <= 3 ? step : step === 4 ? 3 : 4;
  const error = requestError(body, { model, tools: true, toolIds: calls.slice(0, count).map(call => call.id), lastUserIncludes: step >= 4 ? recovery : prompt });
  if (error) return error;
  if (body.stream !== true || !calls.every(call => body.tools.some(tool => tool.function && tool.function.name === call.function.name))) return 'wrong transport or tool schemas';
  const m = body.messages;
  if (m[0].role !== 'system' || typeof m[0].content !== 'string' || !m[0].content || JSON.stringify(m.slice(1)) !== JSON.stringify(tail(step))) return 'wrong complete literal parameter history';
  if (step && log && m[0].content !== log[0].messages[0].content) return 'system drift';
  return null;
}
function transcript(log) { return Array.isArray(log) && log.length === 6 && log.every((body, i) => !stepError(body, i, log)); }
function cleanObservation(events) { return Array.isArray(events) && events.length === 1 && events[0] && events[0].event === 'prototype-exit' && ['keysEqual', 'descriptorsEqual', 'ordinaryProtoSame', 'ordinaryClean'].every(key => events[0][key] === true); }
function output(text, code) { return code === 0 && typeof text === 'string' && [reply, recovered, 'Goodbye!'].every(value => text.split(value).length === 2) && !/\[ERROR\]|\[REPL\]|MOCK_PROTOCOL|step limit|Prototype probe failure/.test(text); }
function audit(audits, runtime) {
  if (!Array.isArray(audits) || !Array.isArray(runtime)) return false;
  const tasks = runtime.filter(row => row && row.scope === 'cli-task'), tools = audits.filter(row => row && row.type === 'tool');
  if (tasks.length !== 2 || !tasks.every(row => row.status === 'ok' && executionIdentity(row.executionId)) || tasks[0].executionId === tasks[1].executionId || tools.length !== 4 || runtime.some(row => row.scope === 'tool')) return false;
  return calls.every((call, i) => {
    const rows = tools.filter(row => row.callId === call.id); if (rows.length !== 1) return false;
    const row = rows[0], args = JSON.parse(rawArgs[i]);
    return row.tool === names[i] && row.status === 'ok' && row.executionId === tasks[i === 3 ? 1 : 0].executionId && row.result === results[i].substring(0, 160) &&
      row.args && row.args.path === JSON.stringify(file) && (args.content === undefined || row.args.content === JSON.stringify(args.content));
  });
}
async function start() {
  const log = [], errors = [], sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '', bytes = 0; req.setEncoding('utf8'); req.on('error', error => errors.push(error.message));
    req.on('data', text => { bytes += Buffer.byteLength(text); if (bytes > 2 * 1024 * 1024) req.destroy(Error('G3 fixture input limit')); else raw += text; });
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('wrong actual route');
        const body = JSON.parse(raw), step = log.length, error = stepError(body, step, log); if (error) throw Error(error); log.push(body);
        const index = step <= 2 ? step : step === 4 ? 3 : -1;
        const delta = index >= 0 ? { role: 'assistant', content: '', tool_calls: [Object.assign({ index: 0 }, calls[index])] } : { role: 'assistant', content: step === 3 ? reply : recovered };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
      } catch (error) { errors.push(error.message); res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MOCK_PROTOCOL ' + error.message } })); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { log, errors, endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { model, prompt, recovery, marker, initial, appended, finalFile, reply, recovered, file, rawArgs, names, results, calls, tail, stepError, transcript, cleanObservation, output, audit, start };
