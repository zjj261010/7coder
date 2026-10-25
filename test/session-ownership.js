// Retention acts only on explicitly CLI-owned archives; all IO is private.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'session-ownership' }), source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0, agent;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(cwd, overrides, extra) {
  const warnings = [];
  const c = loadContext(source, cwd, overrides, Object.assign({ Buffer, require, appDir: path.dirname(S.IDX), messages: [], console: { warn: s => warnings.push(s) } }, extra));
  vm.runInContext(cut('function sessionFilePath()', 'async function summarizeAction('), c); c.warnings = warnings; return c;
}
const cliKind = '7coder-cli-session-v1', webKind = '7coder-web-session-v1';
function body(kind, savedAt, content) { return JSON.stringify({ kind, savedAt, messages: [{ role: 'user', content }] }); }
function seedCli(cwd, count) {
  const dir = path.join(cwd, '.7coder', 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const names = [];
  for (let i = 0; i < count; i++) { const date = new Date(1700000000000 + i * 1000).toISOString(), name = 'cli-' + date.replace(/[:.]/g, '-') + '-' + i.toString(16).padStart(8, '0') + '.json'; fs.writeFileSync(path.join(dir, name), body(cliKind, date, 'CLI' + i)); names.push(name); }
  return { dir, names };
}
async function until(test, label) { const end = Date.now() + 6000; while (!await test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 5)); } }
(async () => {
  try {
    const cwd = S.freshCwd('mixed 中文'), dir = path.join(cwd, '.7coder', 'sessions'); fs.mkdirSync(dir, { recursive: true });
    const preserved = new Map();
    for (let i = 0; i < 27; i++) { const name = 'web-' + String(i).padStart(3, '0') + '.json', bytes = body(webKind, '2000-01-01T00:00:00.000Z', 'WEB' + i); fs.writeFileSync(path.join(dir, name), bytes); preserved.set(name, bytes); }
    for (const [name, bytes] of [['2001-01-01T00-00-00-000Z.json', body(undefined, '2001-01-01T00:00:00.000Z', 'legacy')],
      ['cli-2020-01-01T00-00-00-000Z-deadbeef.json', body(webKind, '2020-01-01T00:00:00.000Z', 'foreign CLI-looking name')],
      ['cli-2020-01-01T00-00-00-000Z-feedface.json', '{broken'], ['evidence.json.7coder-corrupt-owner', 'raw evidence'], ['active.json.7coder-tmp-owner', 'active temp']]) { fs.writeFileSync(path.join(dir, name), bytes); preserved.set(name, bytes); }
    const archiveWrites = [];
    class FrozenDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-24T00:00:00.000Z'])); } static now() { return Date.parse('2026-10-24T00:00:00.000Z'); } }
    const c = context(cwd, { renameSync(from, to) { if (path.dirname(to) === dir && /^cli-.*\.json$/.test(path.basename(to))) archiveWrites.push(path.basename(to)); fs.renameSync(from, to); } }, { Date: FrozenDate });
    for (let i = 0; i < 25; i++) { c.messages = [{ role: 'system', content: 'fixture' }, { role: 'user', content: 'SAVE' + i }]; c.saveSession(); }
    const cli = fs.readdirSync(dir).filter(name => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).kind === cliKind; } catch (e) { return false; } });
    check('CLI keeps at most twenty explicitly owned archives in mixed history', cli.length === 20);
    check('frozen same-millisecond saves get unique archive names', archiveWrites.length === 25 && new Set(archiveWrites).size === 25);
    check('latest primary and current archive survive retention at tied timestamps', JSON.parse(fs.readFileSync(c.sessionFilePath(), 'utf8')).messages[1].content === 'SAVE24' && fs.existsSync(path.join(dir, archiveWrites[24])));
    check('Web legacy foreign corrupt evidence and active temp bytes remain untouched', Array.from(preserved).every(([name, bytes]) => fs.readFileSync(path.join(dir, name), 'utf8') === bytes));
    check('pruning does not quarantine or repair a corrupt candidate', !fs.readdirSync(dir).some(name => name.includes('feedface.json.7coder-corrupt')));

    const changedCwd = S.freshCwd('changed'), changed = seedCli(changedCwd, 21), oldest = path.join(changed.dir, changed.names[0]); let reads = 0;
    const changedContext = context(changedCwd, { openSync(file, flags, mode) { if (file === oldest && flags === 'r' && ++reads === 2) fs.writeFileSync(file, body(webKind, '2024-01-01T00:00:00.000Z', 'changed while pruning')); return fs.openSync(file, flags, mode); } });
    changedContext.pruneCliSessionHistory(changed.names[20]);
    check('changed candidate stops cleanup without deleting it or another archive', fs.existsSync(oldest) && fs.readdirSync(changed.dir).length === 21 && JSON.parse(fs.readFileSync(oldest, 'utf8')).kind === webKind);
    const deniedCwd = S.freshCwd('delete-denied'), denied = seedCli(deniedCwd, 21), deniedFile = path.join(denied.dir, denied.names[0]);
    const deniedContext = context(deniedCwd, { unlinkSync(file) { if (file === deniedFile) throw Object.assign(Error('fixture lock'), { code: 'EACCES' }); fs.unlinkSync(file); } });
    assert.throws(() => deniedContext.pruneCliSessionHistory(denied.names[20]), /fixture lock/);
    check('delete denial preserves all primaries rather than continuing destructive cleanup', fs.readdirSync(denied.dir).filter(name => name.endsWith('.json')).length === 21);

    const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r));
    agent = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, { HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '',
      OPENAI_ENDPOINT: 'http://127.0.0.1:1/v1', OPENAI_API_KEY: '', DREAM_ALLOW: 'false' }) });
    let output = ''; agent.stdout.on('data', d => output += d); agent.stderr.on('data', d => output += d);
    const api = (url, data) => S.httpReq(port, data === undefined ? 'GET' : 'POST', url, data === undefined ? null : data);
    await until(async () => { if (agent.exitCode != null) throw Error(output); try { return (await api('/api/info')).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'Agent ready');
    const listing = JSON.parse((await api('/api/sessions')).body).sessions;
    check('listing uses savedAt across CLI/Web names rather than prefix order', listing[0].file.startsWith('cli-2026') && listing.findIndex(x => x.file === 'web-000.json') > listing.findIndex(x => x.file === archiveWrites[24]));
    const original = path.join(dir, archiveWrites[24]), originalBytes = fs.readFileSync(original);
    let response = await api('/api/sessions/save', { file: archiveWrites[24], messages: [{ role: 'user', content: 'continued in Web' }] });
    const webName = JSON.parse(response.body).file;
    check('Web continuation clones CLI archive into an explicitly Web-owned record', response.status === 200 && webName !== archiveWrites[24] && webName.startsWith('web-') && fs.readFileSync(original).equals(originalBytes) && JSON.parse(fs.readFileSync(path.join(dir, webName), 'utf8')).kind === webKind);
    response = await api('/api/sessions/save', { file: webName, messages: [{ role: 'user', content: 'second Web update' }] });
    check('later Web saves reuse their own acknowledged file', JSON.parse(response.body).file === webName && JSON.parse(fs.readFileSync(path.join(dir, webName), 'utf8')).messages[0].content === 'second Web update');
    const closed = agent; agent.kill(); await new Promise(r => closed.once('close', r));
    const webBytes = fs.readFileSync(path.join(dir, webName)); c.messages = [{ role: 'system', content: 'fixture' }, { role: 'user', content: 'after Web exit' }]; c.saveSession();
    check('next CLI save after Web exit still leaves the Web record byte-exact', fs.readFileSync(path.join(dir, webName)).equals(webBytes));
    console.log('SESSION/OWNERSHIP ' + checks + '/' + checks + '; private files and observed direct Agent close only');
  } finally { S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
