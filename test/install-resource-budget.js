const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), { create } = require('./_endpoint'), S = require('./_shared').create({ suite: 'install-resource-budget' }), source = fs.readFileSync(S.IDX, 'utf8');
const sockets = new Set(); let checks = 0, H, server;
const integration = process.env.INSTALL_RESOURCE_PHASE === 'integration';
const deadline = setTimeout(() => { console.error('INSTALL/RESOURCE/BUDGET deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 40000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function sparse(file) { const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 100 * 1024 * 1024); fs.closeSync(fd); }
function unit(name, overrides) { const cwd = S.freshCwd(name), install = S.freshCwd(name + '-install'), c = loadContext(source, cwd, overrides, { Buffer, appDir: install, console: { warn() {} } });
  vm.runInContext(cut('function runtimeText(', 'function recordRuntimeEvent(') + cut('function configPathForOpen()', 'function replDraftByteLimit('), c); return { c, cwd, install, env: path.join(cwd, '.env'), appEnv: path.join(install, '.env'), template: path.join(install, '.env.example') }; }
(async () => { try {
  if (!integration) {
  let f = unit('normal'), template = '\uFEFF# 中文 fixture\r\nOPENAI_API_KEY=FAKE_VALUE\r\n'; fs.writeFileSync(f.template, template); const resolved = f.c.configPathForOpen();
  check('valid template is copied exactly and resolves workspace env before any editor launch', resolved === f.env && fs.readFileSync(f.env, 'utf8') === template && !fs.existsSync(f.appEnv));
  fs.unlinkSync(f.template); fs.writeFileSync(f.appEnv, 'INSTALL_ONLY'); check('existing workspace config keeps precedence and does not require template', f.c.configPathForOpen() === f.env && fs.readFileSync(f.appEnv, 'utf8') === 'INSTALL_ONLY');
  fs.unlinkSync(f.env); check('existing installation config remains a supported fallback', f.c.configPathForOpen() === f.appEnv && !fs.existsSync(f.env));
  let reads = 0, handles = 0; f = unit('huge', { openSync(...args) { const fd = fs.openSync(...args); handles++; return fd; }, closeSync(fd) { fs.closeSync(fd); handles--; }, readSync(...args) { reads++; return fs.readSync(...args); } }); sparse(f.template);
  assert.throws(() => f.c.configPathForOpen(), e => e.code === 'EFILETOOLARGE'); check('oversized template creates no config and performs no data read, closing handle', reads === 0 && handles === 0 && !fs.existsSync(f.env) && !fs.existsSync(f.appEnv));
  fs.writeFileSync(f.template, Buffer.from([0xD6, 0xD0])); assert.throws(() => f.c.configPathForOpen(), /encoding/); check('invalid template encoding is an explicit failure without writing placeholder config', !fs.existsSync(f.env));
  f = unit('write-failed', { renameSync(a, b) { if (b === f.env) throw Object.assign(Error('template commit denied'), { code: 'EACCES' }); return fs.renameSync(a, b); } }); fs.writeFileSync(f.template, template); assert.throws(() => f.c.configPathForOpen(), /template commit denied/);
  check('configuration write failure propagates rather than selecting a nonexistent install env', !fs.existsSync(f.env) && !fs.existsSync(f.appEnv));
  f = unit('ui-bounded', { readSync(...args) { reads++; return fs.readSync(...args); } }); const page = path.join(f.install, 'webui.html'); sparse(page); reads = 0;
  vm.runInContext(cut('let webuiHtml = null, webuiError = null;', '// ---------- OP5-3:'), f.c); const ui = vm.runInContext('({html:webuiHtml,error:webuiError})', f.c);
  check('huge page is refused before content read with a visible UI component error', ui.html === null && ui.error.code === 'EFILETOOLARGE' && reads === 0);
  }
  server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"API_STILL_WORKS"}}]}\n\ndata: [DONE]\n\n'); }); });
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  H = create({ suite: 'install-resource-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: '', model: 'fixture', permissionMode: 'bypass' }); const install = path.dirname(H.S.IDX), html = path.join(install, 'webui.html'), original = fs.readFileSync(html);
  for (const kind of ['missing', 'empty', 'encoding', 'huge']) {
    if (kind === 'missing') fs.unlinkSync(html); else if (kind === 'empty') fs.writeFileSync(html, ''); else if (kind === 'encoding') fs.writeFileSync(html, Buffer.from([0xD6, 0xD0])); else sparse(html);
    await H.start(S.freshCwd('actual-' + kind)); const info = JSON.parse((await H.api('/api/info')).body), error = await H.api('/').then(() => null, e => e.message);
    check('actual ' + kind + ' page failure is distinguishable while API diagnostics remain ready', !info.ui.available && info.ui.error && error && error.startsWith('Agent HTTP ' + (kind === 'missing' ? 404 : 503) + ': Built-in UI unavailable:'));
  }
  const chat = await H.chat([{ role: 'user', content: 'API task without packaged UI' }], 5000); check('broken UI does not leave core functionality in a hidden failed state', chat.content === 'API_STILL_WORKS');
  const example = path.join(install, '.env.example'); sparse(example); const dry = await H.api('/api/open', { target: 'config', dry: true }); const denied = await H.api('/api/open', { target: 'config' }).then(() => null, e => e.message);
  check('actual template failure returns error before an editor command; dry request stays side-effect free', dry.status === 200 && denied && denied.startsWith('Agent HTTP 400:') && denied.includes('1048576') && !fs.existsSync(path.join(install, '.env')));
  fs.writeFileSync(html, original); await H.start(S.freshCwd('actual-repaired')); const info = JSON.parse((await H.api('/api/info')).body), response = await H.api('/');
  check('repaired page is loaded on next startup and served byte-for-byte with healthy status', info.ui.available && info.ui.error === null && response.status === 200 && response.body === original.toString('utf8'));
  console.log('INSTALL/RESOURCE/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0; no desktop editor or browser launched' + (integration ? '; selected integration only; first 7 checks NOT RUN' : ''));
} finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } for (const s of sockets) s.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
