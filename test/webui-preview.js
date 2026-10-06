#!/usr/bin/env node
// Local-only UI fixture. No model calls, disk writes, credentials, or shell execution.
// node test/webui-preview.js [port], then / or /preview?width=390&height=844
const http = require('http');
const fs = require('fs');
const path = require('path');
const port = Number(process.argv[2] || 18765);
let sessions = [];
let settings = { endpoint: 'http://localhost:1234/v1', apiKey: '', model: 'local-preview-model', profiles: {} };
let mode = 'default';
function json(res, obj, status) { res.writeHead(status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/preview') {
    const w = Math.max(320, Math.min(1920, Number(url.searchParams.get('width')) || 390));
    const h = Math.max(480, Math.min(1200, Number(url.searchParams.get('height')) || 844));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Responsive UI fixture</title></head><body style="margin:0;background:#ddd;padding:12px;font:12px system-ui"><p style="margin:0 0 10px">LOCAL PREVIEW · ' + w + ' × ' + h + ' · 仅测试数据</p><iframe title="响应式预览" src="/" style="display:block;width:' + w + 'px;height:' + h + 'px;border:0;box-shadow:0 0 0 1px #aaa"></iframe></body></html>');
    return;
  }
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, '..', 'webui.html'))); return; }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let data = {}; try { data = JSON.parse(body || '{}'); } catch (e) { return json(res, { error: { message: 'Invalid JSON' } }, 400); }
    if (url.pathname === '/api/info') return json(res, { workspace: 'D:/workspace/7coder', mode, model: settings.model, models: [settings.model, 'preview-code-model'], version: '2.18.0' });
    if (url.pathname === '/api/todos') return json(res, { todos: [] });
    if (url.pathname === '/api/sessions') return json(res, { sessions: sessions.map(s => ({ file: s.file, preview: s.messages[0].content, savedAt: '2026-10-05' })) });
    if (url.pathname === '/api/sessions/save') {
      let session = sessions.find(s => s.file === data.file);
      if (!session) { session = { file: 'preview-' + (sessions.length + 1) + '.json' }; sessions.push(session); }
      session.messages = data.messages; return json(res, { file: session.file });
    }
    if (url.pathname === '/api/sessions/load') { const s = sessions.find(s => s.file === data.file); return json(res, s || { messages: [] }); }
    if (url.pathname === '/api/sessions/delete') { sessions = sessions.filter(s => s.file !== data.file); return json(res, { ok: true }); }
    if (url.pathname === '/api/settings') { if (req.method === 'POST') Object.assign(settings, data); return json(res, settings); }
    if (url.pathname === '/api/models-config') { settings.profiles = data.profiles || {}; return json(res, { models: Object.keys(settings.profiles) }); }
    if (url.pathname === '/api/mode') { mode = data.mode; return json(res, { mode }); }
    if (url.pathname === '/api/open') return json(res, { error: { message: '预览不打开工作区或配置文件' } }, 403);
    if (url.pathname === '/api/approve') return json(res, { ok: true });
    if (url.pathname === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const parts = [
        { reasoning: '这是本地预览回复，用于验证思考过程、流式内容与代码块的布局。' },
        { tool_call: { name: 'read_file (preview only)' } },
        { content: '**界面预览检查**\n\n这是测试数据，没有调用真实模型，也没有修改项目文件。\n\n' },
        { content: '可以继续输入任务，或点击「新建对话」返回欢迎页。\n\n```javascript\nconst workspace = "7coder";\nconsole.log(`Hello, ${workspace}!`);\n```' }
      ];
      let index = 0;
      const timer = setInterval(() => { if (index < parts.length) res.write('data: ' + JSON.stringify({ choices: [{ delta: parts[index++] }] }) + '\n\n'); else { clearInterval(timer); res.end('data: [DONE]\n\n'); } }, 450);
      res.on('close', () => clearInterval(timer)); return;
    }
    json(res, { error: { message: 'Preview route not found' } }, 404);
  });
});
server.listen(port, '127.0.0.1', () => console.log('Local fixture: http://127.0.0.1:' + port));
