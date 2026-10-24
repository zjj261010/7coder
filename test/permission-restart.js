// A backend restart resets permission revisions while its page remains open.
const assert = require('assert'), http = require('http');
const { harness, settle } = require('./webui-ui-sim');
const S = require('./_shared').create({ suite: 'permission-restart' });
let checks = 0, current;
const deadline = setTimeout(() => { console.error('PERMISSION/RESTART deadline'); S.cleanup(); process.exit(1); }, 25000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(test, label) { const end = Date.now() + 6000; while (!await test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 10)); } }
(async () => {
  try {
    const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const p = server.address().port; await new Promise(r => server.close(r));
    const cwd = S.freshCwd('same workspace');
    const api = (url, body) => S.httpReq(p, body === undefined ? 'GET' : 'POST', url, body === undefined ? null : body);
    async function start(danger) {
      current = S.spawn(S.NODE_BIN, [S.IDX, '--server'].concat(danger ? ['--danger'] : []), { cwd, env: Object.assign({}, process.env, {
        HTTP_PORT: String(p), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', PERMISSION_MODE: 'default', DREAM_ALLOW: 'false', OPENAI_API_KEY: '', OPENAI_ENDPOINT: 'http://127.0.0.1:1/v1'
      }) });
      let output = ''; current.stdout.on('data', d => output += d); current.stderr.on('data', d => output += d);
      await until(async () => { if (current.exitCode != null) throw Error(output); try { return (await api('/api/info')).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'backend ready');
      return JSON.parse((await api('/api/info')).body);
    }
    const old = await start(true);
    check('real danger info reports effective bypass separately from configured default', old.mode === 'bypass' && old.configuredMode === 'default' && old.dangerMode && old.modeForced && !!old.permissionSession);
    const denied = JSON.parse((await api('/api/mode', { mode: 'denial' })).body);
    check('real denial overrides danger and advances permission revision', denied.mode === 'denial' && !denied.modeForced && denied.permissionRevision === 1 && denied.permissionSession === old.permissionSession);
    const forced = JSON.parse((await api('/api/mode', { mode: 'default' })).body);
    check('returning to default under danger truthfully reports bypass', forced.mode === 'bypass' && forced.configuredMode === 'default' && forced.modeForced && forced.permissionRevision === 2);
    const h = harness(); await settle(); h.route('/api/info', () => h.response(forced)); await h.hook.refreshInfo();
    let releaseOld; h.route('/api/info', () => new Promise(resolve => { releaseOld = resolve; })); const stale = h.hook.refreshInfo();
    const owned = current; current.kill(); await new Promise(r => owned.once('close', r));
    const next = await start(false);
    check('same-port same-workspace restart has a new identity and revision zero', next.permissionSession !== old.permissionSession && next.permissionRevision === 0 && next.mode === 'default');
    h.route('/api/info', () => h.response(next)); await h.hook.refreshInfo();
    check('open page accepts new process revision zero and removes danger restrictions', h.ids.modeSel.value === 'default' && !h.ids.modeChip.textContent.includes('--danger') && !h.ids.modeSel.querySelectorAll('option').find(o => o.value === 'default').disabled);
    releaseOld(h.response(forced)); await stale;
    check('late pre-restart response cannot restore old danger state', h.ids.modeSel.value === 'default' && !h.ids.modeChip.textContent.includes('--danger'));
    console.log('PERMISSION/RESTART ' + checks + '/' + checks);
  } finally { clearTimeout(deadline); S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
