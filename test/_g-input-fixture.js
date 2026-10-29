'use strict';
const http = require('http'), { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
const main = 'g-input-main', light = 'g-input-unused-light';
const surfacePrompt = '/btw\n/help', surfaceReply = 'G1_SURFACE_EXACT中文😀';
const eofPrompt = 'G1_EOF_ACTIVE_TASK', eofReply = 'G1_EOF_EXACT中文😀\nEOF_TAIL';
const call = { id: 'g1-eof-sleep', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":1500}' } };
function stepError(body, kind, step, log) {
  if (!['surface', 'eof'].includes(kind) || !Number.isInteger(step) || step < 0 || step >= (kind === 'surface' ? 1 : 2)) return 'unexpected request';
  const prompt = kind === 'surface' ? surfacePrompt : eofPrompt;
  const error = requestError(body, { model: main, tools: true, toolIds: step ? [call.id] : [], lastUserIncludes: prompt });
  if (error) return error;
  const m = body.messages;
  if (body.stream !== true || m.length !== (step ? 4 : 2) || m[0].role !== 'system' || typeof m[0].content !== 'string' || !m[0].content || m[1].role !== 'user' || m[1].content !== prompt) return 'wrong complete input task or transport';
  if (step && (m[2].role !== 'assistant' || m[2].content !== '' || JSON.stringify(m[2].tool_calls) !== JSON.stringify([call]) || m[3].role !== 'tool' || m[3].tool_call_id !== call.id || m[3].content !== '[OK] Slept 1500ms')) return 'wrong complete tool exchange';
  if (step && log && JSON.stringify(m.slice(0, 2)) !== JSON.stringify(log[0].messages)) return 'changed original request';
  return null;
}
function transcript(log, kind) { return Array.isArray(log) && log.length === (kind === 'surface' ? 1 : 2) && log.every((body, step) => !stepError(body, kind, step, log)); }
function count(text, value) { return typeof text === 'string' ? text.split(value).length - 1 : 0; }
function surfaceOutput(text, code) {
  return code === 0 && count(text, 'No task entered.') === 2 && count(text, surfaceReply) === 1 && count(text, 'Goodbye!') === 1 &&
    !/Usage: \/btw|\[BTW\]|\[ERROR\]|\[REPL\]|MOCK_PROTOCOL/.test(text);
}
function terminal(events) {
  const tasks = Array.isArray(events) ? events.filter(row => row && row.scope === 'cli-task') : [];
  return tasks.length === 1 && tasks[0].status === 'ok' && !!executionIdentity(tasks[0].executionId);
}
function observedEOF(events) { return Array.isArray(events) && events.length === 1 && events[0].event === 'stdin-readline-close' && events[0].stdinEnded === true; }
function naturalEOF(code, signal, forced, elapsed, text) {
  return code === 0 && signal === null && forced === false && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 10000 && count(text, eofReply) === 1 &&
    !/Goodbye!|\[CANCELLED\]|\[ERROR\]|\[REPL\]|MOCK_PROTOCOL|ERR_USE_AFTER_CLOSE|Probe failure/.test(text);
}
function toolCompleted(audits, runtime) {
  const tools = Array.isArray(audits) ? audits.filter(row => row && row.type === 'tool') : [], tasks = Array.isArray(runtime) ? runtime.filter(row => row && row.scope === 'cli-task') : [];
  return terminal(runtime) && tools.length === 1 && tools[0].tool === 'sleep_tool' && tools[0].callId === call.id && tools[0].status === 'ok' && tools[0].executionId === tasks[0].executionId && tools[0].result === '[OK] Slept 1500ms';
}
async function start(kind) {
  const log = [], errors = [], sockets = new Set(), held = new Map();
  const server = http.createServer((req, res) => {
    let raw = '', size = 0; req.setEncoding('utf8'); req.on('error', error => errors.push(error.message));
    req.on('data', text => { size += Buffer.byteLength(text); if (size > 2 * 1024 * 1024) req.destroy(Error('G1 input fixture budget')); else raw += text; });
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('wrong actual model route');
        const body = JSON.parse(raw), step = log.length, error = stepError(body, kind, step, log); if (error) throw Error(error); log.push(body);
        const reply = () => {
          const delta = kind === 'eof' && step === 0 ? { role: 'assistant', content: '', tool_calls: [Object.assign({ index: 0 }, call)] } : { role: 'assistant', content: kind === 'surface' ? surfaceReply : eofReply };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
        };
        if (kind === 'eof') held.set(step, reply); else reply();
      } catch (error) { errors.push(error.message); res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MOCK_PROTOCOL ' + error.message } })); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { log, errors, endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', waiting: step => held.has(step), release(step) { const reply = held.get(step); if (!reply) throw Error('G1 input step is not held'); held.delete(step); reply(); }, async close() { held.clear(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { main, light, surfacePrompt, surfaceReply, eofPrompt, eofReply, call, stepError, transcript, surfaceOutput, terminal, observedEOF, naturalEOF, toolCompleted, start };
