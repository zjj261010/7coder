const fs = require('fs');
const p = 'D:/ai-workspaces/7coder/index.js';
let s = fs.readFileSync(p, 'utf8');

// 1) serve webui at / and /ui, plus /api/info - inserted before /v1/models
const anchor = "  const server = http.createServer((req, res) => {\n    if (req.method === 'GET' && req.url === '/v1/models') {";
if (!s.includes(anchor)) { console.error('server anchor not found'); process.exit(1); }
const insert = [
  "  const server = http.createServer((req, res) => {",
  "    // Built-in chat UI (Chinese-friendly web frontend for the terminal-shy)",
  "    if (req.method === 'GET' && (req.url === '/' || req.url === '/ui')) {",
  "      try {",
  "        const html = fs.readFileSync(path.join(appDir, 'webui.html'));",
  "        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
  "        res.end(html);",
  "      } catch (e) {",
  "        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });",
  "        res.end('webui.html not found next to index.js');",
  "      }",
  "      return;",
  "    }",
  "    if (req.method === 'GET' && req.url === '/api/info') {",
  "      res.writeHead(200, { 'Content-Type': 'application/json' });",
  "      res.end(JSON.stringify({ model: HEAVY_MODEL, light: LIGHT_MODEL, workspace: launchDir, mode: PERMISSION_MODE, keyRequired: !!HTTP_API_KEY }));",
  "      return;",
  "    }",
  "    if (req.method === 'GET' && req.url === '/v1/models') {"
].join('\n');
s = s.replace(anchor, insert);

// 2) SSE keep-alive during streaming (UI shows working state; proxies stay warm)
const streamAnchor = "            const result = await processWithTools(tempMessages, { onDelta: t => writeChunk({ content: t }, null), cancel: () => clientGone });";
if (!s.includes(streamAnchor)) { console.error('stream anchor not found'); process.exit(1); }
s = s.replace(streamAnchor, [
  "            const ka = setInterval(() => {",
  "              if (clientGone || res.destroyed) { clearInterval(ka); return; }",
  "              try { res.write(': keep-alive\\n\\n'); } catch (e) { clientGone = true; clearInterval(ka); }",
  "            }, 5000);",
  "            const result = await processWithTools(tempMessages, { onDelta: t => writeChunk({ content: t }, null), cancel: () => clientGone });",
  "            clearInterval(ka);"
].join('\n'));

fs.writeFileSync(p, s);
console.log('server patched: webui=' + s.includes('webui.html not found') + ' info=' + s.includes('/api/info') + ' ka=' + s.includes(': keep-alive'));
