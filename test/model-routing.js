// T22-11: immutable route snapshots + real backend against two strict models.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const S = require('./_shared').create({ suite: 'model-routing' });
const source = fs.readFileSync(S.IDX, 'utf8');
const servers = [], sockets = new Set(), logs = [], seen = new Set();
let checks = 0, holdJob = null, releaseHeld = null;
const deadline = setTimeout(() => { console.error('MODEL/ROUTING suite deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundary: ' + from);
  return source.slice(start, end);
}
async function until(predicate, label) {
  const end = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() > end) throw Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('request deadline')), 10000); })]); }
  finally { clearTimeout(timer); }
}
function respond(res, body, message) {
  if (body.stream) {
    const delta = Object.assign({}, message);
    if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((t, index) => Object.assign({ index }, t));
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant' }, message) }] }));
  }
}
function roleOf(body) {
  const prompt = String(body.messages[0].content);
  if (body.tools) return prompt.includes('running as a SUB-AGENT') ? 'subagent' : 'main';
  if (prompt.startsWith('Classify risk')) return 'risk';
  if (prompt.startsWith('Is this tool action safe')) return 'approval';
  if (prompt.startsWith('Summarize this coding conversation')) return 'compression';
  if (prompt.startsWith('Create a short, concise summary')) return 'summary';
  if (prompt.startsWith('Generate a JSON object')) return 'synthetic';
  if (prompt.includes('LIGHT model in PLAN MODE')) return 'plan';
  return 'other';
}
async function modelServer(name) {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d);
    req.on('end', () => {
      try {
        const body = JSON.parse(raw), role = roleOf(body);
        const all = body.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
        const matches = all.match(/ROUTE_[A-Z_]+/g), job = matches ? matches[matches.length - 1] : '';
        const good = body.model === name && req.headers.authorization === 'Bearer fixture-key-' + name;
        logs.push({ endpoint: name, model: body.model, role, job, good });
        if (!good) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'model or credential belongs to another endpoint' } })); return; }
        const send = () => {
          let message;
          if (role === 'risk') message = { content: 'LOW' };
          else if (role === 'approval') message = { content: '{"safe":true,"reason":"local fixture"}' };
          else if (role === 'compression') message = { content: 'Earlier fixture turns summarized.' };
          else if (role === 'summary') message = { content: 'Completed ' + job };
          else if (role === 'plan') message = { content: '{"improved_prompt":"fixture plan","refinement_loops":1}' };
          else if (role === 'synthetic') message = { content: '{"ok":true}' };
          else if (role === 'subagent') message = { content: 'SUB_AGENT_OK ' + job };
          else if (role === 'main') {
            const key = name + ':' + job;
            if (seen.has(key)) message = { content: 'FINAL ' + job + ' ' + 'completed fixture operation. '.repeat(12) };
            else {
              seen.add(key);
              const jobs = [
                ['agent_tool', { name: 'direct', task: 'SUB_DIRECT ' + job }],
                ['workflow_tool', { steps: [
                  { tool: 'agent_tool', args: { name: 'workflow-agent', task: 'SUB_WORKFLOW ' + job } },
                  { tool: 'plan_mode', args: { initial_task: 'PLAN ' + job } },
                  { tool: 'write_file', args: { path: 'workflow.txt', content: 'WORKFLOW_OK' } }
                ] }],
                ['write_file', { path: 'main.txt', content: 'MAIN_OK' }],
                ['synthetic_output_tool', { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, prompt: 'SYNTHETIC ' + job }]
              ];
              message = { content: '', tool_calls: jobs.map(([tool, args], i) => ({ id: job + '-' + i, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } })) };
            }
          } else message = { content: 'fixture explanation' };
          respond(res, body, message);
        };
        if (role === 'main' && job === holdJob && !releaseHeld) releaseHeld = send;
        else send();
      } catch (e) { res.statusCode = 500; res.end(String(e)); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return 'http://127.0.0.1:' + server.address().port + '/v1';
}
async function backend(name, endpoints, light, summary) {
  const cwd = S.freshCwd(name), stateDir = path.join(cwd, '.7coder'); fs.mkdirSync(stateDir);
  const profiles = { A: { endpoint: endpoints.A, apiKey: 'fixture-key-A' }, B: { endpoint: endpoints.B, apiKey: 'fixture-key-B' } };
  fs.writeFileSync(path.join(stateDir, 'models.json'), JSON.stringify(profiles));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = S.spawn(S.NODE_BIN, [S.IDX, '--server'], { cwd, env: Object.assign({}, process.env, {
    HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1', HTTP_API_KEY: '', HEAVY_MODEL: 'A', LIGHT_MODEL: light,
    SUMMARY_MODEL: summary, OPENAI_ENDPOINT: endpoints.A, OPENAI_API_KEY: 'fixture-key-A',
    PERMISSION_MODE: 'auto', MAX_RETRIES: '1', CONTEXT_CHARS: '18000', DREAM_ALLOW: 'false'
  }) });
  let output = '';
  child.stdout.on('data', data => output += data.toString());
  child.stderr.on('data', data => output += data.toString());
  await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('backend exited before ready: ' + output);
    try { return (await S.httpReq(port, 'GET', '/api/info', null)).status === 200; }
    catch (e) { if (e.code !== 'ECONNREFUSED' && e.code !== 'ECONNRESET') throw e; return false; }
  }, 'backend ready');
  return { cwd, port, child, profiles, api: (method, url, data = null) => bounded(S.httpReq(port, method, url, data)) };
}
function chatBody(job, model, stream) {
  const body = { stream, messages: [
    { role: 'user', content: 'Old request ' + 'x'.repeat(24000) },
    { role: 'assistant', content: 'Old result ' + 'y'.repeat(300) },
    { role: 'user', content: job }
  ] };
  if (model) body.model = model;
  return body;
}
async function chat(app, job, model, stream, light, summary) {
  const start = logs.length;
  const result = await app.api('POST', '/v1/chat/completions', chatBody(job, model, stream));
  check(job + ': real chat completes without tool errors', result.status === 200 && result.body.includes('FINAL ' + job) && !result.body.includes('"error"'));
  await until(() => logs.slice(start).some(l => l.role === 'summary' && l.job === job), 'action summary ' + job);
  const calls = logs.slice(start);
  const main = model || JSON.parse((await app.api('GET', '/api/info')).body).model;
  const lightRoles = ['risk', 'approval', 'compression', 'plan'];
  check(job + ': main/subagent/synthetic use selected model and matching endpoint/key', calls.filter(l => ['main', 'subagent', 'synthetic'].includes(l.role)).every(l => l.model === main && l.good));
  check(job + ': default/explicit auxiliary models route correctly', calls.every(l => l.good && l.model === (l.role === 'summary' ? summary : lightRoles.includes(l.role) ? light : main)));
  check(job + ': compression/approval/plan/subagent/synthetic/summary were actually called', ['compression', 'approval', 'plan', 'subagent', 'synthetic', 'summary'].every(role => calls.some(l => l.role === role)));
  check(job + ': direct and workflow delegates both inherit model', calls.filter(l => l.role === 'subagent').length === 2 && fs.readFileSync(path.join(app.cwd, 'workflow.txt'), 'utf8') === 'WORKFLOW_OK' && fs.readFileSync(path.join(app.cwd, 'main.txt'), 'utf8') === 'MAIN_OK');
}
(async () => {
  try {
    const options = [], unit = { HEAVY_MODEL: 'A', LIGHT_MODEL: null, SUMMARY_MODEL: null, VISION_MODEL: null,
      OPENAI_ENDPOINT: 'http://old', OPENAI_API_KEY: 'fake-old', modelProfiles: {},
      callOpenAI: async (messages, opts) => { options.push(opts); return { message: { content: messages[0].content.startsWith('Is this') ? '{"safe":true}' : 'LOW' } }; } };
    vm.createContext(unit);
    vm.runInContext(cut('function resolveModelConfig(', 'function authHeadersFor(') +
      cut('async function classifyRisk(', '// ====================== STRUCTURED TASK STORE'), unit);
    const captured = unit.createModelContext('B');
    unit.OPENAI_ENDPOINT = 'http://new'; unit.OPENAI_API_KEY = 'fake-new'; unit.HEAVY_MODEL = 'C';
    check('immutable context preserves selected/default models and prior route', captured.main === 'B' && captured.light === 'B' && captured.summary === 'B' && captured.routes.b.endpoint === 'http://old' && captured.routes.b.apiKey === 'fake-old' && Object.isFrozen(captured) && Object.isFrozen(captured.routes.b));
    await unit.classifyRisk('fixture', {}, captured); await unit.getPermissionExplanation('fixture', {}, 'LOW', captured); await unit.isAutoApprovalSafe('fixture', {}, 'LOW', captured);
    check('risk/explanation/approval share the exact captured context', options.length === 3 && options.every(o => o.model === 'B' && o.modelContext === captured));
    unit.LIGHT_MODEL = 'A';
    check('explicit light overrides inheritance and default summary follows light', unit.createModelContext('B').light === 'A' && unit.createModelContext('B').summary === 'A');
    unit.SUMMARY_MODEL = 'B';
    check('explicit summary is independent of explicit light', unit.createModelContext('C').summary === 'B' && unit.createModelContext('C').light === 'A');

    const endpoints = { A: await modelServer('A'), B: await modelServer('B') };
    const inherited = await backend('inherit', endpoints, '', '');
    await chat(inherited, 'ROUTE_SELECTED', 'B', true, 'B', 'B');
    check('request-selected B does not mutate configured default A', JSON.parse((await inherited.api('GET', '/api/info')).body).model === 'A');
    check('settings hot switch persists successfully', (await inherited.api('POST', '/api/settings', { model: 'B', endpoint: endpoints.B, apiKey: 'fixture-key-B' })).status === 200);
    const info = JSON.parse((await inherited.api('GET', '/api/info')).body);
    check('info reflects dynamic default light and summary after hot switch', info.model === 'B' && info.light === 'B' && info.summary === 'B');
    await chat(inherited, 'ROUTE_SWITCHED', null, false, 'B', 'B');

    holdJob = 'ROUTE_HELD'; releaseHeld = null;
    const heldStart = logs.length;
    const heldRequest = inherited.api('POST', '/v1/chat/completions', chatBody(holdJob, 'B', true));
    await until(() => !!releaseHeld, 'held upstream main call');
    check('settings can change while request is in flight', (await inherited.api('POST', '/api/settings', { model: 'A', endpoint: endpoints.A, apiKey: 'fixture-key-A' })).status === 200);
    const changedProfiles = Object.assign({}, inherited.profiles, { B: { endpoint: endpoints.A, apiKey: 'fixture-key-A' } });
    check('profile can change while request is in flight', (await inherited.api('POST', '/api/models-config', { profiles: changedProfiles })).status === 200);
    releaseHeld();
    const heldResult = await heldRequest;
    check('in-flight request survives profile replacement without switching endpoint', heldResult.body.includes('FINAL ROUTE_HELD') && !heldResult.body.includes('"error"'));
    await until(() => logs.slice(heldStart).some(l => l.role === 'summary' && l.job === 'ROUTE_HELD'), 'held summary');
    check('all held-request model/approval/summary calls retain B route and credentials', logs.slice(heldStart).every(l => l.good && l.model === 'B' && l.endpoint === 'B'));
    holdJob = null;
    await chat(inherited, 'ROUTE_NEXT', null, true, 'A', 'A');

    const explicit = await backend('explicit', endpoints, 'A', 'B');
    const explicitInfo = JSON.parse((await explicit.api('GET', '/api/info')).body);
    check('info exposes explicit light/summary defaults', explicitInfo.model === 'A' && explicitInfo.light === 'A' && explicitInfo.summary === 'B');
    await chat(explicit, 'ROUTE_EXPLICIT', 'B', true, 'A', 'B');
    check('strict endpoints received no foreign model or credential', logs.length > 0 && logs.every(l => l.good));
    console.log('MODEL/ROUTING: ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline); S.cleanup();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
