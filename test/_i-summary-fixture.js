// I4: explicit summary gates replace timing guesses. Test-only local endpoint.
const http = require('http'), { requestError } = require('./_protocol');
const model = 'i-summary-model', tasks = ['I4_STREAM_TASK_中文😀', 'I4_JSON_TASK_中文😀'];
const replies = ['STREAM_REPLY_中文😀\n' + 'Complete streamed response. '.repeat(12) + 'STREAM_TAIL',
  'JSON_REPLY_中文😀\n' + 'Complete JSON response. '.repeat(12) + 'JSON_TAIL'];
const summaries = ['I4_FIRST_SUMMARY_中文😀', 'I4_SECOND_SUMMARY_中文😀'];
function document(count) { return '<!-- 7coder:auto-log:start -->\n' + summaries.slice(0, count).map(s => '- ' + s).join('\n') + '\n<!-- 7coder:auto-log:end -->\n'; }
function task(index) { return tasks[index] + (index ? "\n\nthis is what's already been done.\n" + document(1) : ''); }
function summaryPrompt(index) {
  return `Create a short, concise summary (1-2 sentences) of what has been done in response to the user's task. Do not list tools, just describe the output/effect.\nUser task: "${task(index)}"\nAction/Response: "${replies[index]}"`;
}
function stepError(body, step) {
  if (!Number.isInteger(step) || step < 0 || step > 3) return 'script exhausted';
  const index = Math.floor(step / 2), summary = step % 2 === 1;
  const error = requestError(body, { model, tools: !summary, toolIds: [] });
  if (error) return error;
  if ((body.stream === true) !== (step === 0)) return 'wrong transport branch';
  if (body.messages.length !== (summary ? 1 : 2)) return 'wrong message count';
  if (!summary && (body.messages[0].role !== 'system' || typeof body.messages[0].content !== 'string' || !body.messages[0].content)) return 'missing system message';
  const message = body.messages[summary ? 0 : 1];
  return message.role === 'user' && message.content === (summary ? summaryPrompt(index) : task(index)) ? null : 'wrong complete task/response';
}
function evidence(log, md) { return Array.isArray(log) && log.length === 4 && log.every((body, i) => !stepError(body, i)) && md === document(2); }
function settled(info) { const q = info && info.load && info.load.summaries, r = info && info.runtime;
  return !!(q && r && q.active === false && q.pending === 0 && q.bytes === 0 && r.activeTasks === 0 && r.activeTools === 0); }
async function start() {
  const log = [], sockets = new Set(), held = new Map(); let step = 0;
  const server = http.createServer((req, res) => {
    const chunks = []; let bytes = 0;
    req.on('error', () => {});
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { res.writeHead(400); res.end('invalid JSON'); return; }
      log.push(body); const error = stepError(body, step);
      if (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'I4_PROTOCOL: ' + error } })); return; }
      const index = Math.floor(step / 2), summary = step++ % 2 === 1;
      if (summary) { held.set(index, res); return; }
      if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: replies[index] }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: replies[index] } }] })); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { log, endpoint: 'http://127.0.0.1:' + server.address().port, isHeld: index => held.has(index),
    release(index) { const res = held.get(index); if (!res) throw Error('summary gate not reached'); held.delete(index); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: summaries[index] } }] })); },
    async close() { held.clear(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { model, tasks, replies, summaries, document, task, summaryPrompt, stepError, evidence, settled, start };
