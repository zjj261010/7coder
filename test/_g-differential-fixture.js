'use strict';
const http = require('http'), { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
const model = 'g-differential-main', prompt = 'G6_DIFFERENTIAL_TASK', recovery = 'G6_READ_BOTH_RESULTS';
const reply = 'G6_DIFFERENTIAL_EXACT中文😀', recovered = 'G6_BOTH_RESULTS_EXACT中文😀';
const pageFile = 'pages 中文.txt', globalFile = 'global 中文.txt', serialFile = 'singles 中文.txt';
const lines = Array.from({ length: 100 }, (_, i) => i === 11 ? '' : 'LINE-' + String(i + 1).padStart(3, '0') + (i === 19 ? ' 中文😀' : ''));
const pageText = lines.join('\n') + '\n';
const original = 'A<TOKEN>A\nB<TOKEN>B\nC<TOKEN>C', replacement = '$&$$$1中文😀';
// Independent literal golden: neither this nor serial intermediate states use
// the product replacer or JavaScript's replacement-pattern interpolation.
const stages = [original, 'A<$&$$$1中文😀>A\nB<TOKEN>B\nC<TOKEN>C', 'A<$&$$$1中文😀>A\nB<$&$$$1中文😀>B\nC<TOKEN>C', 'A<$&$$$1中文😀>A\nB<$&$$$1中文😀>B\nC<$&$$$1中文😀>C'];
const finalFile = stages[3];
function numbered(textLines, start) { return textLines.map((text, i) => ('      ' + (start + i)).slice(-6) + '\t' + text).join('\n'); }
const names = ['read_file', 'read_file', 'edit_file', 'edit_file', 'edit_file', 'edit_file', 'edit_file', 'read_file', 'read_file'];
const args = [
  { path: pageFile, offset: 10, limit: 20 }, { path: pageFile, offset: 99, limit: 10 },
  { path: globalFile, old_string: 'TOKEN', new_string: replacement },
  { path: globalFile, old_string: 'TOKEN', new_string: replacement, replace_all: true },
  ...['A', 'B', 'C'].map(letter => ({ path: serialFile, old_string: letter + '<TOKEN>' + letter, new_string: letter + '<' + replacement + '>' + letter })),
  { path: globalFile }, { path: serialFile }
];
const results = [
  numbered(lines.slice(9, 29), 10), numbered([lines[98], lines[99], ''], 99),
  'Edit error: old_string found 3 times - add more surrounding context to make it unique, or set replace_all=true',
  '[OK] Edited ' + globalFile + ' (3 replacement(s))',
  ...['A', 'B', 'C'].map(() => '[OK] Edited ' + serialFile + ' (1 replacement(s))'),
  numbered(finalFile.split('\n'), 1), numbered(finalFile.split('\n'), 1)
];
const calls = names.map((name, i) => ({ id: 'g6-' + i, type: 'function', function: { name, arguments: JSON.stringify(args[i]) } }));
function countAt(step) { return step <= 7 ? step : Math.min(step - 1, 9); }
function pair(messages, i) { messages.push({ role: 'assistant', content: '', tool_calls: [calls[i]] }, { role: 'tool', tool_call_id: calls[i].id, content: results[i] }); }
function tail(step) {
  const messages = [{ role: 'user', content: prompt }];
  for (let i = 0; i < Math.min(step, 7); i++) pair(messages, i);
  if (step >= 8) { messages.push({ role: 'assistant', content: reply }, { role: 'user', content: recovery }); for (let i = 7; i < countAt(step); i++) pair(messages, i); }
  return messages;
}
function stepError(body, step, log) {
  if (!Number.isInteger(step) || step < 0 || step > 10) return 'extra model request';
  const error = requestError(body, { model, tools: true, toolIds: calls.slice(0, countAt(step)).map(call => call.id), lastUserIncludes: step >= 8 ? recovery : prompt });
  if (error) return error;
  if (body.stream !== true || !['read_file', 'edit_file'].every(name => body.tools.some(tool => tool && tool.function && tool.function.name === name))) return 'wrong transport or offered schema';
  const messages = body.messages;
  if (messages[0].role !== 'system' || typeof messages[0].content !== 'string' || !messages[0].content || JSON.stringify(messages.slice(1)) !== JSON.stringify(tail(step))) return 'wrong exact history at step ' + step;
  if (step && log && messages[0].content !== log[0].messages[0].content) return 'system drift';
  return null;
}
function transcript(log) { return Array.isArray(log) && log.length === 11 && log.every((body, step) => !stepError(body, step, log)); }
function states(rows) {
  return Array.isArray(rows) && rows.length === 5 && rows.every((row, i) => {
    const step = i + 3, same = (bytes, text) => Buffer.isBuffer(bytes) && bytes.equals(Buffer.from(text, 'utf8'));
    return row && row.step === step && row.requestCount === step + 1 && row.toolCount === step && row.taskCount === 0 &&
      same(row.pages, pageText) && same(row.global, step === 3 ? original : finalFile) && same(row.serial, stages[Math.max(0, step - 4)]) &&
      row.hasBackups === (step !== 3);
  });
}
function audit(audits, runtime) {
  if (!Array.isArray(audits) || !Array.isArray(runtime)) return false;
  const tasks = runtime.filter(row => row && row.scope === 'cli-task'), tools = audits.filter(row => row && row.type === 'tool'), failures = runtime.filter(row => row && row.scope === 'tool');
  if (tasks.length !== 2 || !tasks.every(row => row.status === 'ok' && executionIdentity(row.executionId)) || tasks[0].executionId === tasks[1].executionId || tools.length !== 9) return false;
  if (failures.length !== 1 || failures[0].status !== 'error' || failures[0].id !== 'edit_file' || failures[0].callId !== calls[2].id || failures[0].executionId !== tasks[0].executionId || failures[0].message !== results[2]) return false;
  return calls.every((call, i) => {
    const row = tools[i];
    return row.callId === call.id && row.executionId === tasks[i < 7 ? 0 : 1].executionId && row.tool === names[i] && row.mode === 'bypass' && row.status === (i === 2 ? 'error' : 'ok') &&
      row.args && Object.keys(args[i]).every(key => row.args[key] === JSON.stringify(args[i][key])) && row.result === results[i].split('\n')[0].substring(0, 160);
  });
}
function output(text, code) { return code === 0 && typeof text === 'string' && [reply, recovered, 'Goodbye!'].every(value => text.split(value).length === 2) && !/\[ERROR\]|\[REPL\]|MOCK_PROTOCOL|step limit/.test(text); }
async function start() {
  const log = [], errors = [], sockets = new Set(), held = new Map();
  const server = http.createServer((req, res) => {
    let raw = '', bytes = 0; req.setEncoding('utf8'); req.on('error', error => errors.push(error.message));
    req.on('data', text => { bytes += Buffer.byteLength(text); if (bytes > 2 * 1024 * 1024) req.destroy(Error('G6 fixture input limit')); else raw += text; });
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('wrong actual route');
        const body = JSON.parse(raw), step = log.length, error = stepError(body, step, log); if (error) throw Error(error); log.push(body);
        const send = () => {
          const index = step < 7 ? step : step === 8 ? 7 : step === 9 ? 8 : -1;
          const delta = index >= 0 ? { role: 'assistant', content: '', tool_calls: [Object.assign({ index: 0 }, calls[index])] } : { role: 'assistant', content: step === 7 ? reply : recovered };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
        };
        if (step >= 3 && step <= 7) held.set(step, send); else send();
      } catch (error) { errors.push(error.message); res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MOCK_PROTOCOL ' + error.message } })); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { log, errors, endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', waiting: step => held.has(step), release(step) { const send = held.get(step); if (!send) throw Error('G6 model step not held'); held.delete(step); send(); }, async close() { held.clear(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { model, prompt, recovery, reply, recovered, pageFile, globalFile, serialFile, lines, pageText, original, replacement, stages, finalFile, names, args, results, calls, countAt, tail, stepError, transcript, states, audit, output, start };
