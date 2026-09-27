// Chaos mock OpenAI endpoint for fault-injection tests (suite B).
// FAULT_MODE env selects the failure injected on every POST:
//   500 | 401 | 429-then-ok | malformed | reset | chaos-sse
// '429-then-ok' and 'chaos-sse' fall back to scripted replies (MOCK_SCRIPT).
const http = require('http');
const fs = require('fs');
const FAULT = process.env.FAULT_MODE || '500';
const PORT = parseInt(process.env.MOCK_PORT, 10) || 17800;
const script = (process.env.MOCK_SCRIPT && fs.existsSync(process.env.MOCK_SCRIPT))
  ? JSON.parse(fs.readFileSync(process.env.MOCK_SCRIPT, 'utf8'))
  : [{ role: 'assistant', content: 'MOCK-DEFAULT' }];
let i = 0;
let postCount = 0;
const logPath = __dirname + '\\mock-log-' + PORT + '.jsonl';
fs.writeFileSync(logPath, '');

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    fs.appendFileSync(logPath, body + '\n');
    postCount++;
    if (FAULT === '500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      return;
    }
    if (FAULT === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad upstream key' } }));
      return;
    }
    if (FAULT === '429-then-ok') {
      if (postCount === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      return serveScript(res, body);
    }
    if (FAULT === 'malformed') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not json {{{');
      return;
    }
    if (FAULT === 'reset') {
      res.socket.destroy();
      return;
    }
    if (FAULT === 'chaos-sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      const c = step.content || '';
      const half = Math.max(1, Math.floor(c.length / 2));
      res.write('garbage noise line\n\n');
      res.write('data: {broken json\n\n');
      res.write(': sse comment\n\n');
      res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: c.substring(0, half) }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { content: c.substring(half) }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    serveScript(res, body);
  });
}).listen(PORT, '127.0.0.1', () => console.log('chaos mock [' + FAULT + '] on ' + PORT));

function serveScript(res, body) {
  const step = script[Math.min(i, script.length - 1)];
  i++;
  if (body.indexOf('"stream":true') >= 0) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, fin) => res.write('data: ' + JSON.stringify({ id: 'x' + i, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: fin || null }] }) + '\n\n');
    if (step.tool_calls) {
      chunk({ role: 'assistant', tool_calls: step.tool_calls.map((tc, idx) => ({ index: idx, id: tc.id, type: 'function', function: tc.function })) }, null);
    } else if (step.content) {
      const half = Math.max(1, Math.floor(step.content.length / 2));
      chunk({ role: 'assistant', content: step.content.substring(0, half) }, null);
      chunk({ content: step.content.substring(half) }, null);
    }
    chunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  const out = { id: 'x' + i, object: 'chat.completion', created: 1, model: 'mock', choices: [{ index: 0, message: step, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out));
}
