const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), zlib = require('zlib');
const { loadContext } = require('./download-commit'), S = require('./_shared').create({ suite: 'transport-ownership' });
const source = fs.readFileSync(S.IDX, 'utf8'), sockets = new Set(), responses = new Map(), controls = [], agent = new http.Agent({ keepAlive: true, maxSockets: 3 }); let server, checks = 0, socketId = 0;
const deadline = setTimeout(() => { console.error('TRANSPORT/OWNERSHIP deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(predicate, label) { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 5)); } }
const observed = p => p.then(value => ({ value }), error => ({ error }));
const frame = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n';
(async () => { try {
  const c = loadContext(source, S.freshCwd('unit'), {}, { Buffer }); const a = source.indexOf('function parseSSEStream('), b = source.indexOf('async function callOpenAI(', a); vm.runInContext(source.slice(a, b), c);
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/redirected' }); res.end(); return; }
    const item = { closed: false, socket: req.socket._fixtureSocketId, end: () => res.end(frame) }; responses.set(req.url, item); res.once('close', () => { item.closed = true; });
    if (req.url.startsWith('/complete')) { res.end(frame); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url === '/gzip') { const gzip = zlib.createGzip(); gzip.pipe(res); res.setHeader('Content-Encoding', 'gzip'); gzip.write(': waiting\n\n'); gzip.flush(zlib.constants.Z_SYNC_FLUSH); res.once('close', () => gzip.destroy()); return; }
    if (req.url === '/oversized') {
      let count = 0; const next = () => { if (item.closed || res.destroyed) return; if (++count > 140) { res.end(); return; } if (res.write('x'.repeat(65536))) setImmediate(next); else res.once('drain', next); }; next(); return;
    }
    res.write(': waiting\n\n');
  });
  server.on('connection', socket => { socket._fixtureSocketId = ++socketId; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const token = () => { const t = c.createExecutionControl(6000); controls.push(t); return t; };
  const spec = route => ({ method: 'get', url: endpoint + route, responseType: 'stream', maxContentLength: 8 * 1024 * 1024, httpAgent: agent });
  for (const route of ['/held', '/redirect', '/gzip']) {
    let entered = false; const t = token(), key = route === '/redirect' ? '/redirected' : route;
    const result = observed(c.executionHttp(spec(route), t, response => { entered = true; return c.parseSSEStream(response.data, () => {}, null); }));
    await until(() => entered, 'headers ' + route); await new Promise(r => setImmediate(r)); t.cancel('fixture cancellation');
    const outcome = await result; await until(() => responses.get(key).closed, 'native close ' + route); t.dispose();
    check('cancel after headers closes owned raw response and wrapper ' + route, outcome.error && outcome.error.code === 'EXECUTION_CANCELLED');
  }
  const t = token(); const rejected = await observed(c.executionHttp(spec('/consumer-failed'), t, async () => { await new Promise(r => setImmediate(r)); throw Error('consumer rejected'); }));
  await until(() => responses.get('/consumer-failed').closed, 'consumer native close'); t.dispose(); check('consumer failure closes raw request even without explicit cancellation', rejected.error && rejected.error.message === 'consumer rejected');
  const large = token(), exceeded = await observed(c.executionHttp(spec('/oversized'), large, response => c.parseSSEStream(response.data, () => {}, null)));
  await until(() => responses.get('/oversized').closed, 'budget native close'); large.dispose(); check('stream byte-limit failure stops the source connection and producer', exceeded.error && /maxContentLength|8MiB budget/.test(exceeded.error.message));
  let oneReady = false, twoReady = false; const one = token(), two = token();
  const first = observed(c.executionHttp(spec('/concurrent-one'), one, r => { oneReady = true; return c.parseSSEStream(r.data, () => {}, null); }));
  const second = observed(c.executionHttp(spec('/concurrent-two'), two, r => { twoReady = true; return c.parseSSEStream(r.data, () => {}, null); }));
  await until(() => oneReady && twoReady, 'concurrent headers'); one.cancel('cancel just one'); await first; await until(() => responses.get('/concurrent-one').closed, 'first close');
  const otherOpen = !responses.get('/concurrent-two').closed; responses.get('/concurrent-two').end(); const finished = await second; one.dispose(); two.dispose();
  check('cleanup is per response and leaves another active connection usable', otherOpen && finished.value.message.content === 'OK');
  for (const route of ['/complete-one', '/complete-two']) { const t = token(), r = await c.executionHttp(spec(route), t, response => c.parseSSEStream(response.data, () => {}, null)); assert.strictEqual(r.message.content, 'OK'); t.dispose(); }
  check('successful completed requests keep normal connection reuse', responses.get('/complete-one').socket === responses.get('/complete-two').socket);
  check('all completed/cancelled operations dispose their controls', c.createExecutionControl.active.size === 0);
  console.log('TRANSPORT/OWNERSHIP ' + checks + '/' + checks + ' passed; SKIP 0');
} finally { clearTimeout(deadline); for (const t of controls) t.dispose(); agent.destroy(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
