const fs = require('fs');
const p = 'D:/ai-workspaces/7coder/index.js';
let s = fs.readFileSync(p, 'utf8');
// /api/sessions/save: 支持传入 file 名原地覆盖（校验同名防穿越、必须已存在才覆盖）
const anchor = '          const clean = msgs';
if (!s.includes(anchor)) { console.error('save anchor missing'); process.exit(1); }
const oldBlock = [
  '          const clean = msgs',
  '            .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")',
  '            .map(m => ({ role: m.role, content: m.content }));',
  '          const sdir = path.join(launchDir, ".7coder", "sessions");',
  '          fs.mkdirSync(sdir, { recursive: true });',
  '          const name = "web-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";',
  '          fs.writeFileSync(path.join(sdir, name), JSON.stringify({ savedAt: new Date().toISOString(), messages: clean }), "utf8");',
  '          audit({ ts: new Date().toISOString(), type: "session_save", file: name, turns: clean.length });',
  '          res.writeHead(200, { "Content-Type": "application/json" });',
  '          res.end(JSON.stringify({ ok: true, file: name, turns: clean.length }));'
].join('\n');
if (!s.includes(oldBlock)) { console.error('old block not found'); process.exit(1); }
const newBlock = [
  '          const clean = msgs',
  '            .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")',
  '            .map(m => ({ role: m.role, content: m.content }));',
  '          const sdir = path.join(launchDir, ".7coder", "sessions");',
  '          fs.mkdirSync(sdir, { recursive: true });',
  '          // 客户端可携带 file 名原地覆盖同一会话记录；否则生成新记录',
  '          const wanted = String(j.file || "");',
  '          let name = "web-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";',
  '          if (/^[A-Za-z0-9._-]+[.]json$/.test(wanted) && fs.existsSync(path.join(sdir, wanted))) name = wanted;',
  '          fs.writeFileSync(path.join(sdir, name), JSON.stringify({ savedAt: new Date().toISOString(), messages: clean }), "utf8");',
  '          audit({ ts: new Date().toISOString(), type: "session_save", file: name, turns: clean.length });',
  '          res.writeHead(200, { "Content-Type": "application/json" });',
  '          res.end(JSON.stringify({ ok: true, file: name, turns: clean.length }));'
].join('\n');
s = s.replace(oldBlock, newBlock);
fs.writeFileSync(p, s);
console.log('in-place save support added');
