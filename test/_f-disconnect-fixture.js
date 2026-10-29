'use strict';
const http = require('http'), { requestError } = require('./_protocol');
const model = 'f-disconnect-main', partial = 'F5_PARTIAL_BODY_中文😀', done = 'F5_RECOVERED_EXACT';
const call = { id: 'f5-sleep', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":60000}' } };
const prompt = kind => 'F5_' + kind.toUpperCase() + '_ABORT';
const next = kind => 'F5_' + kind.toUpperCase() + '_NEXT';
function stepError(body, kind, index) {
  if (index !== 0 && index !== 1) return 'unexpected extra model request';
  const expected = index ? next(kind) : prompt(kind);
  const error = requestError(body, { model, tools: true, toolIds: [], lastUserIncludes: expected });
  if (error) return error;
  if ((body.stream === true) !== (index === 0)) return 'wrong transport';
  return body.messages.length === 2 && body.messages[0].role === 'system' && typeof body.messages[0].content === 'string' &&
    body.messages[0].content.length > 0 && body.messages[1].role === 'user' && body.messages[1].content === expected ? null : 'wrong complete isolated task';
}
function transcript(log, kind) { return Array.isArray(log) && log.length === 2 && log.every((body, i) => !stepError(body, kind, i)); }
function observed(body, kind) {
  try {
    const lines = body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
    if (!lines.length || lines.includes('[DONE]')) return false;
    const events = lines.map(line => JSON.parse(line));
    if (events.some(event => event.error || !event.choices || !event.choices[0] || event.choices[0].finish_reason)) return false;
    const deltas = events.map(event => event.choices[0].delta), content = deltas.map(delta => delta.content || '').join('');
    const calls = deltas.filter(delta => delta.tool_call).map(delta => delta.tool_call);
    if (deltas.some(delta => delta.tool_result)) return false;
    return kind === 'partial' ? content === partial && calls.length === 0 :
      content === '' && calls.length === 1 && calls[0].callId === call.id && calls[0].name === 'sleep_tool' && calls[0].args.ms === '60000';
  } catch (e) { return false; }
}
function active(info, kind) {
  const r = info && info.runtime, l = info && info.load;
  return !!(r && l && r.activeTasks === 1 && r.activeTools === (kind === 'tool' ? 1 : 0) && l.chatRequests === 1 && l.chatActive === true);
}
function idle(info) {
  const r = info && info.runtime, l = info && info.load, q = l && l.summaries;
  return !!(r && l && q && r.activeTasks === 0 && r.activeTools === 0 && l.chatRequests === 0 && l.chatBodyBytes === 0 &&
    l.chatActive === false && l.chatQueued === 0 && q.active === false && q.pending === 0 && q.bytes === 0);
}
function cancellation(audits, runtime, kind) {
  if (!Array.isArray(audits) || !Array.isArray(runtime)) return false;
  const tools = audits.filter(row => row && row.type === 'tool'), tasks = runtime.filter(row => row && row.scope === 'http-task');
  return tasks.length === 1 && tasks[0].status === 'cancelled' && (kind === 'partial' ? tools.length === 0 :
    tools.length === 1 && tools[0].callId === call.id && tools[0].tool === 'sleep_tool' && tools[0].status === 'cancelled');
}
async function start(kind) {
  if (!['partial', 'tool'].includes(kind)) throw Error('unknown disconnect fixture mode');
  const log = [], sockets = new Set(); let heldClosed = false, heldFinished = false;
  const server = http.createServer((req, res) => {
    const chunks = []; let bytes = 0;
    req.on('error', () => {});
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400); res.end('invalid JSON'); return; }
      const index = log.length; log.push(body); const error = stepError(body, kind, index);
      if (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'F5_PROTOCOL: ' + error } })); return; }
      if (index) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: done } }] })); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = kind === 'partial' ? { role: 'assistant', content: partial } : { role: 'assistant', tool_calls: [Object.assign({ index: 0 }, call)] };
      res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n');
      if (kind === 'partial') res.once('close', () => { heldClosed = true; heldFinished = res.writableFinished; });
      else res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { kind, log, endpoint: 'http://127.0.0.1:' + server.address().port + '/v1',
    upstreamAborted: () => heldClosed && !heldFinished,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
function openStream(port, kind) {
  const state = { body: '', closed: false, aborted: false, status: null, error: null }; let response;
  const text = JSON.stringify({ stream: true, messages: [{ role: 'user', content: prompt(kind) }] });
  const request = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, res => {
    response = res; state.status = res.statusCode; res.setEncoding('utf8');
    res.on('data', chunk => { if (state.body.length + chunk.length > 65536) { state.error = Error('F5 client response cap'); res.destroy(); } else state.body += chunk; });
    res.on('error', error => { if (!state.aborted) state.error = error; });
    res.once('close', () => { state.closed = true; clearTimeout(timer); });
  });
  request.on('error', error => { if (!state.aborted) state.error = error; });
  const timer = setTimeout(() => { state.error = Error('F5 client deadline'); if (response) response.destroy(); request.destroy(); }, 10000);
  request.end(text);
  return { state, abort() { state.aborted = true; clearTimeout(timer); if (response) response.destroy(); request.destroy(); } };
}
module.exports = { model, partial, done, call, prompt, next, stepError, transcript, observed, active, idle, cancellation, start, openStream };
