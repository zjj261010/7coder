const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const cwd = path.join(require('os').tmpdir(), 'wf-dbg');
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });
const m = spawn(process.execPath, ['D:/ai-workspaces/7coder/test/mock-server.js'], { env: Object.assign({}, process.env, { MOCK_SCRIPT: 'D:/ai-workspaces/7coder/test/cur-x.json', MOCK_PORT: '18650' }), stdio: 'ignore' });
fs.writeFileSync('D:/ai-workspaces/7coder/test/cur-x.json', JSON.stringify([{ role: 'assistant', content: 'x' }]));
setTimeout(() => {
  const srv = spawn(process.execPath, ['D:/ai-workspaces/7coder/index.js', '--server'], { env: Object.assign({}, process.env, { OPENAI_API_KEY: 'x', OPENAI_ENDPOINT: 'http://127.0.0.1:18650/v1', MAX_RETRIES: '1', HTTP_PORT: '18651', PERMISSION_MODE: 'bypass' }), cwd, stdio: 'ignore' });
  setTimeout(() => {
    const body = JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Use workflow_tool: steps=[{tool:"write_file",args:{path:"wf.txt",content:"WF-RAN"}},{tool:"read_file",args:{path:"wf.txt"}}]' }] });
    const req = http.request({ host: '127.0.0.1', port: 18651, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => out += c);
      res.on('end', () => {
        let acc = '';
        for (const line of out.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const pl = line.substring(5).trim();
          if (!pl || pl === '[DONE]') continue;
          try { const j = JSON.parse(pl); const d = j.choices[0].delta; if (d.content) acc += d.content; } catch (e) {}
        }
        console.log(acc);
        srv.kill(); m.kill(); process.exit(0);
      });
    });
    req.end(body);
  }, 2500);
}, 600);
