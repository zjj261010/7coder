'use strict';
const http = require('http'), { requestError } = require('./_protocol');
const model = 'f-endpoint-main', suffixes = ['/v1', '/v1/', '/v1///'];
const prompts = suffixes.map((_, i) => 'F7_ENDPOINT_TASK_' + i), replies = suffixes.map((_, i) => 'F7_ENDPOINT_REPLY_' + i + '中文😀');
function stepError(row, i) {
  if (!row || !Number.isInteger(i) || i < 0 || i >= suffixes.length) return 'unexpected request';
  if (row.method !== 'POST' || row.url !== '/v1/chat/completions') return 'wrong actual method or path';
  const body = row.body, error = requestError(body, { model, tools: true, toolIds: [], lastUserIncludes: prompts[i] });
  if (error) return error;
  const m = body.messages;
  return body.stream === true && m.length === 2 && m[0].role === 'system' && typeof m[0].content === 'string' && m[0].content &&
    m[1].role === 'user' && m[1].content === prompts[i] ? null : 'wrong complete task or transport';
}
function transcript(log) { return Array.isArray(log) && log.length === suffixes.length && log.every((row, i) => !stepError(row, i)); }
function completed(output, code, i) { return code === 0 && typeof output === 'string' && output.split(replies[i]).length === 2 && !/\[ERROR\]|MOCK_PROTOCOL|Error writing to 7CODER/.test(output); }
async function start() {
  const log = [], errors = [], sockets = new Set();
  const server = http.createServer((req, res) => {
    let text = '', size = 0; req.setEncoding('utf8'); req.on('error', error => errors.push(error.message));
    req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 2 * 1024 * 1024) req.destroy(Error('F7 input budget')); else text += chunk; });
    req.on('end', () => {
      try {
        const row = { method: req.method, url: req.url, body: JSON.parse(text) }, i = log.length; log.push(row);
        const error = stepError(row, i); if (error) throw Error(error);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: replies[i] }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      } catch (error) { errors.push(error.message); res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MOCK_PROTOCOL ' + error.message } })); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, log, errors, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { model, suffixes, prompts, replies, stepError, transcript, completed, start };
