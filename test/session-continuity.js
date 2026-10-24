// UI source in controlled DOM + real isolated HTTP persistence. No desktop IO.
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm');
const { harness, settle } = require('./webui-ui-sim'), { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'session-continuity' });
let checks = 0, app;
const deadline = setTimeout(() => { console.error('SESSION/CONTINUITY deadline'); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(test, label) { const end = Date.now() + 6000; while (!await test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 5)); } }
function sse(lines, opts, hold) {
  let index = 0;
  return { ok: true, body: { getReader() { return { read() {
    if (index < lines.length) return Promise.resolve({ done: false, value: Buffer.from('data: ' + lines[index++] + '\n\n') });
    if (!hold) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => { const error = Error('Stopped'); error.name = 'AbortError'; reject(error); }); });
  } }; } } };
}
const delta = data => JSON.stringify({ choices: [{ delta: data }] });
(async () => {
  try {
    let h = harness(); await settle();
    const pending = [];
    h.route('/api/sessions/save', opts => new Promise(resolve => pending.push({ opts, body: JSON.parse(opts.body), resolve })));
    h.hook.setHistory([{ role: 'user', content: 'first' }]); h.hook.autoSave();
    h.hook.history()[0].content = 'second'; h.hook.autoSave();
    h.hook.history()[0].content = 'latest'; h.hook.autoSave();
    check('slow save keeps one in flight and one latest snapshot', pending.length === 1 && h.hook.saveState().pending && pending[0].body.messages[0].content === 'first');
    pending[0].resolve(h.response({ file: 'web-owned.json' })); await settle();
    check('latest snapshot follows first save and reuses its acknowledged file', pending.length === 2 && pending[1].body.file === 'web-owned.json' && pending[1].body.messages[0].content === 'latest');
    pending[1].resolve(h.response({ file: 'web-owned.json' })); await settle();
    check('latest acknowledgment releases saving and dirty state', !h.hook.saveState().busy && !h.hook.saveState().dirty && h.ids.saveState.textContent === '已保存');

    h = harness(); await settle(); h.hook.setHistory([{ role: 'user', content: 'must retain' }]);
    h.route('/api/sessions/save', () => h.response({ error: { message: 'disk fault' } }, 500)); h.hook.autoSave(); await settle();
    let prevented = false; h.winHandlers.beforeunload({ preventDefault() { prevented = true; } });
    check('failed save remains dirty, offers retry and warns before refresh', h.hook.saveState().dirty && !h.ids.retrySave.hidden && prevented && h.hook.history()[0].content === 'must retain');
    h.route('/api/sessions/save', () => h.response({ file: 'web-retry.json' })); h.ids.retrySave.fire('click'); await settle();
    prevented = false; h.winHandlers.beforeunload({ preventDefault() { prevented = true; } });
    check('explicit retry saves latest state and removes unload warning', !h.hook.saveState().dirty && h.ids.retrySave.hidden && !prevented);
    h.hook.setHistory([{ role: 'user', content: '中'.repeat(750000) }]); const before = h.calls.length; h.hook.autoSave(); await settle();
    check('client capacity is UTF-8 bytes and never silently truncates', h.calls.length === before && h.hook.saveState().dirty && !h.ids.retrySave.hidden);

    h = harness({ confirm: false }); await settle(); h.hook.setHistory([{ role: 'user', content: 'keep unsaved' }]);
    h.route('/api/sessions/save', () => h.response({ error: { message: '413' } }, 413)); h.hook.autoSave(); await settle(); h.ids.btnNew.fire('click');
    check('declining unsaved-navigation warning preserves the current conversation', h.hook.history()[0].content === 'keep unsaved' && h.hook.saveState().dirty);
    h = harness(); await settle(); let rejectSave;
    h.route('/api/sessions/save', opts => new Promise((resolve, reject) => { rejectSave = reject; opts.signal.addEventListener('abort', () => reject(Error('save timeout'))); }));
    h.hook.setHistory([{ role: 'user', content: 'timeout snapshot' }]); h.hook.autoSave();
    const timer = Array.from(h.timers).find(t => t.ms === 15000); timer.fn(); await settle();
    check('save timeout releases the single slot without an automatic retry loop', !h.hook.saveState().busy && h.hook.saveState().dirty && h.calls.filter(c => c.url === '/api/sessions/save').length === 1 && !!rejectSave);

    const socket = http.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
    const cwd = S.freshCwd('server 中文');
    app = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, { HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '',
      OPENAI_ENDPOINT: 'http://127.0.0.1:1/v1', OPENAI_API_KEY: '', DREAM_ALLOW: 'false', PERMISSION_MODE: 'bypass' }) });
    let output = ''; app.stdout.on('data', d => output += d); app.stderr.on('data', d => output += d);
    const api = (method, url, body = null) => S.httpReq(port, method, url, body);
    await until(async () => { if (app.exitCode != null) throw Error(output); try { return (await api('GET', '/api/info')).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'real server ready');
    function connected() {
      const ui = harness();
      for (const route of ['/api/sessions/save', '/api/sessions/load']) ui.route(route, async opts => { const r = await api('POST', route, JSON.parse(opts.body)); return ui.response(JSON.parse(r.body), r.status); });
      return ui;
    }
    h = connected(); await settle();
    h.route('/v1/chat/completions', opts => sse([delta({ content: 'partial text' }), delta({ tool_result: { name: 'write_file', result: 'side effect completed', status: 'completed' } }), JSON.stringify({ error: { message: 'upstream failed' } })], opts));
    h.ids.ta.value = 'failed turn'; h.hook.send();
    await until(() => !h.hook.saveState().busy && !h.hook.saveState().dirty && h.hook.history()[1].status === 'failed', 'failed turn saved');
    let saved = JSON.parse((await api('POST', '/api/sessions/load', { file: h.hook.session() })).body);
    check('real disk save retains failed user turn partial text and failure metadata', saved.messages[0].content === 'failed turn' && saved.messages[1].content === 'partial text' && saved.messages[1].status === 'failed' && saved.messages[1].error === 'upstream failed');
    const firstId = saved.messages[1].turnId;
    check('completed side effects are durably tied to their original turn', saved.activities.length === 1 && saved.activities[0].turnId === firstId && saved.activities[0].result === 'side effect completed');
    h.route('/v1/chat/completions', opts => sse([delta({ tool_result: { name: 'read_file', result: 'next effect', status: 'completed' } }), delta({ content: 'next complete' }), '[DONE]'], opts));
    h.ids.ta.value = 'next turn'; h.hook.send();
    await until(() => !h.hook.saveState().busy && !h.hook.saveState().dirty && h.hook.history().length === 4 && h.hook.history()[3].status === 'ok', 'second turn saved');
    saved = JSON.parse((await api('POST', '/api/sessions/load', { file: h.hook.session() })).body);
    check('later successful turn cannot erase earlier turn activity', saved.activities.length === 2 && saved.activities[0].turnId === firstId && saved.activities[1].turnId === saved.messages[3].turnId && saved.messages[1].status === 'failed');
    const loaded = connected(); await settle(); loaded.hook.load(h.hook.session()); await settle();
    await until(() => loaded.hook.history().length === 4, 'manual load');
    check('manual load restores metadata and both activity groups', loaded.hook.activities().length === 2 && loaded.hook.history()[1].status === 'failed' && loaded.ids.log.textContent.includes('这轮生成失败'));
    loaded.route('/api/sessions', () => loaded.response({ sessions: [{ file: h.hook.session() }] }));
    loaded.ids.btnNew.fire('click'); loaded.hook.restore();
    await until(() => loaded.hook.history().length === 4, 'automatic restore');
    check('automatic restore retains the same activity and terminal-status data', loaded.hook.activities().length === 2 && loaded.hook.history()[1].status === 'failed');

    const stopped = connected(); await settle();
    stopped.route('/v1/chat/completions', opts => sse([delta({ content: 'cancelled partial' }), delta({ tool_result: { name: 'write_file', result: 'already written', status: 'completed' } })], opts, true));
    stopped.ids.ta.value = 'cancel this'; stopped.hook.send();
    await until(() => stopped.hook.history()[1].content === 'cancelled partial' && stopped.hook.activities().length === 1, 'cancelled content visible');
    stopped.ids.stop.fire('click');
    await until(() => !stopped.hook.saveState().busy && !stopped.hook.saveState().dirty && stopped.hook.history()[1].status === 'cancelled', 'cancelled turn saved');
    saved = JSON.parse((await api('POST', '/api/sessions/load', { file: stopped.hook.session() })).body);
    check('stopping preserves partial reply and already completed side effect', saved.messages[1].status === 'cancelled' && saved.messages[1].content === 'cancelled partial' && saved.activities[0].result === 'already written');
    const eof = connected(); await settle(); eof.route('/v1/chat/completions', opts => sse([delta({ content: 'incomplete' })], opts)); eof.ids.ta.value = 'abrupt EOF'; eof.hook.send();
    await until(() => !eof.hook.saveState().busy && !eof.hook.saveState().dirty && eof.hook.history()[1].status === 'failed', 'EOF failure saved');
    check('EOF without DONE cannot be persisted as a successful complete reply', eof.hook.history()[1].content === 'incomplete' && eof.hook.history()[1].error.includes('提前结束'));

    let r = await api('POST', '/api/sessions/save', { messages: [{ role: 'user', content: '中'.repeat(450000) }] }); const largeName = JSON.parse(r.body).file;
    check('real save accepts Unicode session between old 1MiB and consistent 2MiB limit', r.status === 200 && !!largeName);
    r = await api('POST', '/api/sessions/save', { file: largeName, messages: [{ role: 'user', content: '中'.repeat(750000) }] });
    saved = JSON.parse((await api('POST', '/api/sessions/load', { file: largeName })).body);
    check('oversized UTF-8 save returns 413 and preserves the complete previous file', r.status === 413 && saved.messages[0].content.length === 450000);
    r = await api('POST', '/api/sessions/save', { file: largeName, messages: [], activities: Array.from({ length: 2001 }, () => ({ type: 'tool_result' })) });
    check('activity overflow is explicit rather than silently dropping prior turns', r.status === 400 && JSON.parse((await api('POST', '/api/sessions/load', { file: largeName })).body).messages[0].content.length === 450000);
    const src = fs.readFileSync(S.IDX, 'utf8'), start = src.indexOf('function conversationFromClient('), end = src.indexOf('// ====================== HTTP SERVER', start);
    const model = vm.createContext({ systemPrompt: 'fixture', buildTaskUserContent: s => s }); vm.runInContext(src.slice(start, end), model);
    check('next model context marks restored partial/failed assistant as incomplete', model.conversationFromClient([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', status: 'cancelled' }])[2].content.includes('tool side effects may already exist'));
    const context = loadContext(src, S.freshCwd('cli-byte-cap'), {}, { Buffer, require, appDir: path.dirname(S.IDX), messages: [{ role: 'system', content: 'fixture' }, { role: 'user', content: '中'.repeat(750000) }], console: { warn() {} } });
    vm.runInContext(src.slice(src.indexOf('function sessionFilePath()'), src.indexOf('async function summarizeAction(')), context); context.saveSession();
    check('CLI save applies the same UTF-8 byte capacity without creating an oversized file', !fs.existsSync(context.sessionFilePath()));
    console.log('SESSION/CONTINUITY ' + checks + '/' + checks);
  } finally { clearTimeout(deadline); S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
