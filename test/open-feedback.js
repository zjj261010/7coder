const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), { EventEmitter } = require('events');
const { loadContext } = require('./download-commit'), { harness, settle } = require('./webui-ui-sim');
const S = require('./_shared').create({ suite: 'open-feedback' }), source = fs.readFileSync(S.IDX, 'utf8'); let checks = 0;
const deadline = setTimeout(() => { console.error('OPEN/FEEDBACK deadline'); S.cleanup(); process.exit(1); }, 35000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(name, spawn, timers) {
  const cwd = S.freshCwd(name), audits = [], pending = [], c = loadContext(source, cwd, {}, { Buffer, appDir: path.dirname(S.IDX), child_process: { spawn },
    console: { warn() {} }, audit: e => audits.push(e), BODY_LIMIT_DEFAULT: 1024, configPathForOpen: () => path.join(cwd, '.env'),
    readJsonBody(req, res, max, action) { pending.push(Promise.resolve(action(JSON.stringify(req.body)))); } });
  if (timers) Object.assign(c, timers);
  vm.runInContext(cut('// Bounded operating diagnostics:', '// No-key is a valid setup') + cut('function launchDesktopPath(', 'function replDraftByteLimit(') + cut('  function hOpen(req, res)', '  function hSettingsGet('), c);
  return { c, cwd, audits, pending };
}
function fake(name, options = {}) {
  const children = [], calls = [], timers = new Map(); let timerId = 0;
  const f = context(name, (file, argv, opts) => {
    calls.push({ file, argv, opts }); if (options.throw) throw options.throw;
    const child = new EventEmitter(); Object.assign(child, { pid: options.noPid ? undefined : 12345, exitCode: null, signalCode: null, killed: false, killCalls: 0, unrefs: 0,
      unref() { this.unrefs++; }, kill() { this.killCalls++; if (options.killThrows) throw Error('fixture stop refused'); if (options.killFalse) return false; this.killed = true; return true; } });
    children.push(child); return child;
  }, { setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  Object.assign(f, { children, calls, timers, expire() { for (const timer of Array.from(timers.values())) timer.fn(); },
    close(child, code = 0, signal = null) { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); child.emit('close', code, signal); } }); return f;
}
function response() { return { status: null, ends: 0, writableEnded: false, destroyed: false, writeHead(code) { this.status = code; }, end(body) { this.ends++; this.body = JSON.parse(body); this.writableEnded = true; } }; }
const lastToast = h => h.ids['toast-area'].lastChild;
async function until(predicate) { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw Error('Owned child close unconfirmed'); await new Promise(r => setTimeout(r, 5)); } }
(async () => { try {
  let f = fake('wait-close'), done = false, p = f.c.launchDesktopPath('D:\\中文 空格\\.env', 'config').then(r => { done = true; return r; }); const child = f.children[0];
  child.emit('exit', 0, null); await settle(); check('PID and exit alone do not report accepted before close; no spawn event is required', !done && f.c.launchDesktopPath.active.size === 1);
  f.close(child); let result = await p; check('zero exit plus close produces accepted and clears the owned deadline/slot', result.status === 'accepted' && result.exitCode === 0 && f.timers.size === 0 && f.c.launchDesktopPath.active.size === 0);
  check('launcher argv retains literal Unicode/spaces and is hidden with ignored stdio', f.calls[0].argv[f.calls[0].argv.length - 1] === 'D:\\中文 空格\\.env' && f.calls[0].opts.windowsHide && f.calls[0].opts.stdio === 'ignore');
  f = fake('nonzero'); p = f.c.launchDesktopPath(f.cwd, 'workspace'); f.close(f.children[0], 7); result = await p;
  check('nonzero close reports failure with code and diagnostic metadata', result.status === 'error' && result.exitCode === 7 && f.c.runtimeSnapshot().lastError.exitCode === 7);
  f = fake('signal'); p = f.c.launchDesktopPath(f.cwd, 'workspace'); f.close(f.children[0], null, 'SIGTERM'); result = await p; check('signal termination cannot be accepted as a successful opening', result.status === 'error' && result.signal === 'SIGTERM');
  f = fake('missing', { noPid: true }); p = f.c.launchDesktopPath(f.cwd, 'workspace'); f.children[0].emit('error', Object.assign(Error('spawn missing token=FAKE_TOKEN'), { code: 'ENOENT' })); result = await p;
  check('Node13 async no-PID error settles without requiring close or retaining a timer/slot', result.status === 'error' && result.pid === null && result.error.code === 'ENOENT' && !result.error.message.includes('FAKE_TOKEN') && f.c.launchDesktopPath.active.size === 0 && f.timers.size === 0);
  f.children[0].emit('error', Error('late error')); check('late error remains handled after early failure', true);
  f = fake('throw', { throw: Object.assign(Error('invalid spawn'), { code: 'EINVAL' }) }); result = await f.c.launchDesktopPath(f.cwd, 'workspace'); check('synchronous spawn rejection is diagnosed without a retained slot', result.status === 'error' && result.error.code === 'EINVAL' && f.c.launchDesktopPath.active.size === 0);
  f = fake('capacity', { killFalse: true }); const queued = Array.from({ length: 4 }, () => f.c.launchDesktopPath(f.cwd, 'workspace')); f.expire(); const outcomes = await Promise.all(queued);
  result = await f.c.launchDesktopPath(f.cwd, 'workspace'); check('four timed-out unclosed launchers retain admission and fifth creates no process', outcomes.every(r => r.status === 'unknown' && r.error.code === 'OPEN_TIMEOUT') && f.children.every(c => c.killCalls === 1) && f.calls.length === 4 && result.status === 'busy' && f.timers.size === 0);
  for (const c of f.children) f.close(c, null, 'SIGTERM'); check('late close reconciles capacity and is recorded without changing the unknown response', f.c.launchDesktopPath.active.size === 0 && outcomes.every(r => r.status === 'unknown') && f.c.runtimeSnapshot().lastEvent.scope === 'open-launcher-close');
  f = fake('api-success'); let res = response(); f.c.hOpen({ body: { target: 'config' } }, res); check('original API handler waits for launcher completion', res.ends === 0 && f.calls.length === 1);
  f.close(f.children[0]); await Promise.all(f.pending); check('API success explicitly means accepted launcher request, not verified window state', res.status === 200 && res.body.ok && res.body.status === 'accepted' && res.body.path.endsWith('.env') && f.audits[0].status === 'accepted');
  for (const mode of ['error', 'timeout', 'busy']) {
    f = fake('api-' + mode, { noPid: mode === 'error', killFalse: true });
    if (mode === 'busy') for (let i = 0; i < 4; i++) f.c.launchDesktopPath(f.cwd, 'workspace');
    res = response(); f.c.hOpen({ body: { target: 'workspace' } }, res);
    if (mode === 'error') f.children[0].emit('error', Object.assign(Error('fixture no executable'), { code: 'ENOENT' }));
    if (mode === 'timeout') f.expire(); await Promise.all(f.pending);
    check('API ' + mode + ' returns one non-success response with matching audit state', res.status === ({ error: 500, timeout: 504, busy: 429 })[mode] && !res.body.ok && res.ends === 1 && f.audits[0].status === res.body.status);
    for (const c of f.children) f.close(c, null, 'SIGTERM'); check('late ' + mode + ' cleanup never writes a second HTTP response', res.ends === 1 && f.timers.size === 0);
  }
  f = fake('dry-invalid'); res = response(); f.c.hOpen({ body: { target: 'workspace', dry: true } }, res); await Promise.all(f.pending);
  check('dry request remains side-effect free', res.status === 200 && res.body.dry && f.calls.length === 0 && f.audits.length === 0);
  res = response(); f.c.hOpen({ body: { target: 'desktop' } }, res); await Promise.all(f.pending); check('invalid target still fails before spawn', res.status === 400 && f.calls.length === 0);
  f.c.configPathForOpen = () => { throw Object.assign(Error('template unavailable'), { code: 'EACCES' }); }; res = response(); f.c.hOpen({ body: { target: 'config' } }, res); await Promise.all(f.pending);
  check('configuration preparation failure remains an early error with no launcher', res.status === 400 && res.body.error.code === 'EACCES' && f.calls.length === 0);
  const script = path.join(S.runDir, 'owned-launcher.js'); fs.writeFileSync(script, 'if(process.argv[2]==="hang")setInterval(()=>{},1000);else process.exit(Number(process.argv[2]));');
  for (const mode of ['0', '7', 'hang', 'missing-cwd']) {
    let owned; const native = context('native-' + mode, () => { owned = S.spawn(S.NODE_BIN, [script, mode], { cwd: mode === 'missing-cwd' ? path.join(S.runDir, 'absent-cwd') : S.runDir, stdio: 'ignore', windowsHide: true }); return owned; });
    const actual = await native.c.launchDesktopPath(native.cwd, 'workspace', mode === 'hang' ? 100 : 3000); await until(() => native.c.launchDesktopPath.active.size === 0);
    check('actual owned Node13 launcher lifecycle ' + mode, actual.status === (mode === '0' ? 'accepted' : mode === 'hang' ? 'unknown' : 'error') && (mode !== '7' || actual.exitCode === 7));
  }
  let h = harness(); await settle(); let release;
  h.route('/api/open', () => new Promise(r => { release = r; })); h.ids.openWs.fire('click'); h.ids.openCfg.fire('click');
  check('UI allows one in-flight opening and disables both buttons', h.calls.filter(c => c.url === '/api/open').length === 1 && h.ids.openWs.disabled && h.ids.openCfg.disabled);
  release(h.response({ ok: true, status: 'accepted' })); await settle(); check('UI success confirms only the system launcher and releases its timer/buttons', /启动器已接受工作区/.test(lastToast(h).textContent) && !lastToast(h).textContent.includes('已打开') && !h.ids.openWs.disabled && !Array.from(h.timers).some(t => t.ms === 10000));
  for (const [label, body, status, expected] of [['config', { ok: true, status: 'accepted' }, 200, '启动器已接受配置文件'], ['failure', { error: { message: 'fixture executable missing' }, status: 'error' }, 500, '启动请求失败'], ['unknown', { error: { message: 'timeout' }, status: 'unknown' }, 504, '打开结果未确认'], ['legacy', { ok: true }, 200, '打开结果未确认']]) {
    h = harness(); await settle(); h.route('/api/open', () => h.response(body, status)); h.ids.openCfg.fire('click'); await settle(); check('UI ' + label + ' feedback does not claim an editor opened', lastToast(h).textContent.includes(expected) && !lastToast(h).textContent.includes('已打开') && !h.ids.openCfg.disabled);
  }
  h = harness(); await settle(); h.route('/api/open', opts => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => { const error = Error('fixture timeout'); error.name = 'AbortError'; reject(error); })));
  h.ids.openWs.fire('click'); const timeout = Array.from(h.timers).find(t => t.ms === 10000); timeout.fn(); await settle();
  check('UI network deadline reports unknown and unlocks without automatic retry', lastToast(h).textContent.includes('打开结果未确认：等待超时') && !h.ids.openWs.disabled && h.calls.filter(c => c.url === '/api/open').length === 1 && !Array.from(h.timers).some(t => t.ms === 10000));
  h = harness(); await settle(); h.route('/api/open', () => Promise.reject(TypeError('fixture connection lost'))); h.ids.openWs.fire('click'); await settle();
  check('UI network failure remains unknown rather than implying rollback', lastToast(h).textContent.includes('连接或响应异常') && !h.ids.openWs.disabled);
  console.log('OPEN/FEEDBACK ' + checks + '/' + checks + ' passed; SKIP 0; handler VM and owned Node children, no desktop app/browser opened');
} finally { clearTimeout(deadline); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
