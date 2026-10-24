// Read-only manual configs: invalid existing files must never turn into defaults.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'config-admission' });
const source = fs.readFileSync(S.IDX, 'utf8'), limit = 1024 * 1024, sockets = new Set();
let checks = 0, server, H;
const deadline = setTimeout(() => { console.error('CONFIG/ADMISSION deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function unit() {
  const cwd = S.freshCwd('workspace'), install = S.freshCwd('private-install'); fs.mkdirSync(path.join(cwd, '.7coder'));
  const c = loadContext(source, cwd, null, { Buffer, appDir: install, console: { log() {}, warn() {} }, mcpServers: { sentinel: { command: 'previous' } } });
  vm.runInContext(cut('function loadMcpServers()', '\ntry { loadMcpServers();') +
    cut('const PROTECTED_FILES =', 'function loadPermRules()') + cut('function loadPermRules()', '\ntry { loadPermRules();'), c);
  return { c, cwd, install, rules: () => vm.runInContext('permRules', c), mp: path.join(cwd, '.7coder', 'mcp.json'), pp: path.join(cwd, '.7coder', 'permissions.json') };
}
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function sparse(file, size) { const fd = fs.openSync(file, 'w'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } }
(async () => {
  try {
    let current;
    if (process.env.CONFIG_PHASE !== 'integration') {
    const u = unit(); u.c.loadMcpServers(); u.c.loadPermRules();
    check('absent optional files yield explicit empty null-prototype MCP map and empty rules', Object.getPrototypeOf(u.c.mcpServers) === null && Object.keys(u.c.mcpServers).length === 0 && u.rules().deny.length === 0);
    const prefix = '\uFEFF{"servers":{}}'; fs.writeFileSync(u.mp, prefix + ' '.repeat(limit - Buffer.byteLength(prefix))); u.c.loadMcpServers();
    check('BOM JSON at exactly 1MiB remains valid', fs.statSync(u.mp).size === limit && Object.keys(u.c.mcpServers).length === 0);
    write(path.join(u.install, 'mcp.json'), { servers: { main: { command: 'install' }, only: { command: 'keep' } } }); write(u.mp, { main: { command: 'workspace', args: [], env: { PORT: 7 } } }); u.c.loadMcpServers();
    check('MCP wrapped/bare maps retain workspace override and unrelated install entries', u.c.mcpServers.main.command === 'workspace' && u.c.mcpServers.only.command === 'keep');
    const beforeMcp = u.c.mcpServers; fs.writeFileSync(u.mp, '{"SECRET-PARSE-BAIT":'); assert.throws(() => u.c.loadMcpServers(), e => /invalid JSON/.test(e.message) && !e.message.includes('SECRET-PARSE-BAIT'));
    check('bad later MCP layer neither leaks parser excerpt nor publishes partial defaults', u.c.mcpServers === beforeMcp && u.c.mcpServers.main.command === 'workspace');
    const invalidMcp = [null, [], 'text', { servers: null }, { servers: [] }, { x: {} }, { x: { command: '' } }, { x: { command: 'node', args: 'bad' } }, { x: { command: 'node', args: [1] } }, { x: { command: 'node', cwd: 1 } }, { x: { command: 'node', env: [] } }, { x: { command: 'node', env: null } }];
    for (const value of invalidMcp) { write(u.mp, value); assert.throws(() => u.c.loadMcpServers()); assert.strictEqual(u.c.mcpServers, beforeMcp); }
    check('all twelve invalid MCP root/server field shapes fail without changing live map', invalidMcp.length === 12);
    const named = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ['s' + i, { command: 'node' }]));
    write(path.join(u.install, 'mcp.json'), {}); write(u.mp, named(32)); u.c.loadMcpServers(); check('32 distinct configured MCP servers are admitted', Object.keys(u.c.mcpServers).length === 32);
    write(u.mp, named(33)); assert.throws(() => u.c.loadMcpServers(), /32 servers/);
    write(path.join(u.install, 'mcp.json'), named(17)); write(u.mp, Object.fromEntries(Object.entries(named(16)).map(([k, v]) => ['workspace-' + k, v]))); assert.throws(() => u.c.loadMcpServers(), /Merged MCP/);
    check('per-file and cross-layer MCP server budgets both reject new configuration', Object.keys(u.c.mcpServers).length === 32);
    write(path.join(u.install, 'mcp.json'), {}); write(u.mp, JSON.parse('{"constructor":{"command":"node"},"toString":{"command":"node"},"__proto__":{"command":"node"}}')); u.c.loadMcpServers();
    let created = 0; u.c.createMcpStdioClient = name => ({ name, dead: false, dispose() {} });
    const original = u.c.createMcpStdioClient; u.c.createMcpStdioClient = name => { created++; return original(name); };
    vm.runInContext(cut('const mcpClients =', '\n') + '\n' + cut('function getMcpClient(', 'function disposeMcpClients('), u.c);
    check('prototype-like configured names create and cache real client objects instead of inherited functions', ['constructor', 'toString', '__proto__'].every(name => u.c.getMcpClient(name).name === name && u.c.getMcpClient(name).name === name) && created === 3 && Object.getPrototypeOf(u.c.mcpServers) === null);
    write(path.join(u.install, 'permissions.json'), { allow: ['write_file(blocked.txt)'], deny: ['read_file(private.txt)'] }); write(u.pp, { deny: ['write_file(blocked.txt)'], protected_extra: ['*.key'] }); u.c.loadPermRules();
    check('permission merge keeps same rule in different buckets and protected patterns', u.rules().allow.length === 1 && u.rules().deny.length === 2 && u.rules().protectedExtra[0].argRe.test('my.key'));
    const beforeRules = u.rules().deny, beforeAllow = u.rules().allow;
    const invalidPerm = [null, [], 'text', { deny: 'all' }, { allow: {} }, { protected_extra: null }, { deny: [1] }, { deny: ['run_command()'] }, { protected_extra: [''] }, { allow: ['x'.repeat(4097)] }];
    for (const value of invalidPerm) { write(u.pp, value); assert.throws(() => u.c.loadPermRules()); assert.strictEqual(u.rules().deny, beforeRules); assert.strictEqual(u.rules().allow, beforeAllow); }
    check('all ten invalid permission shapes/rules refuse partial rule publication', invalidPerm.length === 10);
    write(path.join(u.install, 'permissions.json'), {}); write(u.pp, { deny: Array.from({ length: 1000 }, (_, i) => 'write_file(file-' + i + ')') }); u.c.loadPermRules();
    check('1000 distinct permission rules are admitted', u.rules().deny.length === 1000);
    write(path.join(u.install, 'permissions.json'), { allow: ['read_file(*)'] }); assert.throws(() => u.c.loadPermRules(), /1000 rules/);
    check('merged permission budget fails before replacing existing rules', u.rules().deny.length === 1000 && u.rules().allow.length === 0);
    let largeReads = 0; const open = new Map();
    u.c.fs.openSync = (file, flags, mode) => { const fd = fs.openSync(file, flags, mode); open.set(fd, file); return fd; };
    u.c.fs.closeSync = fd => { fs.closeSync(fd); open.delete(fd); };
    u.c.fs.readSync = (...args) => { if ([u.mp, u.pp].includes(open.get(args[0]))) largeReads++; return fs.readSync(...args); }; sparse(u.mp, limit + 1); sparse(u.pp, limit + 1);
    assert.throws(() => u.c.loadMcpServers(), e => e.code === 'EFILETOOLARGE');
    // Existing installation layers may be read before workspace refusal.
    assert.throws(() => u.c.loadPermRules(), e => e.code === 'EFILETOOLARGE');
    check('oversized manual config remains intact with no data collection for its file', largeReads === 0 && open.size === 0 && fs.statSync(u.mp).size === limit + 1 && fs.statSync(u.pp).size === limit + 1);
    const denied = unit(); write(denied.pp, { deny: ['write_file(*)'] }); denied.c.fs.openSync = (file, flags, mode) => { if (file === denied.pp) throw Object.assign(Error('injected config EACCES'), { code: 'EACCES' }); return fs.openSync(file, flags, mode); };
    assert.throws(() => denied.c.loadPermRules(), e => e.code === 'EACCES'); check('permission read failure cannot silently become empty rules', fs.readFileSync(denied.pp, 'utf8').includes('write_file(*)'));
    for (const [name, invalid] of [['permissions.json', 'json'], ['mcp.json', 'json'], ['permissions.json', 'large'], ['mcp.json', 'large']]) {
      current = S.freshCwd('startup-' + name + '-' + invalid); fs.mkdirSync(path.join(current, '.7coder')); const file = path.join(current, '.7coder', name);
      if (invalid === 'large') sparse(file, limit + 1); else fs.writeFileSync(file, '{"SECRET-PARSE-BAIT":'); const size = fs.statSync(file).size;
      const r = S.spawnSync(S.NODE_BIN, [S.IDX, '--server'], { cwd: current, encoding: 'utf8', timeout: 8000 });
      check('actual startup rejects ' + name + ' ' + invalid + ' before ready without secrets or mutation', r.status === 1 && r.stderr.includes('configuration load failed') && !r.stderr.includes('SECRET-PARSE-BAIT') && !r.stdout.includes('endpoint ready') && fs.statSync(file).size === size && fs.readdirSync(path.dirname(file)).length === 1);
    }
    } else { current = S.freshCwd('integration-only'); fs.mkdirSync(path.join(current, '.7coder')); }
    write(path.join(current, '.7coder', 'mcp.json'), {}); write(path.join(current, '.7coder', 'permissions.json'), { deny: ['write_file(blocked.txt)'], allow: ['write_file(scratch/**)'] });
    server = http.createServer((req, res) => { let raw = ''; req.setEncoding('utf8'); req.on('data', d => raw += d); req.on('end', () => {
      const body = JSON.parse(raw), message = body.messages.some(m => m.role === 'tool') ? { content: 'CONFIG_REPAIRED' } : { content: '', tool_calls: [ ['deny-write', 'blocked.txt'], ['allowed-write', 'scratch/allowed.txt'] ].map(([id, file], index) => ({ index, id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'fixture' }) } })) };
      res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n');
    }); }); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    H = require('./_endpoint').create({ suite: 'config-repaired-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: 'fixture', model: 'fixture', permissionMode: 'default' });
    write(path.join(path.dirname(H.S.IDX), 'permissions.json'), { allow: ['write_file(blocked.txt)'] }); await H.start(current); const reply = await H.chat([{ role: 'user', content: 'verify permissions' }], 8000);
    assert.ok(reply.content === 'CONFIG_REPAIRED' && reply.tools.some(t => t.type === 'result' && t.callId === 'deny-write' && t.status === 'blocked'), 'permission SSE evidence: ' + JSON.stringify(reply));
    check('valid repaired configuration starts and enforces workspace deny over install allow', reply.content === 'CONFIG_REPAIRED' && reply.tools.some(t => t.type === 'result' && t.callId === 'deny-write' && t.status === 'blocked') && !fs.existsSync(path.join(current, 'blocked.txt')));
    check('unrelated allow still executes without asking approval after valid atomic config load', reply.tools.some(t => t.type === 'result' && t.callId === 'allowed-write' && t.status === 'completed') && fs.readFileSync(path.join(current, 'scratch', 'allowed.txt'), 'utf8') === 'fixture');
    console.log('CONFIG/ADMISSION ' + checks + '/' + checks + ' passed; ' + (process.env.CONFIG_PHASE === 'integration' ? 'selected integration only; first 18 checks not run' : 'SKIP 0'));
  } finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } S.cleanup(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
