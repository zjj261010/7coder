// Original pager + private HTTP Agent + controlled UI; no real model/browser.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit'), { harness, settle } = require('./webui-ui-sim');
const S = require('./_shared').create({ suite: 'session-pagination' }), source = fs.readFileSync(S.IDX, 'utf8');
const pagers = []; let checks = 0, agent, agentClosed = false;
const deadline = setTimeout(() => { console.error('SESSION/PAGINATION deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function seed(name, count) {
  const cwd = S.freshCwd(name), dir = path.join(cwd, '.7coder', 'sessions'), files = [];
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const file = 'web-' + String(i).padStart(3, '0') + '.json'; files.push(file);
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ savedAt: new Date(1700000000000 + i * 1000).toISOString(), messages: [{ role: 'user', content: (i % 10 === 0 ? 'needle ' : 'text ') + i }] }));
  }
  return { cwd, dir, files };
}
function pager(f, options, overrides, extra) {
  const io = { bytes: 0, open: 0, closed: 0 };
  const ctx = loadContext(source, f.cwd, Object.assign({
    readdirSync() { throw Error('whole directory collection forbidden'); }, readFileSync() { throw Error('whole file read forbidden'); },
    readSync(fd, b, off, len, pos) { const n = fs.readSync(fd, b, off, len, pos); io.bytes += n; return n; },
    opendirSync(dir) { const h = fs.opendirSync(dir); io.open++; return { readSync: () => h.readSync(), closeSync() { h.closeSync(); io.closed++; } }; }
  }, overrides), Object.assign({ Buffer, require, appDir: path.dirname(S.IDX), console: { warn() {} } }, extra));
  const a = source.indexOf('function sessionFilePath()'), b = source.indexOf('async function summarizeAction(', a);
  vm.runInContext(source.slice(a, b), ctx);
  const p = ctx.createSessionHistoryPager(options); pagers.push(p); return { p, io, ctx };
}
function ready(p, request) {
  let page = p.page(request), steps = 0;
  while (page.status === 'indexing') { assert(page.sessions.length === 0 && ++steps < 1000); page = p.page({ cursor: page.cursor }); }
  return page;
}
async function until(test, label) { const end = Date.now() + 10000; while (!await test()) { if (Date.now() > end) throw Error(label); await new Promise(r => setTimeout(r, 10)); } }
const response = (body, status = 200) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });
function closeFailureChecks() {
  const fixture = seed('native-close-errors', 3);
  const failed = pager(fixture, {}, { opendirSync(dir) {
    const handle = fs.opendirSync(dir);
    return { readSync: () => handle.readSync(), closeSync() { handle.closeSync(); throw Object.assign(Error('native close result unknown'), { code: 'EIO' }); } };
  } });
  for (let i = 0; i < 4; i++) ready(failed.p);
  assert.throws(() => failed.p.page(), e => e.httpStatus === 429 && /unconfirmed/.test(e.message));
  check('unconfirmed native closes remain counted and cap later scan admission', failed.p.stats().openDirectories === 0 && failed.p.stats().unconfirmedCloses === 4);
  const alreadyClosed = pager(seed('already-closed', 1), {}, { opendirSync(dir) {
    const handle = fs.opendirSync(dir);
    return { readSync: () => handle.readSync(), closeSync() { handle.closeSync(); throw Object.assign(Error('already closed'), { code: 'ERR_DIR_CLOSED' }); } };
  } });
  ready(alreadyClosed.p);
  check('a confirmed already-closed directory does not consume unknown-close capacity', alreadyClosed.p.stats().unconfirmedCloses === 0);
  const disposing = pager(seed('dispose-close-error', 3), { maxEntries: 1 }, { opendirSync(dir) {
    const handle = fs.opendirSync(dir);
    return { readSync: () => handle.readSync(), closeSync() { handle.closeSync(); throw Object.assign(Error('close failed during dispose'), { code: 'EIO' }); } };
  } });
  disposing.p.page(); disposing.p.dispose();
  check('disposal releases jobs but retains uncertain close diagnostics', disposing.p.stats().cursors === 0 && disposing.p.stats().openDirectories === 0 && disposing.p.stats().unconfirmedCloses === 1);
}
function linkedPreviewCheck() {
  const fixture = seed('linked-preview', 1), original = path.join(fixture.dir, fixture.files[0]);
  fs.linkSync(original, path.join(fixture.cwd, 'alias'));
  const linked = pager(fixture), page = ready(linked.p);
  check('shared legacy files remain visible as uncertain previews instead of disappearing', page.sessions.length === 1 && page.sessions[0].file === fixture.files[0] && page.uncertain === 1 && page.sessions[0].unreadable && linked.io.bytes === 0 && fs.statSync(original).nlink === 2);
}
(async () => {
  try {
    if (process.env.SESSION_PAGINATION_SCOPE === 'close-only') { closeFailureChecks(); console.log('SESSION/PAGINATION-CLOSE ' + checks + '/' + checks); return; }
    if (process.env.SESSION_PAGINATION_SCOPE === 'link-only') { linkedPreviewCheck(); console.log('SESSION/PAGINATION-LINK ' + checks + '/' + checks); return; }
    const f = seed('all-pages', 23), { p, io } = pager(f, { pageSize: 3, maxEntries: 2 });
    const firstChunk = p.page();
    check('partial scans return no falsely sorted page and bound actual entry collection', firstChunk.status === 'indexing' && firstChunk.sessions.length === 0 && firstChunk.requestVisited === 2 && p.stats().openDirectories === 1);
    let page = ready(p, { cursor: firstChunk.cursor }), first = page, second;
    check('complete scan selects globally newest records rather than the first filesystem batch', page.sessions.map(s => s.file).join(',') === 'web-022.json,web-021.json,web-020.json' && io.open === io.closed && page.order === 'savedAt-desc');
    const beforeReplay = io.bytes;
    check('replaying a completed cursor is stable without another directory/data read', p.page({ cursor: page.cursor }) === page && io.bytes === beforeReplay && io.open === io.closed);
    const seen = [];
    do { seen.push(...page.sessions.map(s => s.file)); if (!page.nextCursor) break; page = ready(p, { cursor: page.nextCursor }); if (!second) second = page; } while (seen.length < 30);
    check('all older records remain reachable across pages without gaps or duplicate rows', seen.length === 23 && new Set(seen).size === 23 && seen.join(',') === f.files.slice().reverse().join(',') && !page.nextCursor);
    const previous = ready(p, { cursor: second.previousCursor });
    check('reverse pagination returns the closest newer page in the same global order', previous.sessions.map(s => s.file).join(',') === first.sessions.map(s => s.file).join(','));
    const search = ready(p, { query: 'NeEdLe' });
    check('search covers records beyond the first page and is case-insensitive', search.matched === 3 && search.sessions.map(s => s.file).join(',') === 'web-020.json,web-010.json,web-000.json');
    check('metadata and completed-page caches remain within explicit limits', p.stats().metadataRows <= 512 && p.stats().cachedPages <= 8 && p.stats().cursors <= 16 && p.stats().openDirectories === 0);

    const bytesFixture = seed('byte-bound', 5), bytesPager = pager(bytesFixture, { pageSize: 2, maxReadBytes: 200 });
    let bounded = bytesPager.p.page();
    check('aggregate per-request bytes stop preview collection without losing the pending entry', bounded.status === 'indexing' && bounded.requestReadBytes > 0 && bounded.requestReadBytes <= 200);
    const boundedPage = ready(bytesPager.p, { cursor: bounded.cursor });
    check('continuing a byte-limited scan still finds the actual newest records', boundedPage.sessions[0].file === 'web-004.json' && boundedPage.sessions[1].file === 'web-003.json' && bytesPager.io.open === bytesPager.io.closed);

    const bad = seed('bad-preview', 0); fs.writeFileSync(path.join(bad.dir, 'broken.json'), '{broken');
    const badPager = pager(bad), badPage = ready(badPager.p);
    check('listing is read-only and reports unreadable metadata without quarantining or repairing it', badPage.uncertain === 1 && badPage.sessions[0].unreadable && fs.readdirSync(bad.dir).join(',') === 'broken.json' && fs.readFileSync(path.join(bad.dir, 'broken.json'), 'utf8') === '{broken');
    const huge = seed('huge-preview', 0), hugeFile = path.join(huge.dir, 'huge.json'), fd = fs.openSync(hugeFile, 'w'); fs.ftruncateSync(fd, 10 * 1024 * 1024); fs.closeSync(fd);
    const hugePager = pager(huge), hugePage = ready(hugePager.p);
    check('oversized previews are rejected before payload collection and do not block paging', hugePage.uncertain === 1 && hugePager.io.bytes === 0 && hugePager.io.open === hugePager.io.closed && fs.statSync(hugeFile).size === 10 * 1024 * 1024);

    let clock = Date.now(); const expiry = pager(seed('expiry', 4), { maxEntries: 1, ttlMs: 10 }, {}, { Date: class extends Date { static now() { return clock; } } });
    const pending = expiry.p.page(); clock += 11;
    assert.throws(() => expiry.p.page({ cursor: pending.cursor }), e => e.httpStatus === 410);
    check('expired scans close their directory handles and fail explicitly', expiry.p.stats().openDirectories === 0 && expiry.io.open === expiry.io.closed);
    const capacity = pager(seed('capacity', 6), { maxEntries: 1 });
    for (let i = 0; i < 4; i++) assert.strictEqual(capacity.p.page().status, 'indexing');
    assert.throws(() => capacity.p.page(), e => e.httpStatus === 429);
    check('concurrent scan admission caps live directory handles', capacity.p.stats().openDirectories === 4 && capacity.p.stats().cursors === 4);
    capacity.p.dispose();
    assert.throws(() => capacity.p.page(), e => e.httpStatus === 503);
    check('disposal closes active scans and releases cursors/cache/timer ownership', capacity.p.stats().openDirectories === 0 && capacity.p.stats().cursors === 0 && capacity.io.open === capacity.io.closed);

    if (process.platform === 'win32') {
      const swapped = seed('root-junction', 5), outside = S.freshCwd('index-outside'), moved = path.join(outside, 'moved'), indexed = pager(swapped, { maxEntries: 1 });
      const active = indexed.p.page(); fs.renameSync(swapped.dir, moved); fs.symlinkSync(moved, swapped.dir, 'junction');
      try {
        assert.throws(() => indexed.p.page({ cursor: active.cursor }), /outside|changed/);
        check('a moved/junction history root aborts scanning without touching external owned files', indexed.p.stats().openDirectories === 0 && indexed.io.open === indexed.io.closed && fs.readdirSync(moved).length === 5);
      } finally { fs.rmdirSync(swapped.dir); }
    }

    // Actual authenticated HTTP routing, large bodies and cursor invalidation.
    const actual = seed('http', 73);
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(actual.dir, 'large-' + i + '.json'), JSON.stringify({ savedAt: new Date(1900000000000 + i * 1000).toISOString(), messages: [{ role: 'user', content: 'LARGE-' + i + ' ' + 'x'.repeat(1500000) }] }));
    const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
    agent = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd: actual.cwd, env: Object.assign({}, process.env, { HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: 'history-fixture', DREAM_ALLOW: 'false', OPENAI_API_KEY: '', OPENAI_ENDPOINT: 'http://127.0.0.1:1/v1' }) });
    agent.once('close', () => { agentClosed = true; });
    let output = ''; agent.stdout.on('data', d => output += d); agent.stderr.on('data', d => output += d);
    const api = (url, body = null, auth = true) => S.httpReq(port, body === null ? 'GET' : 'POST', url, body, auth ? { Authorization: 'Bearer history-fixture' } : {});
    await until(async () => { if (agent.exitCode != null) throw Error(output); try { return (await api('/api/info')).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'HTTP history Agent ready');
    check('query-bearing history routes retain the common authentication gate', (await api('/api/sessions?cursor=' + 'a'.repeat(32), null, false)).status === 401);
    let raw = await api('/api/sessions'), listing = JSON.parse(raw.body);
    check('actual large history returns bounded indexing progress rather than an unbounded response', raw.status === 200 && listing.status === 'indexing' && listing.sessions.length === 0 && listing.requestReadBytes <= 8 * 1024 * 1024 && Buffer.byteLength(raw.body) < 32768);
    async function httpReady(cursor) {
      let result, rounds = 0;
      do { const r = await api(cursor ? '/api/sessions?cursor=' + cursor : '/api/sessions'); assert.strictEqual(r.status, 200, r.body); result = JSON.parse(r.body); cursor = result.cursor; assert(++rounds < 100); } while (result.status === 'indexing');
      return result;
    }
    listing = await httpReady(listing.cursor);
    check('actual HTTP first page globally sorts and limits the response to fifty rows', listing.sessions.length === 50 && listing.sessions[0].file === 'large-5.json' && listing.nextCursor && !listing.previousCursor);
    const older = await httpReady(listing.nextCursor);
    check('actual HTTP older page and previous cursor expose the complete history', older.sessions.length === 29 && older.sessions[28].file === 'web-000.json' && !older.nextCursor && older.previousCursor);
    let saved = await api('/api/sessions/save', { messages: [{ role: 'user', content: 'newly saved history' }] });
    const savedName = JSON.parse(saved.body).file;
    check('successful saves invalidate old cursors instead of mixing pagination generations', saved.status === 200 && (await api('/api/sessions?cursor=' + older.previousCursor)).status === 410);
    check('invalid or oversized history query inputs fail explicitly', (await api('/api/sessions?cursor=invalid')).status === 400 && (await api('/api/sessions?q=' + encodeURIComponent('中'.repeat(54)))).status === 400);
    const found = JSON.parse((await api('/api/sessions?q=newly')).body);
    check('search query reaches the backend index across the entire directory', found.status === 'ready' && found.sessions.length === 1 && found.sessions[0].file === savedName);
    await api('/api/sessions/delete', { file: savedName });
    check('deletion invalidates cached result cursors and normal diagnostics remain responsive', (await api('/api/sessions?cursor=' + found.cursor)).status === 410 && JSON.parse((await api('/api/info')).body).sessionHistory.openDirectories === 0);

    // UI tests keep paging separate from active conversation state.
    let ui = harness(); await settle();
    const one = '1'.repeat(32), two = '2'.repeat(32), three = '3'.repeat(32);
    ui.route('/api/sessions', () => ui.response({ status: 'ready', cursor: one, sessions: [{ file: 'new.json', preview: 'new' }], nextCursor: two }));
    await ui.hook.refreshSessions();
    let release;
    ui.route('/api/sessions?cursor=' + two, () => new Promise(r => { release = r; }));
    ui.ids.historyNext.fire('click'); ui.ids.historyNext.fire('click');
    check('UI admits only one next-page request and disables repeated paging', ui.calls.filter(c => c.url === '/api/sessions?cursor=' + two).length === 1 && ui.ids.historyNext.disabled);
    release(ui.response({ status: 'ready', cursor: two, sessions: [{ file: 'old.json', preview: 'old' }], previousCursor: three })); await settle();
    check('UI replaces the page rather than accumulating DOM nodes/history arrays', ui.ids.histList.children.length === 1 && ui.ids.histList.textContent.includes('old') && !ui.ids.historyPrevious.disabled && ui.hook.history().length === 0);
    ui.route('/api/sessions?cursor=' + three, () => ui.response({ status: 'ready', cursor: three, sessions: [{ file: 'new.json', preview: 'new again' }], nextCursor: two }));
    ui.ids.historyPrevious.fire('click'); await settle();
    check('UI previous-page navigation uses the server cursor', ui.ids.histList.textContent.includes('new again'));
    const refreshUrl = '/api/sessions?restart=' + three;
    let oldResolve; ui.route(refreshUrl, () => new Promise(r => { oldResolve = r; })); const stale = ui.hook.refreshSessions();
    ui.route(refreshUrl, () => ui.response({ status: 'ready', cursor: one, sessions: [{ file: 'latest.json', preview: 'LATEST' }] }));
    await ui.hook.refreshSessions(); oldResolve(ui.response({ status: 'ready', sessions: [{ file: 'stale.json', preview: 'STALE' }] })); await stale;
    check('late refresh results cannot overwrite the newer page', ui.ids.histList.textContent.includes('LATEST') && !ui.ids.histList.textContent.includes('STALE'));

    ui = harness(); await settle(); const progress = 'a'.repeat(32);
    ui.route('/api/sessions', () => ui.response({ status: 'indexing', sessions: [], cursor: progress, scanned: 1 }));
    ui.route('/api/sessions?cursor=' + progress, () => ui.response({ status: 'indexing', sessions: [], cursor: progress, scanned: 2 }));
    const before = ui.calls.length; await ui.hook.refreshSessions();
    check('UI automatic indexing is capped at sixteen requests with explicit manual continuation', ui.calls.length - before === 16 && !ui.ids.historyNext.disabled && ui.ids.historyNext.textContent === '继续检索' && ui.ids.historyStatus.textContent.includes('继续检索'));
    ui = harness(); await settle(); ui.route('/api/sessions', opts => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Error('aborted')))));
    const hanging = ui.hook.refreshSessions(), timeout = Array.from(ui.timers).find(t => t.ms === 15000); assert(timeout); timeout.fn(); await hanging;
    check('UI listing timeout releases controls/timer and reports a retryable failure', !ui.ids.historyRefresh.disabled && ui.ids.historyStatus.textContent.includes('超时') && !Array.from(ui.timers).some(t => t.ms === 15000));

    const loadedFiles = [];
    ui = harness({ storage: { '7coder-sess-file': 'outside-first-page.json' }, globals: { fetch(url, opts) {
      if (url === '/api/sessions/load') { loadedFiles.push(JSON.parse(opts.body).file); return Promise.resolve(response({ messages: [{ role: 'user', content: 'REMEMBERED' }] })); }
      if (url === '/api/sessions') return Promise.resolve(response({ status: 'ready', sessions: [{ file: 'other-newest.json' }] }));
      return Promise.resolve(response({ models: [], todos: [] }));
    } } }); await settle();
    check('automatic restore loads the remembered file directly even outside the first page', loadedFiles.join(',') === 'outside-first-page.json' && ui.hook.history()[0].content === 'REMEMBERED');
    const uncertainLoads = [];
    ui = harness({ globals: { fetch(url, opts) {
      if (url === '/api/sessions/load') uncertainLoads.push(opts.body);
      if (url === '/api/sessions') return Promise.resolve(response({ status: 'ready', uncertain: 1, sessions: [{ file: 'possibly-old.json' }] }));
      return Promise.resolve(response({ models: [], todos: [] }));
    } } }); await settle();
    check('unreadable preview uncertainty cannot silently restore a guessed newest session', uncertainLoads.length === 0 && ui.hook.history().length === 0 && ui.ids.historyStatus.textContent.includes('手动选择'));
    closeFailureChecks();
    linkedPreviewCheck();
    console.log('SESSION/PAGINATION ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline); for (const p of pagers) p.dispose();
    try {
      if (agent && !agentClosed) { const owned = agent; agent = null; await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('history Agent close unconfirmed')), 5000);
        owned.once('close', () => { clearTimeout(timer); resolve(); }); owned.kill();
      }); }
    } finally { S.cleanup(); }
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
