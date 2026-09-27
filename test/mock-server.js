// Streaming-aware mock OpenAI endpoint for the multi-dimension test suite.
// POST /v1/chat/completions -> scripted steps in request order (SSE if body has "stream":true).
// GET on any other path -> fixed blob without consuming a step (for web_fetch/download tests).
const http = require('http');
const fs = require('fs');
const script = JSON.parse(fs.readFileSync(process.env.MOCK_SCRIPT, 'utf8'));
const PORT = parseInt(process.env.MOCK_PORT, 10) || 17600;
let i = 0;
const logPath = __dirname + '\\mock-log-' + PORT + '.jsonl';
fs.writeFileSync(logPath, '');
http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MOCKBLOB-1234567890-MOCKBLOB');
    return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    fs.appendFileSync(logPath, body + '\n');
    const step = script[Math.min(i, script.length - 1)];
    i++;
    const id = 'x' + i;
    if (body.indexOf('"stream":true') >= 0) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, fin) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: fin || null }] }) + '\n\n');
      if (step.tool_calls) {
        chunk({ role: 'assistant', tool_calls: step.tool_calls.map((tc, idx) => ({ index: idx, id: tc.id, type: 'function', function: tc.function })) }, null);
      } else if (step.content) {
        const c = step.content;
        chunk({ role: 'assistant', content: c.substring(0, Math.max(1, Math.floor(c.length / 2))) }, null);
        chunk({ content: c.substring(Math.max(1, Math.floor(c.length / 2))) }, null);
      } else {
        chunk({ role: 'assistant', content: '' }, null);
      }
      chunk({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const out = { id, object: 'chat.completion', created: 1, model: 'mock', choices: [{ index: 0, message: step, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => console.log('mock up on ' + PORT));
