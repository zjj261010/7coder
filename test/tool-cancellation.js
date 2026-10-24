// T22-06 second slice: real local HTTP/streams/files and original tool code.
// MCP/shell cancellation is covered alongside real children in pipe-lifecycle.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const axios = require('axios');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'tool-cancellation' });
const source = fs.readFileSync(S.IDX, 'utf8');
const sockets = new Set(), received = [], controls = [];
let checks = 0, server, base;
const deadline = setTimeout(() => { console.error('TOOL/CANCELLATION suite deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundary: ' + from);
  return source.slice(start, end);
}
async function until(predicate, label) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function control(ctx, ms = 5000) { const token = ctx.createExecutionControl(ms); controls.push(token); return token; }
function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).reduce((all, name) => {
    const file = path.join(dir, name);
    return all.concat(fs.statSync(file).isDirectory() ? files(file) : [file]);
  }, []);
}
const old = Buffer.from([0, 255, 128, 13, 10, 67]), fresh = Buffer.from('download replacement');
const same = (file, bytes) => fs.existsSync(file) && fs.readFileSync(file).equals(bytes);
function downloadFixture(name, overrides, extra) {
  const cwd = S.freshCwd(name), dest = path.join(cwd, 'target.bin'); fs.writeFileSync(dest, old);
  const ctx = loadContext(source, cwd, overrides || {}, extra);
  return { cwd, dest, ctx };
}
function retained(f) {
  return same(f.dest, old) && !files(f.cwd).some(file => file.includes('.part-') || file.endsWith('.bak.tmp')) &&
    files(f.cwd).filter(file => file.endsWith('.bak')).every(file => same(file, old));
}
function networkContext(name) {
  const configs = [], audits = [];
  // Preserve real CancelToken and real HTTP IO. Rewrite destinations to this
  // fixture so Brave/Bing/DDG/vision/MCP tests cannot contact the internet.
  const localAxios = config => { configs.push(config); return axios(Object.assign({}, config, { url: base + '/json' })); };
  localAxios.CancelToken = axios.CancelToken;
  const ctx = loadContext(source, S.freshCwd(name), {}, {
    axios: localAxios, Buffer, SEARCH_PROVIDER: '', SEARCH_ENDPOINT: base, SEARCH_API_KEY: '',
    VISION_MODEL: 'fixture', resolveModelConfig: () => ({ endpoint: base, apiKey: '' }), authHeadersFor: () => ({}),
    MCP_SERVER_URLS: [], MCP_NPX_PKGS: [], mcpServers: {}, DANGER_MODE: false,
    effectivePermissionMode: () => 'bypass', isProtectedTarget: () => false, matchPermRule: () => null,
    getToolMetadata: () => ({ autoSafe: true, trackChanges: false }), taskChanges: [],
    audit: value => audits.push(value), sanitizeAuditLine: String
  });
  vm.runInContext(cut('// OPT-13: pilot tools carry authoritative status', '// Central choke point') +
    cut('async function describeWithVision(', '// GAP-4: read a screenshot') +
    'async function executeToolRaw(name,args,conversation,approvalBridge,cancelled,modelContext) { checkExecution(cancelled);\n' +
    cut("  if (name === 'web_fetch_tool') {", "  if (name === 'notebook_edit_tool') {") +
    cut("  if (name === 'mcp_tool') {", "  if (name === 'snip_tool') {") + '\n}\n' +
    cut('async function safeExecuteTool(', '// ====================== APPROVAL'), ctx);
  ctx.invoke = (name, args, token) => ctx.safeExecuteTool({ function: { name, arguments: JSON.stringify(args || {}) } }, [], null, token);
  return { ctx, configs, audits };
}
(async () => {
  try {
    server = http.createServer((req, res) => {
      const entry = { url: req.url, closed: false }; received.push(entry);
      res.on('close', () => { entry.closed = true; }); req.resume();
      if (req.url === '/headers') return;
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"partial":'); return;
      }
      if (req.url === '/partial') {
        res.writeHead(200); res.write(fresh); return;
      }
      res.end(fresh);
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;

    const pre = downloadFixture('pre-cancel'), preToken = control(pre.ctx), before = received.length;
    preToken.cancel('before download');
    const preResult = await pre.ctx.download({ path: 'target.bin', url: base + '/blob' }, preToken);
    check('pre-cancelled download performs no request and preserves target', preResult.status === 'cancelled' && received.length === before && retained(pre));

    for (const route of ['/headers', '/partial']) {
      const f = downloadFixture('cancel-' + route.slice(1)), token = control(f.ctx), begin = received.length;
      const waiting = f.ctx.download({ path: 'target.bin', url: base + route }, token);
      await until(() => received.length > begin && (route === '/headers' || files(f.cwd).some(file => file.includes('.part-') && fs.statSync(file).size > 0)), route + ' started');
      token.cancel('cancel transfer');
      const result = await waiting;
      await until(() => received[begin].closed, route + ' socket close');
      check(route + ': cancellation closes transport, removes owned temp and retains original bytes', result.status === 'cancelled' && retained(f));
      fs.renameSync(f.dest, f.dest + '.moved'); fs.renameSync(f.dest + '.moved', f.dest);
      check(route + ': original file remains reusable after cleanup', same(f.dest, old));
    }

    let closeToken;
    const atClose = downloadFixture('cancel-at-close', { createWriteStream(file, opts) {
      const writer = fs.createWriteStream(file, opts); writer.once('close', () => closeToken.cancel('cancel at file close')); return writer;
    } });
    closeToken = control(atClose.ctx);
    const closed = await atClose.ctx.download({ path: 'target.bin', url: base + '/blob' }, closeToken);
    check('cancellation at writer close prevents backup and destination replacement', closed.status === 'cancelled' && retained(atClose) && !files(atClose.cwd).some(file => file.endsWith('.bak')));

    let backupToken;
    const atBackup = downloadFixture('cancel-after-backup', { renameSync(from, to) {
      fs.renameSync(from, to); if (to.endsWith('.bak')) backupToken.cancel('cancel after complete backup');
    } });
    backupToken = control(atBackup.ctx);
    const backed = await atBackup.ctx.download({ path: 'target.bin', url: base + '/blob' }, backupToken);
    check('cancellation after publishing backup prevents commit and keeps complete recovery bytes',
      backed.status === 'cancelled' && retained(atBackup) && files(atBackup.cwd).some(file => file.endsWith('.bak')));

    let clock = Date.now();
    const overrun = downloadFixture('deadline-in-sync-backup', { renameSync(from, to) {
      fs.renameSync(from, to); if (to.endsWith('.bak')) clock += 6000;
    } }, { Date: class extends Date { static now() { return clock; } } });
    const overrunToken = control(overrun.ctx);
    const expired = await overrun.ctx.download({ path: 'target.bin', url: base + '/blob' }, overrunToken);
    check('elapsed deadline is checked after synchronous backup even before timer callback runs',
      expired.status === 'cancelled' && overrunToken.reason === 'Execution deadline exceeded.' && retained(overrun));

    const cases = [
      ['fetch', 'web_fetch_tool', { url: base }, ''],
      ['searxng', 'web_search_tool', { query: 'fixture' }, 'searxng'],
      ['brave', 'web_search_tool', { query: 'fixture' }, 'brave'],
      ['bing', 'web_search_tool', { query: 'fixture' }, 'bing'],
      ['ddg', 'web_search_tool', { query: 'fixture' }, 'ddg'],
      ['browser', 'web_browser_tool', { url: base, action: 'navigate' }, ''],
      ['vision', 'web_browser_tool', { url: base + '/fixture.png' }, ''],
      ['mcp-http', 'mcp_tool', { mcp_url: base, tool_name: 'fixture' }, '']
    ];
    for (const [label, name, args, provider] of cases) {
      const f = networkContext(label), token = control(f.ctx), begin = received.length;
      f.ctx.SEARCH_PROVIDER = provider;
      const waiting = f.ctx.invoke(name, args, token);
      await until(() => received.length > begin, label + ' JSON body stalled'); token.cancel('cancel network tool');
      const result = await waiting;
      await until(() => received[begin].closed, label + ' socket closed');
      check(label + ': partial JSON body cancellation closes HTTP and records cancelled status',
        result.status === 'cancelled' && f.audits.length === 1 && f.audits[0].status === 'cancelled' && f.configs.length === 1);
    }
    const beforeNetwork = networkContext('before-network'), stopped = control(beforeNetwork.ctx); stopped.cancel('pre-cancelled');
    for (const [, name, args] of cases) assert.strictEqual((await beforeNetwork.ctx.invoke(name, args, stopped)).status, 'cancelled');
    check('already-cancelled network tools never start an HTTP request', beforeNetwork.configs.length === 0);

    const sleeper = networkContext('cancel-sleep'), sleepToken = control(sleeper.ctx, 80);
    const slept = await sleeper.ctx.invoke('sleep_tool', { ms: 60000 }, sleepToken);
    check('sleep wait observes shared deadline and is recorded as cancelled', slept.status === 'cancelled' && sleeper.audits[0].status === 'cancelled');

    const discovery = networkContext('cancel-discovery'), discoveryToken = control(discovery.ctx), starts = [];
    discovery.ctx.mcpServers = { first: {}, second: {} };
    discovery.ctx.getMcpClient = (name, token) => { starts.push(name); return { listTools: async () => { token.cancel('stop after first server'); return []; } }; };
    const discovered = await discovery.ctx.invoke('mcp_list_tools_tool', {}, discoveryToken);
    check('cancelled discovery never starts the next MCP server', discovered.status === 'cancelled' && starts.join(',') === 'first');

    const legacy = networkContext('legacy-status'), legacyToken = control(legacy.ctx);
    legacy.ctx.safeExecuteToolInner = async () => { legacyToken.cancel('cancelled during tool'); return '[OK] legacy tool completed'; };
    const legacyResult = await legacy.ctx.invoke('web_fetch_tool', {}, legacyToken);
    check('late legacy success cannot overwrite cancelled audit status', legacyResult.status === 'cancelled' && legacy.audits[0].status === 'cancelled' && legacyResult.text.includes('check completed side effects'));
    console.log('TOOL/CANCELLATION: ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline);
    for (const token of controls) token.dispose();
    S.cleanup();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
