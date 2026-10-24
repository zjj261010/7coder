const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { harness, settle } = require('./webui-ui-sim');
const S = require('./_shared').create({ suite: 'approval-lifecycle' }), source = fs.readFileSync(S.IDX, 'utf8');
const sockets = new Set(), clients = [];
let checks = 0, fixture;
const deadline = setTimeout(() => { console.error('APPROVAL/LIFECYCLE deadline'); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
async function until(test, label) { const end = Date.now() + 6000; while (!await test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 5)); } }
async function port() { const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const n = server.address().port; await new Promise(r => server.close(r)); return n; }
function policy() {
  const calls = [], questions = [], c = vm.createContext({ path, DANGER_MODE: false, PERMISSION_MODE: 'default', subAgentModeOverride: null, workflowStepDepth: 0,
    console: { log() {}, warn() {} }, isProtectedTarget: () => false, matchPermRule: () => null, isSuperDangerous: () => false,
    getToolMetadata: () => ({ risk: 'HIGH', explain: () => 'fixture' }), audit() {},
    askApproval: async question => { questions.push(question); return true; }, executeToolRaw: async (name, args) => { calls.push({ name, args }); return 'OK'; },
    makeToolResult: (status, text) => ({ status, text }), isAutoApprovalSafe: async () => ({ safe: true }) });
  vm.runInContext(cut('function effectivePermissionMode()', '// Runs a sub-agent:') + cut('async function safeExecuteToolInner(', '// ====================== APPROVAL'), c);
  c.invoke = (name, args) => c.safeExecuteToolInner({ function: { name, arguments: JSON.stringify(args) } }, [], null, () => false, {});
  c.change = value => { c.PERMISSION_MODE = value; c.effectivePermissionMode.revision = (c.effectivePermissionMode.revision || 0) + 1; };
  return { c, calls, questions };
}
async function uiApproval() {
  const h = harness(); await settle();
  h.route('/v1/chat/completions', opts => {
    let emitted = false;
    return { ok: true, body: { getReader() { return { read() {
      if (!emitted) { emitted = true; return Promise.resolve({ done: false, value: Buffer.from('data: ' + JSON.stringify({ approval_request: { id: 'owned-ui', question: 'Execute workflow?\nwrite target.txt then inspect it', permissionRevision: 0 } }) + '\n\n') }); }
      return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => { const e = Error('Stopped'); e.name = 'AbortError'; reject(e); }));
    } }; } } };
  });
  h.ids.ta.value = 'approval test'; h.hook.send(); await settle(); return h;
}
function streaming(p, prompt) {
  const approvals = [], chunks = [];
  const data = JSON.stringify({ stream: true, messages: [{ role: 'user', content: prompt }] });
  let req;
  const promise = new Promise((resolve, reject) => {
    req = http.request({ hostname: '127.0.0.1', port: p, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' } }, res => {
      res.setEncoding('utf8'); let pending = '';
      res.on('data', part => { chunks.push(part); pending += part; let at; while ((at = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, at); pending = pending.slice(at + 1); if (!line.startsWith('data:')) continue; try { const j = JSON.parse(line.slice(5)); if (j.approval_request) approvals.push(j.approval_request); } catch (e) {} } });
      res.on('end', () => resolve(chunks.join(''))); res.on('error', reject);
    }); req.on('error', reject); req.end(data);
  });
  clients.push(req); return { promise, approvals };
}
(async () => {
  try {
    let { c, calls, questions } = policy();
    c.askApproval = async () => { c.change('denial'); return true; };
    check('late approval after denial cannot dispatch', (await c.invoke('run_command', { command: 'fixture' })).status === 'blocked' && calls.length === 0);
    ({ c, calls } = policy()); c.askApproval = async () => { c.change('auto'); c.change('default'); return true; };
    check('mode change away and back still invalidates an old decision', (await c.invoke('run_command', { command: 'fixture' })).status === 'declined' && calls.length === 0);
    ({ c, calls } = policy()); c.PERMISSION_MODE = 'auto'; c.isAutoApprovalSafe = async () => { c.change('default'); return { safe: true }; };
    check('stale successful light-model verdict cannot execute in new mode', (await c.invoke('run_command', { command: 'fixture' })).status === 'declined' && calls.length === 0);
    ({ c, calls, questions } = policy()); c.getToolMetadata = () => ({}); c.classifyRisk = async () => { c.change('denial'); return 'HIGH'; };
    check('denial during risk classification never creates a new pending question', (await c.invoke('run_command', { command: 'fixture' })).status === 'blocked' && !questions.length && !calls.length);
    ({ c, calls, questions } = policy());
    const steps = [{ tool: 'run_command', args: { command: 'echo FIRST_VISIBLE' } }, { tool: 'write_file', args: { path: 'second.txt', content: 'SECOND_VISIBLE' } }];
    await c.invoke('workflow_tool', { steps });
    check('workflow approval contains actual nested command path and content', questions[0].includes('echo FIRST_VISIBLE') && questions[0].includes('second.txt') && questions[0].includes('SECOND_VISIBLE'));
    const count = questions.length; const oversized = await c.invoke('workflow_tool', { steps: [{ tool: 'write_file', args: { content: 'x'.repeat(70000) } }] });
    check('oversized workflow cannot inherit approval for hidden truncated steps', oversized.status === 'declined' && questions.length === count && calls.length === 1);
    c.subAgentModeOverride = 'auto'; c.PERMISSION_MODE = 'denial'; c.DANGER_MODE = true;
    check('global denial beats active sub-agent override and danger flag', c.effectivePermissionMode() === 'denial');
    c.PERMISSION_MODE = 'default'; check('danger flag exposes actual bypass and live configured changes', c.effectivePermissionMode() === 'bypass'); c.DANGER_MODE = false; c.PERMISSION_MODE = 'bypass'; check('sub-agent cannot retain an old override after live configuration changes', c.effectivePermissionMode() === 'bypass');

    let h = await uiApproval(), box = h.ids.log.querySelector('.approval-box'), acknowledge;
    h.route('/api/approve', () => new Promise(resolve => { acknowledge = resolve; }));
    box.querySelector('.approve').fire('click'); box.querySelector('.approve').fire('click');
    check('UI waits for server acknowledgment and suppresses duplicate clicks', !box.textContent.includes('已批准') && h.calls.filter(c => c.url === '/api/approve').length === 1);
    acknowledge(h.response({ ok: true, approved: true })); await settle();
    check('confirmed approval clears its timer and displays approved', box.textContent.includes('已批准') && h.intervals.size === 0);
    h.ids.stop.fire('click'); await settle();
    h = await uiApproval(); box = h.ids.log.querySelector('.approval-box');
    h.route('/api/approve', () => h.response({ error: { message: 'Unauthorized' } }, 401)); box.querySelector('.approve').fire('click'); await settle();
    check('401 cannot render approval success', !box.textContent.includes('已批准') && h.ids.log.textContent.includes('Unauthorized'));
    h.route('/api/approve', () => h.response({ error: { message: 'expired ID' } }, 400)); box.querySelector('.approve').fire('click'); await settle();
    check('400 expired approval remains a visible failure', !box.textContent.includes('已批准') && h.ids.log.textContent.includes('expired ID'));
    h.route('/api/approve', () => new Promise(resolve => { acknowledge = resolve; })); box.querySelector('.approve').fire('click');
    h.ids.stop.fire('click'); check('Stop immediately disposes approval countdown', h.intervals.size === 0);
    await settle(); h.ids.btnNew.fire('click'); acknowledge(h.response({ ok: true, approved: true })); await settle();
    check('late approval reply after Stop/new conversation cannot revive old UI', !box.textContent.includes('已批准') && h.hook.history().length === 0);
    h = await uiApproval(); box = h.ids.log.querySelector('.approval-box');
    h.route('/api/info', () => h.response({ mode: 'denial', permissionRevision: 1 })); await h.hook.refreshInfo();
    check('new permission revision invalidates old UI approval', h.intervals.size === 0 && box.querySelector('.approve').disabled);
    h.ids.stop.fire('click'); await settle();
    h = harness(); await settle(); h.route('/api/info', () => h.response({ mode: 'bypass', configuredMode: 'default', dangerMode: true, modeForced: true, permissionRevision: 3 })); await h.hook.refreshInfo();
    check('danger UI shows effective bypass and disables misleading normal choices', h.ids.modeChip.textContent.includes('--danger') && h.ids.modeSel.value === 'bypass' && h.ids.modeSel.querySelectorAll('option').find(o => o.value === 'default').disabled && !h.ids.modeSel.querySelectorAll('option').find(o => o.value === 'denial').disabled);
    h.route('/api/info', () => h.response({ mode: 'default', permissionRevision: 2 })); await h.hook.refreshInfo();
    check('older info response cannot undo a newer confirmed permission state', h.ids.modeSel.value === 'bypass');

    fixture = http.createServer((req, res) => {
      let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
        const body = JSON.parse(raw), text = body.messages.map(m => String(m.content || '')).join('\n');
        let data;
        if (!body.messages.some(m => m.role === 'tool')) {
          const denial = text.includes('APPROVAL_DENIAL');
          const name = denial ? 'write_file' : 'workflow_tool';
          const args = denial ? { path: 'denied.txt', content: 'MUST_NOT_WRITE' } : { steps: [{ tool: 'write_file', args: { path: 'approved.txt', content: 'APPROVED_CONTENT' } }, { tool: 'read_file', args: { path: 'approved.txt' } }] };
          data = { tool_calls: [{ index: 0, id: 'approval-fixture', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
        } else data = { content: 'APPROVAL_DONE' };
        res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: data, finish_reason: data.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      });
    });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(r => fixture.listen(0, '127.0.0.1', r));
    const p = await port(), cwd = S.freshCwd('real-approval');
    const child = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, { HTTP_PORT: String(p), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', PERMISSION_MODE: 'default', DREAM_ALLOW: 'false',
      OPENAI_ENDPOINT: 'http://127.0.0.1:' + fixture.address().port, OPENAI_API_KEY: '', HEAVY_MODEL: 'fixture', LIGHT_MODEL: '', SUMMARY_MODEL: '', MAX_RETRIES: '1' }) });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    const api = (url, body) => S.httpReq(p, body === undefined ? 'GET' : 'POST', url, body === undefined ? null : body);
    await until(async () => { if (child.exitCode != null) throw Error(output); try { return (await api('/api/info')).status === 200; } catch (e) { if (e.code !== 'ECONNREFUSED') throw e; return false; } }, 'real server ready');
    let run = streaming(p, 'APPROVAL_WORKFLOW'); await until(() => run.approvals.length === 1, 'real workflow approval');
    const prompt = run.approvals[0];
    check('real SSE approval previews actual workflow before any write', prompt.question.includes('approved.txt') && prompt.question.includes('APPROVED_CONTENT') && !fs.existsSync(path.join(cwd, 'approved.txt')) && prompt.permissionRevision === 0);
    const accepted = await api('/api/approve', { id: prompt.id, approved: true }), reply = await run.promise;
    check('real acknowledged workflow inherits exact reviewed plan and completes', JSON.parse(accepted.body).approved === true && reply.includes('APPROVAL_DONE') && fs.readFileSync(path.join(cwd, 'approved.txt'), 'utf8') === 'APPROVED_CONTENT' && run.approvals.length === 1);
    run = streaming(p, 'APPROVAL_DENIAL'); await until(() => run.approvals.length === 1, 'real pending denial');
    const revoked = run.approvals[0]; await api('/api/mode', { mode: 'denial' }); await run.promise;
    const late = await api('/api/approve', { id: revoked.id, approved: true });
    check('real denial revokes pending approval, refuses late approval and never writes', late.status === 400 && !fs.existsSync(path.join(cwd, 'denied.txt')) && JSON.parse((await api('/api/info')).body).mode === 'denial');
    console.log('APPROVAL/LIFECYCLE ' + checks + '/' + checks);
  } finally { clearTimeout(deadline); for (const req of clients) req.destroy(); S.cleanup(); for (const socket of sockets) socket.destroy(); if (fixture) await new Promise(r => fixture.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
