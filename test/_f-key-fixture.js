'use strict';
const http = require('http'), { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
const model = 'f-key-main', prompt = 'F8_REAL_VALID_TASK', reply = 'F8_VALID_EXACT中文😀';
const script = [{ expect: { model, tools: true, toolIds: [], lastUserIncludes: prompt }, reply }];
function transcript(log) {
  if (!Array.isArray(log) || log.length !== 1 || requestError(log[0], script[0].expect)) return false;
  const body = log[0], m = body.messages;
  return body.stream === undefined && m.length === 2 && m[0].role === 'system' && typeof m[0].content === 'string' && !!m[0].content && m[1].role === 'user' && m[1].content === prompt;
}
function denied(responses) { return Array.isArray(responses) && responses.length === 5 && responses.every(response => { try { const body = JSON.parse(response.body); return response.status === 401 && body.error && body.error.message === 'Unauthorized'; } catch (error) { return false; } }); }
function authorized(response) {
  try { const body = JSON.parse(response.body); return response.status === 200 && body.object === 'chat.completion' && body.model === model &&
    Number.isInteger(body.created) && body.created > 0 && typeof body.id === 'string' && body.id.startsWith('chatcmpl-') && executionIdentity(body.id.slice(9)) &&
    Array.isArray(body.choices) && body.choices.length === 1 && body.choices[0].index === 0 && body.choices[0].finish_reason === 'stop' &&
    body.choices[0].message.role === 'assistant' && body.choices[0].message.content === reply ? body.id.slice(9) : null; } catch (error) { return null; }
}
function terminal(events, id) { const tasks = Array.isArray(events) ? events.filter(row => row && row.scope === 'http-task') : []; return !!executionIdentity(id) && tasks.length === 1 && tasks[0].status === 'ok' && tasks[0].executionId === id; }
function rejectedRequest(port, i) {
  return new Promise((resolve, reject) => {
    let settled = false, response, timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { if (response) response.destroy(); req.destroy(); reject(error); } else resolve(value); };
    const data = JSON.stringify({ messages: [{ role: 'user', content: 'F8_DENIED_TASK_' + i }] });
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer wrong-' + i, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      response = res; res.setEncoding('utf8'); let body = '';
      res.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 32768) finish(Error('F8 response budget')); });
      res.on('error', finish); res.on('aborted', () => finish(Error('F8 response aborted'))); res.on('end', () => finish(null, { status: res.statusCode, body }));
    });
    req.on('error', finish); timer = setTimeout(() => finish(Error('F8 request deadline')), 5000); req.end(data);
  });
}
module.exports = { model, prompt, reply, script, transcript, denied, authorized, terminal, rejectedRequest };
