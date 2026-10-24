const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), zlib = require('zlib');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'tool-http-budget' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set(), counts = new Map(), webLimit = 2 * 1024 * 1024, rpcLimit = 4 * 1024 * 1024;
let checks = 0, server, H, base;
const deadline = setTimeout(() => { console.error('TOOL/HTTP deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(cwd, overrides) {
  const c = loadContext(source, cwd, overrides, { Buffer, appDir: path.dirname(S.IDX), console: { log() {}, warn() {} },
    MCP_SERVER_URLS: [], MCP_NPX_PKGS: [], mcpServers: {}, SEARCH_PROVIDER: 'searxng', SEARCH_ENDPOINT: base, SEARCH_API_KEY: '' });
  vm.runInContext('async function tool(name,args,cancelled=null,modelContext=null) {\n' + cut("  if (name === 'web_fetch_tool') {", "  if (name === 'download_tool') {") +
    cut("  if (name === 'web_search_tool') {", "  if (name === 'notebook_edit_tool') {") +
    cut("  if (name === 'read_mcp_resource_tool') {", "  if (name === 'mcp_list_tools_tool') {") +
    cut("  if (name === 'skill_tool') {", "  if (name === 'prompt_from_file') {") + '\n}', c);
  return c;
}
function sparse(file, size) { const fd = fs.openSync(file, 'w'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } }
function count(route) { return counts.get(route) || 0; }
(async () => {
  try {
    server = http.createServer((req, res) => { let raw = ''; req.setEncoding('utf8'); req.on('data', d => raw += d); req.on('end', () => {
      const route = req.url.split('?')[0]; counts.set(route, count(route) + 1);
      if (route === '/model/chat/completions') {
        const body = JSON.parse(raw), task = body.messages.filter(m => m.role === 'user').slice(-1)[0].content;
        const message = body.messages.some(m => m.role === 'tool') ? { content: 'HTTP_BUDGET_RECOVERED' } : { content: '', tool_calls: [{ id: task, type: 'function', function: { name: 'mcp_tool', arguments: JSON.stringify({ mcp_url: base + (task === 'rpc-big' ? '/rpc-big' : '/rpc-small'), tool_name: 'fixture' }) } }] };
        res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      if (route === '/large' || route === '/search-big/search') { res.end('x'.repeat(webLimit + 1)); return; }
      if (route === '/gzip') { res.setHeader('Content-Encoding', 'gzip'); res.end(zlib.gzipSync('x'.repeat(webLimit + 1))); return; }
      if (route === '/exact') { res.end('x'.repeat(webLimit)); return; }
      if (route === '/rpc-big/invoke') { res.end('x'.repeat(rpcLimit + 1)); return; }
      if (route === '/rpc-cut/invoke') { res.writeHead(200, { 'Content-Length': 100000 }); res.write('begun'); setImmediate(() => res.destroy()); return; }
      if (route === '/rpc-small/invoke') { res.end('MCP error: ordinary data'); return; }
      if (route === '/rpc-json/invoke' || route === '/json') { let deep = JSON.stringify({ leaf: 'literal {"}[], :' }); for (let i = 0; i < 100; i++) deep = '{"nested":' + deep + '}'; res.setHeader('Content-Type', 'application/json'); res.end('[' + Array(500).fill(deep).join(',') + ']'); return; }
      if (route === '/search') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ results: [{ title: 'Search error: literal title', url: 'local://one' }] })); return; }
      if (route === '/links') { res.end(Array.from({ length: 100 }, (_, i) => '<a href="local://' + i + '">L' + i + '</a>').join('')); return; }
      res.end('Fetch error: ordinary page data');
    }); }); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
    const cwd = S.freshCwd('tools'), c = context(cwd);
    for (const name of ['web_fetch_tool', 'web_browser_tool']) {
      for (const route of ['/large', '/gzip']) { const result = await c.tool(name, { url: base + route }); check(name + ' rejects ' + route + ' by decompressed bytes in one request', result.status === 'error' && result.text.includes('maxContentLength') && count(route) === (name === 'web_fetch_tool' ? 1 : 2)); }
    }
    const exact = await c.tool('web_fetch_tool', { url: base + '/exact' }); check('exact 2MiB buffered fetch is accepted without partial truncation', exact.status === 'ok' && exact.text.length === webLimit && count('/exact') === 1);
    const small = await c.tool('web_fetch_tool', { url: base + '/small' }); check('normal fetch text with error prefix stays authoritative success', small.status === 'ok' && small.text === 'Fetch error: ordinary page data');
    c.SEARCH_ENDPOINT = base + '/search-big'; const search = await c.tool('web_search_tool', { query: 'fixture' }); check('local search provider rejects oversized response once', search.status === 'error' && search.text.includes('maxContentLength') && count('/search-big/search') === 1);
    c.SEARCH_ENDPOINT = base; const searchSmall = await c.tool('web_search_tool', { query: 'fixture' }); check('search recovers next request and retains literal title', searchSmall.status === 'ok' && searchSmall.text.includes('Search error: literal title'));
    const page = await c.tool('web_browser_tool', { url: base + '/links', action: 'click' }); check('browser link preview keeps first twenty links', page.status === 'ok' && page.text.includes('L19 -> local://19') && !page.text.includes('L20 -> local://20'));
    const formatted = await c.tool('web_fetch_tool', { url: base + '/json' }); check('small compact JSON cannot expand without limit during fetch formatting', formatted.status === 'error' && formatted.text.includes('Fetched JSON exceeds'));
    const rpc = await c.tool('mcp_tool', { mcp_url: base + '/rpc-big', tool_name: 'fixture' }); check('oversized MCP response after invocation reports unknown outcome without replay', rpc.status === 'error' && rpc.text.includes('maxContentLength') && rpc.text.includes('remote result unknown') && count('/rpc-big/invoke') === 1);
    const cut = await c.tool('mcp_tool', { mcp_url: base + '/rpc-cut', tool_name: 'fixture' }); check('MCP early close preserves unknown-outcome warning', cut.status === 'error' && cut.text.includes('remote result unknown') && count('/rpc-cut/invoke') === 1);
    const oversizedArgs = await c.tool('mcp_tool', { mcp_url: base + '/rpc-body', tool_name: 'fixture', args: { text: 'x'.repeat(rpcLimit) } }); check('oversized MCP JSON body is refused before transport with zero server invocations', oversizedArgs.status === 'error' && oversizedArgs.text.includes('request body refused before sending') && count('/rpc-body/invoke') === 0);
    const rpcJSON = await c.tool('mcp_tool', { mcp_url: base + '/rpc-json', tool_name: 'fixture' }); check('MCP formatted JSON overflow after invocation is an unknown remote result', rpcJSON.status === 'error' && rpcJSON.text.includes('MCP JSON result exceeds') && rpcJSON.text.includes('remote result unknown') && count('/rpc-json/invoke') === 1);
    const rpcSmall = await c.tool('mcp_tool', { mcp_url: base + '/rpc-small', tool_name: 'fixture' }); check('later successful MCP content with error prefix remains ok', rpcSmall.status === 'ok' && rpcSmall.text === 'MCP error: ordinary data');
    fs.mkdirSync(path.join(cwd, '.mcp')); fs.mkdirSync(path.join(cwd, '.7coder', 'skills'), { recursive: true });
    const resource = path.join(cwd, '.mcp', 'source.txt'), skill = path.join(cwd, '.7coder', 'skills', 'fixture.md'); sparse(resource, rpcLimit + 1); sparse(skill, 1024 * 1024 + 1); let reads = 0;
    const files = context(cwd, { readSync(...args) { reads++; return fs.readSync(...args); } });
    const resourceLarge = await files.tool('read_mcp_resource_tool', { resource_id: 'source.txt' }), skillLarge = await files.tool('skill_tool', { skill_name: 'fixture' });
    check('oversized resource and skill reject before collecting bytes and preserve files', resourceLarge.status === 'error' && resourceLarge.text.startsWith('Resource read error:') && resourceLarge.text.includes('4194304-byte limit') && skillLarge.status === 'error' && skillLarge.text.startsWith('Skill read error:') && skillLarge.text.includes('1048576-byte limit') && reads === 0 && fs.statSync(resource).size === rpcLimit + 1 && fs.statSync(skill).size === 1024 * 1024 + 1);
    fs.writeFileSync(resource, Buffer.from([0xD6, 0xD0])); fs.writeFileSync(skill, Buffer.from([0xD6, 0xD0]));
    check('legacy resource/skill bytes fail losslessly with useful reason', (await files.tool('read_mcp_resource_tool', { resource_id: 'source.txt' })).text.includes('Unsupported text encoding') && (await files.tool('skill_tool', { skill_name: 'fixture' })).text.includes('Unsupported text encoding') && fs.readFileSync(resource).equals(Buffer.from([0xD6, 0xD0])));
    fs.writeFileSync(resource, '[ERROR] literal resource中文😀'); fs.writeFileSync(skill, 'Follow literal task中文😀');
    const resourceOkay = await files.tool('read_mcp_resource_tool', { resource_id: 'source.txt' }), skillOkay = await files.tool('skill_tool', { skill_name: 'fixture', params: { quoted: '中文"😀' } });
    check('normal resource and skill preserve UTF8 and explicit successful status', resourceOkay.status === 'ok' && resourceOkay.text === '[ERROR] literal resource中文😀' && skillOkay.status === 'ok' && skillOkay.text.includes('Follow literal task中文😀') && skillOkay.text.includes('Caller-provided params:'));
    const noResource = await files.tool('read_mcp_resource_tool', { resource_id: 'missing.txt' }), noSkill = await files.tool('skill_tool', { skill_name: 'missing' });
    check('missing resource/skill retain prior not-found contract', noResource.status === 'error' && noResource.text.startsWith('Resource not found') && noSkill.status === 'error' && noSkill.text.startsWith('Skill "missing" not found'));
    const denied = context(cwd, { openSync(file, flags, mode) { if (file === resource || file === skill) throw Object.assign(Error('injected EACCES'), { code: 'EACCES' }); return fs.openSync(file, flags, mode); } });
    check('permission failures are no longer reported as nonexistent resources/skills', (await denied.tool('read_mcp_resource_tool', { resource_id: 'source.txt' })).text.includes('Resource read error: injected EACCES') && (await denied.tool('skill_tool', { skill_name: 'fixture' })).text.includes('Skill read error: injected EACCES'));
    H = require('./_endpoint').create({ suite: 'tool-http-agent', endpoint: base + '/model', key: 'fixture', model: 'fixture', permissionMode: 'bypass' }); await H.start(cwd);
    const previous = count('/rpc-big/invoke'), response = await H.chat([{ role: 'user', content: 'rpc-big' }], 8000), outcome = response.tools.find(t => t.type === 'result');
    check('actual Agent reports oversized remote operation error once in SSE/audit', response.content === 'HTTP_BUDGET_RECOVERED' && outcome.status === 'error' && outcome.result.includes('remote result unknown') && count('/rpc-big/invoke') === previous + 1 && S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).some(row => row.type === 'tool' && row.callId === 'rpc-big' && row.status === 'error'));
    const next = await H.chat([{ role: 'user', content: 'rpc-small' }], 8000), info = JSON.parse((await H.api('/api/info')).body);
    check('same Agent completes next remote call after failure with idle active state', next.tools.some(t => t.type === 'result' && t.status === 'completed' && t.result.includes('ordinary data')) && info.runtime.activeTools === 0 && info.runtime.activeTasks === 0);
    console.log('TOOL/HTTP ' + checks + '/' + checks + ' passed; SKIP 0; all endpoints local');
  } finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } S.cleanup(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
